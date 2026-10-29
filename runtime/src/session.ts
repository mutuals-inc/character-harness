// One app connection: a single WebSocket for the whole conversation, with
// everything multiplexed over it:
//
//   app -> runtime
//     text  {t:"stt_start",utterance?} | {t:"stt_eos",utterance?} | {t:"stt_reset"}
//           {t:"llm",id,history,source?} | {t:"tts",id,text} | {t:"cancel",id}
//     bin   PCM16 16 kHz mic frames
//   runtime -> app
//     text  {t:"mode",text,v} | {t:"stt_partial"|"stt_final",text,utterance?}
//           {t:"llm_delta",id,text} | {t:"llm_calls",id,entries}
//           {t:"llm_done",id,entries?} | {t:"tts_done",id}
//           {t:"beat",id,bt,emotion,talk,gesture,camera} | {t:"emotion",id,emotion}
//           {t:"error",id,text}
//     bin   [id:u8][PCM16 24 kHz]  TTS audio, tagged so concurrent sentences demux
//
// The app owns the conversation: it sends the whole history with each `llm`,
// splits the reply into sentences, and asks for each one's audio with `tts`.
// So a turn here is one `llm` request and the `tts` requests that follow it,
// and the hooks fire on those messages:
//
//   on_session_start  the socket opens
//   before_reply      an `llm` arrives; runs alongside before_llm and the model
//   before_llm        an `llm` arrives; can change `prompt` and `messages`
//   after_llm         the reply has finished streaming
//   on_sentence       a `tts` arrives, while its audio is synthesized; the
//                     beats it returns are timed to the audio and sent as
//                     `beat` (or `emotion`) messages
//   on_speak          a sentence's audio and timing are complete
//   after_turn        the next `llm` arrives, the socket closes, or the reply
//                     and its sentences are done and nothing new came for a moment
//   on_session_end    the socket closes
//
// Beside the hooks, every extension with a `service` runs it from just after
// on_session_start until the session ends. A service may start a turn by
// offering the player a line of input over the offers link (offers.ts).

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { printable } from "./check.ts";
import { hasHook, runHook, runTool } from "./extensions.ts";
import type { Loaded, ServiceContext } from "./extensions.ts";
import { LlmHttpError, LlmStreamError, streamChat } from "./llm.ts";
import { ELEVENLABS_KEY, toolProblem } from "./manifest.ts";
import type { Character } from "./manifest.ts";
import { STATE_SCHEMA } from "./state.ts";
import type { Beat, Message, State, Timing, Tool, ToolCall, ToolChoice, ToolResult } from "./state.ts";
import { SttRelay } from "./stt.ts";
import { Heard } from "./utterances.ts";
import { Tts } from "./tts.ts";
import { Alignment } from "./align.ts";
import { Leveler } from "./level.ts";
import { ACTED_TURN, SILENT_TURN } from "./markers.ts";
import { Offers, pendingResultText } from "./offers.ts";
import type { LinkHub } from "./offers.ts";
import type { AlignmentChunk } from "./align.ts";

const PROTOCOL_VERSION = 1;

// How long a finished reply waits for more sentences before after_turn fires.
// The app sends a sentence's `tts` as a playback slot frees up, so most of a
// reply's sentences arrive after its `llm_done`.
const TURN_IDLE_MS = 1500;

// The app runs one reply at a time and voices a few sentences ahead; past
// these, a request is refused rather than spent.
const MAX_LLM_IN_FLIGHT = 2;
const MAX_TTS_IN_FLIGHT = 8;

// With tools offered, a model that answered its silent reply is read on for its
// calls, but stopped once it has written this much more text instead.
const SILENT_TAIL_CHARS = 200;

// How many times one turn may ask the model: a call whose result the model
// reads asks it again. The last time it may call none.
const MAX_ROUNDS = 4;

// A service that fails is started again after a wait that doubles from the
// first to the last; one that ran this long before failing starts over at the first.
const SERVICE_RETRY_MS = [1000, 30_000] as const;
const SERVICE_HEALTHY_MS = 60_000;
// how long the session waits for its services to stop before on_session_end
const SERVICE_STOP_MS = 2000;

interface Turn {
	id: number;
	state: State;
	llmDone: boolean;
	ttsInFlight: number;
	firstSentence: boolean; // its first `tts` has not arrived yet
	closed: boolean;
	idle: ReturnType<typeof setTimeout> | undefined;
	// the calls running now; after_turn waits for them, so it sees each one that ran
	running?: Promise<unknown>;
	answered: boolean; // its `llm_done` or `error` has gone out
}

// what the app gets for a reply the runtime itself failed on
const RUNTIME_FAILED = "runtime_failed";

// what a call with no result in the history gets, since the APIs want one
const NO_RESULT = "No result.";
// what the model gets for a call whose tool answered nothing, and for one
// whose result comes later
const DONE_RESULT = "Done.";
const PENDING_RESULT = "Started. The result will come later.";

function toCalls(calls: unknown): ToolCall[] {
	if (!Array.isArray(calls)) return [];
	return calls
		.filter((c): c is ToolCall => typeof c?.id === "string" && c.id !== "" && typeof c?.name === "string" && typeof c?.arguments === "string")
		.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
}

function toMessages(history: unknown): Message[] {
	if (!Array.isArray(history)) return [];
	const ms: Message[] = [];
	for (const h of history) {
		// an assistant message that only calls tools may have no content, as
		// Chat Completions writes it
		const calls = h?.role === "assistant" ? toCalls(h.tool_calls) : [];
		if (calls.length && (h.content === null || h.content === undefined)) {
			ms.push({ role: "assistant", content: "", tool_calls: calls });
			continue;
		}
		// the system prompt is the character's; the app only sends the conversation
		if (typeof h?.content !== "string") continue;
		// the app's `interrupted` marker is not for the model
		if (h.role === "user") ms.push({ role: "user", content: h.content });
		else if (h.role === "assistant") {
			ms.push(calls.length ? { role: "assistant", content: h.content, tool_calls: calls } : { role: "assistant", content: h.content });
		} else if (h.role === "tool" && typeof h.tool_call_id === "string") ms.push({ role: "tool", content: h.content, tool_call_id: h.tool_call_id });
	}
	return paired(ms);
}

// The APIs want each call's result right after the message that made it, and
// no result without its call. The history is put this way when it arrives,
// and again after before_llm, which may have cut or changed `messages`.
function paired(ms: Message[]): Message[] {
	const out: Message[] = [];
	for (let i = 0; i < ms.length; i++) {
		const m = ms[i];
		if (m.role === "tool") continue;
		out.push(m);
		if (!m.tool_calls) continue;
		const results = new Map<string, Message>();
		while (ms[i + 1]?.role === "tool") {
			const r = ms[++i];
			if (!results.has(r.tool_call_id!)) results.set(r.tool_call_id!, r);
		}
		for (const c of m.tool_calls) out.push(results.get(c.id) ?? { role: "tool", tool_call_id: c.id, content: NO_RESULT });
	}
	return out;
}

// The tools of a turn, as the model gets them: each one toolProblem passes,
// and each name once, the first one listed. `warn` is told what was left out.
// Each keeps `by`, the extension the runtime marked as having added it.
function toTools(tools: unknown, warn: (line: string) => void): { tool: Tool; by?: string }[] {
	if (!Array.isArray(tools)) return [];
	const out: { tool: Tool; by?: string }[] = [];
	for (const t of tools) {
		if (!t || typeof t !== "object") continue;
		const { name, description, parameters, by } = t as Tool;
		const problem = toolProblem(t as Tool);
		if (problem) {
			warn(`tool ${JSON.stringify(name ?? null)} was left out: its ${problem[0]} ${problem[1]}`);
			continue;
		}
		if (out.some((o) => o.tool.name === name)) {
			warn(`tool ${name} is listed twice; the first one was kept`);
			continue;
		}
		const tool = { name, ...(typeof description === "string" ? { description } : {}), ...(parameters ? { parameters } : {}) };
		out.push(typeof by === "string" ? { tool, by } : { tool });
	}
	return out;
}

// `v` with every object's keys in order, so two values that differ only in
// that order write the same JSON. Arrays keep theirs: it means something.
function sortedKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortedKeys);
	if (!v || typeof v !== "object") return v;
	const o = v as Record<string, unknown>;
	return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortedKeys(o[k])]));
}

// Marks each tool in `s.tools` with the extension that added it: a tool `prev`
// already had, unchanged, keeps its owner, and any other is `by`'s, whatever
// `by` it came with. So an extension can't hand its calls to another one.
function claimTools(prev: unknown, s: State, by: string): State {
	if (!Array.isArray(s.tools)) return s;
	// a tool is the same one when everything but its `by` is, whatever order
	// its keys are in: a hook that decodes and encodes the state again (a Go
	// map, say) may sort them
	const key = (t: Tool) => {
		const { by: _, ...rest } = t;
		try {
			return JSON.stringify(sortedKeys(rest));
		} catch {
			return ""; // matches nothing, so it is `by`'s
		}
	};
	const isTool = (t: unknown): t is Tool => typeof t === "object" && t !== null;
	const owners = new Map<string, string[]>();
	for (const t of Array.isArray(prev) ? prev : []) {
		const k = isTool(t) ? key(t) : "";
		if (k && typeof t.by === "string") owners.set(k, [...(owners.get(k) ?? []), t.by]);
	}
	const tools = s.tools.map((t) => (isTool(t) ? { ...t, by: owners.get(key(t))?.shift() ?? by } : t));
	return { ...s, tools };
}

const resultText = (r: ToolResult | undefined) =>
	r === undefined ? DONE_RESULT : "content" in r ? r.content : "error" in r ? `Error: ${r.error}` : PENDING_RESULT;

// The turn's tool_choice. One naming a tool the model isn't sent would have
// the request refused, so it falls back to the default, and `warn` is told.
function toChoice(c: unknown, tools: Tool[], warn: (line: string) => void): ToolChoice | undefined {
	if (c === "auto" || c === "required" || c === "none") return c;
	const name = (c as { name?: unknown } | null)?.name;
	if (typeof name !== "string") return undefined;
	if (tools.some((t) => t.name === name)) return { name };
	warn(`tool_choice names ${JSON.stringify(name)}, which isn't one of the turn's tools; the model may call any`);
	return undefined;
}

// One sentence while it is spoken: its voice timing so far, and the beats
// extensions handed back for it, waiting until their span is voiced.
interface Spoken {
	id: number;
	align: Alignment;
	line: string; // the sentence without its [tags], for placing an unvoiced span
	pending: Beat[];
	searchAt: number; // beats resolve in order, so a repeated phrase can't match backwards
	ended: boolean;
	cancelled: boolean;
}

// removes the listed [tags] from a sentence; the rest of it is left as written
function dropTags(text: string, tags: string[]): string {
	if (!tags.length) return text;
	return text
		.replace(/\[([a-zA-Z][a-zA-Z-]*)\]\s*/g, (tag, word: string) => (tags.includes(word.toLowerCase()) ? "" : tag))
		.trim();
}

const stripTags = (text: string) => text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();

function isBeat(b: unknown): b is Beat {
	return typeof b === "object" && b !== null && typeof (b as Beat).span === "string";
}

function pushTiming(t: Timing, a: AlignmentChunk): void {
	const chars = a.characters ?? [];
	const st = a.character_start_times_seconds ?? [];
	const en = a.character_end_times_seconds ?? [];
	for (let i = 0; i < chars.length && i < st.length; i++) {
		t.characters.push(chars[i]);
		t.starts.push(st[i]);
		t.ends.push(en[i] ?? st[i]);
	}
}

// What a hook changed in its copy of `ext`: the keys it set (compared by
// value, since every hook works on a clone) and the ones it removed.
interface ExtChanges {
	set: Record<string, unknown>;
	removed: string[];
}
export function extChanges(before: State["ext"], after: State["ext"]): ExtChanges {
	const set: Record<string, unknown> = {};
	const removed: string[] = [];
	const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
	// a hook that handed back no `ext` changed none of it
	if (!after || typeof after !== "object") return { set, removed };
	const was = obj(before);
	const now = obj(after);
	// a value JSON can't write (a BigInt) counts as changed
	const same = (a: unknown, b: unknown) => {
		try {
			return JSON.stringify(a) === JSON.stringify(b);
		} catch {
			return false;
		}
	};
	for (const [k, v] of Object.entries(now)) if (!(k in was) || !same(v, was[k])) set[k] = v;
	for (const k of Object.keys(was)) if (!(k in now)) removed.push(k);
	return { set, removed };
}
export function applyExt(ext: State["ext"], c: ExtChanges): State["ext"] {
	const out = { ...ext, ...c.set };
	for (const k of c.removed) delete out[k];
	return out;
}

export function runSession(ws: WebSocket, character: Character, exts: Loaded[], hub?: LinkHub): void {
	const sessionId = randomUUID();
	// a log line can carry the character's and its providers' text
	const log = (line: string) => console.log(printable(`[${sessionId.slice(0, 8)}] ${line}`));
	const session: State["session"] = { id: sessionId, channel: "voice" };
	let closed = false;
	// extension data, carried from turn to turn for the whole session
	let ext: Record<string, unknown> = {};
	let turn: Turn | null = null;
	const llmStreams = new Map<number, AbortController>();
	// replies the app cancelled: nothing more may be sent for them. Kept by
	// request, not id, since the app may reuse the id while one winds down.
	const cancelledByApp = new WeakSet<AbortController>();
	const spoken = new Map<number, Spoken>();
	// what toTools left out, said once a session rather than every turn
	const warned = new Set<string>();
	const warnOnce = (line: string) => {
		if (warned.has(line)) return;
		warned.add(line);
		log(line);
	};

	const send = (obj: unknown) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
	};
	const sendAudio = (id: number, pcm: Buffer) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.concat([Buffer.from([id & 0xff]), pcm]));
	};
	const baseState = (): State => ({
		schema: STATE_SCHEMA,
		character: character.manifest,
		session: { ...session },
		ext,
	});
	// Hooks that overlap (sentences side by side, after_llm and after_turn next
	// to a newer turn) each started from a copy of `ext`, so only what a hook
	// changed in its copy is applied; the rest of its copy may be stale.
	const mergeExt = (t: Turn, before: State["ext"], s: State) => writeExt(t, extChanges(before, s.ext));
	// A closed turn has handed its `ext` on to the session and maybe a newer
	// turn, so a late write to it goes there too.
	const writeExt = (t: Turn, changes: ExtChanges) => {
		t.state.ext = applyExt(t.state.ext, changes);
		if (!t.closed) return;
		ext = applyExt(ext, changes);
		if (turn && turn !== t) turn.state.ext = applyExt(turn.state.ext, changes);
	};

	const offers = new Offers(hub, log);
	const services = new AbortController();
	const running: Promise<void>[] = [];

	const elevenKey = process.env[ELEVENLABS_KEY] ?? "";
	const heard = new Heard();
	const stt = new SttRelay(character.stt, elevenKey, send, { onFinal: (f) => heard.add(f) });
	const tts = new Tts(character.voice, elevenKey, (s) => log(`[tts] ${s}`));

	const closeTurn = async (t: Turn) => {
		if (t.closed) return;
		t.closed = true;
		clearTimeout(t.idle);
		ext = t.state.ext;
		// A turn cut off while its calls run (a newer `llm`, the socket closing)
		// still hands after_turn what they did. Tools write no `ext`, and each
		// has its timeout, so this waits only so long.
		await t.running?.catch(() => {});
		const before = t.state.ext;
		const s = await runHook(exts, "after_turn", t.state, log);
		const changes = extChanges(before, s.ext);
		ext = applyExt(ext, changes);
		// a turn that began while after_turn ran gets its writes too
		if (turn && turn !== t) turn.state.ext = applyExt(turn.state.ext, changes);
	};
	// after_turn waits for the reply and every sentence of it, then a moment more
	const settle = (t: Turn) => {
		if (t.closed || !t.llmDone || t.ttsInFlight > 0) return;
		clearTimeout(t.idle);
		t.idle = setTimeout(() => void closeTurn(t), TURN_IDLE_MS);
	};

	send({ t: "mode", text: "companion", v: PROTOCOL_VERSION });
	tts.open();
	log(`open: ${character.id}, chat ${character.chat.model}, voice ${character.voice.model} on ${tts.transport}`);
	const started = runHook(exts, "on_session_start", baseState(), log).then((s) => { ext = s.ext; });

	// A service's own `ext.<name>`, written whenever it likes: the session keeps
	// it and the open turn gets it, so the next hook sees it.
	const setOwnExt = (name: string, value: unknown) => {
		const changes = { set: { [name]: structuredClone(value) }, removed: [] };
		ext = applyExt(ext, changes);
		if (turn && !turn.closed) turn.state.ext = applyExt(turn.state.ext, changes);
	};
	const startService = (e: Loaded) => {
		// Each run gets its own signal and voice listeners, so a run that failed
		// leaves nothing behind beside the one that replaces it.
		const context = (run: AbortSignal, listening: Set<() => void>): ServiceContext => ({
			config: e.config,
			session: { id: session.id, channel: session.channel },
			signal: run,
			log: (line) => log(`[ext] ${e.name} service: ${line}`),
			ext: {
				// the open turn has what this extension's hooks wrote in it so far
				get: () => structuredClone((turn && !turn.closed ? turn.state.ext : ext)[e.name]),
				set: (value) => {
					if (!closed && !run.aborted) setOwnExt(e.name, value);
				},
			},
			offer: (req) => offers.offer(req, e.name),
			// an `req` that isn't a valid offer rejects, like any other failure here
			result: async (call, content, req) => offers.offer({ ...req, text: pendingResultText(call.name, content), source: "tool" }, e.name),
			voice: {
				get state() {
					return offers.voice;
				},
				get since() {
					return offers.since;
				},
				on: (fn) => {
					const off = offers.onVoice(fn);
					listening.add(off);
					return () => { off(); listening.delete(off); };
				},
			},
		});
		const loop = async () => {
			let wait: number = SERVICE_RETRY_MS[0];
			while (!services.signal.aborted) {
				const began = Date.now();
				const run = new AbortController();
				const stop = () => run.abort();
				services.signal.addEventListener("abort", stop, { once: true });
				const listening = new Set<() => void>();
				try {
					await e.run!(context(run.signal, listening));
					return; // a service that returns has nothing more to do
				} catch (err) {
					if (services.signal.aborted) return;
					if (Date.now() - began > SERVICE_HEALTHY_MS) wait = SERVICE_RETRY_MS[0];
					log(`[ext] ${e.name} service failed: ${err instanceof Error ? err.message : String(err)}; starting it again in ${wait / 1000}s`);
				} finally {
					run.abort();
					services.signal.removeEventListener("abort", stop);
					for (const off of listening) off();
				}
				await new Promise<void>((r) => {
					const stop = () => { clearTimeout(timer); r(); };
					const timer = setTimeout(() => { services.signal.removeEventListener("abort", stop); r(); }, wait);
					services.signal.addEventListener("abort", stop, { once: true });
				});
				wait = Math.min(wait * 2, SERVICE_RETRY_MS[1]);
			}
		};
		running.push(loop());
	};
	void started.then(() => {
		if (closed) return;
		for (const e of exts) if (e.run) startService(e);
	});

	const onLlm = async (id: number, history: unknown, source: unknown) => {
		// registered at once, so a cancel or the in-flight limit sees it
		const ac = new AbortController();
		llmStreams.set(id, ac);
		await started;
		// cancelled before the session was ready: it never became a turn
		if (cancelledByApp.has(ac)) {
			if (llmStreams.get(id) === ac) llmStreams.delete(id);
			return;
		}
		if (turn) void closeTurn(turn);
		let t: Turn | undefined;
		try {
			t = newTurn(id, history, source);
			await reply(t, ac);
		} catch (err) {
			// A bug, or a hook that handed back what the runtime can't read: the
			// turn still ends, so the app isn't left waiting on it.
			log(`turn ${id}: the runtime failed: ${err instanceof Error ? err.message : String(err)}`);
			ac.abort();
			if (llmStreams.get(id) === ac) llmStreams.delete(id);
			if (!closed && !cancelledByApp.has(ac) && !t?.answered) send({ t: "error", id, text: RUNTIME_FAILED });
			if (!t || t.llmDone) return;
			if (!t.answered) t.state.error ??= RUNTIME_FAILED;
			t.answered = true;
			t.llmDone = true;
			settle(t);
		}
	};

	// The turn an `llm` starts, and the open one from now on
	const newTurn = (id: number, history: unknown, source: unknown): Turn => {
		const messages = toMessages(history);
		const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
		// a turn the player took from an offer names the offer's source
		const offered = offers.take(lastUser);
		const channel = offered ? offered.source : source === "chat" || source === "screen" ? source : "voice";
		const input: NonNullable<State["input"]> = { text: lastUser, channel };
		if (offered) input.offered_by = offered.by;
		const utterances = channel === "voice" ? heard.match(lastUser) : undefined;
		if (utterances) input.utterances = utterances;
		const t: Turn = {
			id,
			state: { ...baseState(), turn: id, input, messages, prompt: character.prompt },
			llmDone: false,
			ttsInFlight: 0,
			firstSentence: true,
			closed: false,
			idle: undefined,
			answered: false,
		};
		turn = t;
		return t;
	};

	const reply = async (t: Turn, ac: AbortController) => {
		const id = t.id;
		// what this turn adds to the conversation when it calls tools: each
		// round's text and calls, their results, and the last round's text
		const entries: Message[] = [];
		const calls: ToolCall[] = [];
		const ranks: number[] = []; // each of `calls`, its place among its round's
		const finish = (how: string) => {
			// the app may have reused the id for a newer reply
			if (llmStreams.get(id) === ac) llmStreams.delete(id);
			t.llmDone = true;
			log(`turn ${id}: ${how}`);
			settle(t);
		};
		const silent = () => {
			t.state.cancel = true;
			t.answered = true;
			send({ t: "llm_delta", id, text: SILENT_TURN });
			// it ran no call: before_llm cancelled before any, or before_reply did
			send({ t: "llm_done", id });
			finish("cancelled, nothing spoken");
		};

		// before_reply works on its own copy; only its `cancel` is kept
		const replyCancelled = hasHook(exts, "before_reply")
			? runHook(exts, "before_reply", t.state, log).then((s) => s.cancel === true)
			: Promise.resolve(false);

		// a service may write its ext while before_llm runs on a copy
		const beforeLlm = t.state.ext;
		// every tool is marked with the extension that added it, so its calls
		// go to that one's on_tool_call
		const declared = exts.flatMap((e) => e.tools ?? []);
		if (declared.length) t.state.tools = structuredClone(declared);
		let owned: unknown = t.state.tools;
		const prepared = await runHook(exts, "before_llm", t.state, log, (s, e) => {
			const claimed = claimTools(owned, s, e.name);
			owned = claimed.tools;
			return claimed;
		});
		t.state = { ...prepared, ext: applyExt(t.state.ext, extChanges(beforeLlm, prepared.ext)) };
		if (closed) return;
		if (cancelledByApp.has(ac)) return finish("cut off by the app");
		if (t.state.cancel === true) return silent();

		// The reply streams as it is written, but nothing reaches the app until
		// before_reply has decided, nor while it could still be the model's
		// silent reply.
		const token = character.chat.silent_reply ?? "";
		let decided = false;
		let said = ""; // the text the app gets, every round's
		const held: string[] = [];
		const release = () => {
			// a reply that is only whitespace so far may still be one that only acts
			if (!said.trim()) return;
			for (const text of held) send({ t: "llm_delta", id, text });
			held.length = 0;
		};
		void replyCancelled.then((cancel) => {
			decided = true;
			if (cancel) {
				ac.abort();
				return;
			}
			// the app cut the turn off while it waited; what was held stays unsent
			if (ac.signal.aborted) return;
			release();
		});

		const kept = toTools(t.state.tools, warnOnce);
		const tools = kept.map((k) => k.tool);
		const choice = toChoice(t.state.tool_choice, tools, warnOnce);
		const runCall = async (c: ToolCall): Promise<ToolResult | undefined> => {
			const owner = c.by ? exts.find((e) => e.name === c.by) : undefined;
			if (!owner) return { error: `there is no tool named ${c.name}` };
			return runTool(owner, c, t.state, ac.signal, log, warnOnce);
		};
		const apiKey = process.env[character.chat.api_key_env] ?? "";
		// The app keeps a silent reply as `…`; the model wrote it as the token. A
		// reply that only acted ends with `[acted]`: after its calls' results it
		// is dropped, so the model reads what it did and nothing it chose not to
		// say; from an app that kept no calls, it reads as `…`, not the token.
		const asSaid = (ms: Message[]): Message[] =>
			ms.flatMap((m, i) => {
				if (m.role !== "assistant" || m.tool_calls) return [m];
				// before_llm may have written a message with no text
				if (typeof m.content !== "string") return [{ ...m, content: "" }];
				if (m.content.trim() === ACTED_TURN) return ms[i - 1]?.role === "tool" ? [] : [{ ...m, content: SILENT_TURN }];
				return token && m.content.trim() === SILENT_TURN ? [{ ...m, content: token }] : [m];
			});
		const request: Message[] = [{ role: "system", content: t.state.prompt ?? "" }, ...asSaid(paired(t.state.messages ?? []))];
		let quiet = false; // the last round answered the silent reply
		let failure: string | null = null;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			// before_reply may have cancelled the turn already
			if (closed || ac.signal.aborted) break;
			const last = round === MAX_ROUNDS - 1;
			let text = ""; // this round's, as written
			let spoken = ""; // this round's, as the app gets it
			let maybeSilent = token !== "";
			const checking: string[] = []; // pieces that may still be the silent reply
			let tail = 0; // text after the silent reply
			const made: ToolCall[] = [];
			quiet = false;
			// a round is stopped on its own, so the turn's signal keeps meaning a cut-off
			const rc = new AbortController();
			const stop = () => rc.abort();
			ac.signal.addEventListener("abort", stop, { once: true });
			const keep = (piece: string) => {
				// the next round's text goes on after a space
				if (!spoken && said && !/\s$/.test(said) && !/^\s/.test(piece)) piece = ` ${piece}`;
				spoken += piece;
				said += piece;
				held.push(piece);
				if (decided) release();
			};
			try {
				const pick = round === 0 ? choice : last ? "none" : undefined;
				for await (const piece of streamChat(character.chat, apiKey, request, rc.signal, tools, pick)) {
					// what arrived in the same chunk as a cancel is not sent
					if (closed || ac.signal.aborted) break;
					if (typeof piece !== "string") {
						made.push(piece);
						continue;
					}
					text += piece;
					// the model said nothing, and may still be calling a tool
					if (quiet) {
						tail += piece.length;
						// stopped, the stream still hands over the calls that were whole
						if (tail > SILENT_TAIL_CHARS) rc.abort();
						continue;
					}
					if (!maybeSilent) {
						keep(piece);
						continue;
					}
					checking.push(piece);
					const lead = text.trimStart();
					if (lead.startsWith(token)) {
						// whatever the model meant to add after it goes unwritten
						quiet = true;
						if (tools.length) continue;
						rc.abort();
						break;
					}
					if (token.startsWith(lead)) continue;
					maybeSilent = false;
					for (const p of checking.splice(0)) keep(p);
				}
				// a reply that ended while it still looked like the start of the token was not it
				if (!quiet && maybeSilent && !ac.signal.aborted && !closed) for (const p of checking.splice(0)) keep(p);
			} catch (e) {
				if (!ac.signal.aborted && !rc.signal.aborted)
					failure = e instanceof LlmHttpError ? `llm_${e.status}` : e instanceof LlmStreamError ? "llm_failed" : "llm_network";
			} finally {
				ac.signal.removeEventListener("abort", stop);
			}
			// no call runs until before_reply has let the reply through, so a turn
			// it cancels has done nothing
			const go = !failure && made.length > 0 && !(await replyCancelled);
			if (!go || closed || ac.signal.aborted) {
				if (calls.length) entries.push({ role: "assistant", content: quiet ? SILENT_TURN : spoken.trim() ? spoken.trimStart() : ACTED_TURN });
				break;
			}
			// every call goes to the extension whose tool it is, all at once
			for (const [i, c] of made.entries()) {
				if (!c.id) c.id = `call_${id}_${round}_${i}`;
				if (!c.arguments.trim()) c.arguments = "{}";
				const by = kept.find((k) => k.tool.name === c.name)?.by;
				if (by) c.by = by;
			}
			const content = quiet ? "" : spoken.trimStart();
			const bare = (c: ToolCall): ToolCall => ({ id: c.id, name: c.name, arguments: c.arguments });
			// Each call, once it ran, is in after_turn's state and goes to the app,
			// so however the turn ends, both have it, even with a slower one still
			// running. The first to finish carries what the round said.
			let told = false;
			const base = calls.length;
			const ran = Promise.all(
				made.map(async (c, i) => {
					const r = await runCall(c);
					// in the order the model made them, whichever finished first
					const at = ranks.findIndex((k, j) => j >= base && k > i);
					const where = at < 0 ? calls.length : at;
					calls.splice(where, 0, { ...c, result: resultText(r) });
					ranks.splice(where, 0, i);
					t.state.tool_calls = calls;
					// unless the app has cut the turn off and expects nothing more
					if (!closed && !cancelledByApp.has(ac)) {
						send({ t: "llm_calls", id, entries: [{ role: "assistant", content: told ? "" : content, tool_calls: [bare(c)] }, { role: "tool", tool_call_id: c.id, content: resultText(r) }] });
						told = true;
					}
					return r;
				}),
			);
			t.running = ran;
			const results = await ran;
			const asked: Message = { role: "assistant", content, tool_calls: made.map(bare) };
			const answers = made.map((c, i): Message => ({ role: "tool", tool_call_id: c.id, content: resultText(results[i]) }));
			request.push(asked, ...answers);
			entries.push(asked, ...answers);
			// the model is asked again when there is a result or an error to read
			const read = results.some((r) => r !== undefined && !("pending" in r));
			if (closed || ac.signal.aborted || !read || last) {
				entries.push({ role: "assistant", content: ACTED_TURN });
				break;
			}
		}
		if (decided && !ac.signal.aborted && !closed) release();
		// a reply with no text and no call would leave the app waiting on the model
		if (!failure && !said.trim() && !quiet && !calls.length && !ac.signal.aborted && !closed) failure = "llm_empty";
		const cancelled = await replyCancelled;
		if (closed) return;
		// a barge-in: the app tore the turn down and expects nothing more for it
		if (cancelledByApp.has(ac)) return finish("cut off by the app");
		if (cancelled) return silent();
		// what the app was sent, every round's; a reply that said nothing because
		// the model answered the silent reply is the token
		t.state.reply = said.trim() ? said.trimStart() : quiet ? token : "";
		if (failure) {
			t.state.error = failure;
			t.answered = true;
			send({ t: "error", id, text: failure });
			return finish(`failed: ${failure}`);
		}
		const nothing = !said.trim();
		// the model chose silence: the turn ends like a cancelled one, but after_llm
		// still sees the reply. One that acted still answered, so it isn't cancelled.
		if (nothing && !calls.length) t.state.cancel = true;
		if (nothing) send({ t: "llm_delta", id, text: calls.length ? ACTED_TURN : SILENT_TURN });
		t.answered = true;
		send(entries.length ? { t: "llm_done", id, entries } : { t: "llm_done", id });
		// the reply is done; after_llm below no longer counts against the limit
		if (llmStreams.get(id) === ac) llmStreams.delete(id);
		// sentences arrive while after_llm runs, and their hooks write `ext` too
		const before = t.state.ext;
		const after = await runHook(exts, "after_llm", t.state, log);
		t.state = { ...after, ext: t.state.ext };
		writeExt(t, extChanges(before, after.ext));
		const did = calls.length ? `, called ${calls.map((c) => c.name).join(", ")}` : "";
		finish((nothing ? "silent reply, nothing spoken" : `replied, ${said.length} chars`) + did);
	};

	// A beat that only changes the face at the start goes out as `emotion`, so it
	// lands at once; any other beat is a `beat` timed into the sentence's audio.
	const sendBeat = (id: number, b: Beat, bt: number) => {
		if (b.emotion && bt === 0 && !b.register && !b.gesture && !b.camera) {
			send({ t: "emotion", id, emotion: b.emotion });
			return;
		}
		send({
			t: "beat",
			id,
			bt,
			emotion: b.emotion ?? "",
			talk: b.register ?? "",
			gesture: b.gesture ?? "none",
			camera: b.camera ?? "none",
		});
	};
	// Sends every pending beat whose span has been voiced. Once the audio is
	// complete, a span that never matched is placed by where it sits in the text.
	const flushBeats = (sp: Spoken) => {
		while (sp.pending.length && !sp.cancelled && !closed) {
			const b = sp.pending[0];
			let bt = 0;
			if (b.span.trim()) {
				const hit = sp.align.find(b.span, sp.searchAt);
				if (hit) {
					bt = hit.t;
					sp.searchAt = hit.projEnd;
				} else if (sp.ended) {
					const at = sp.line.indexOf(b.span);
					bt = sp.align.approx(at >= 0 && sp.line.length ? at / sp.line.length : 0);
				} else {
					return;
				}
			}
			sp.pending.shift();
			sendBeat(sp.id, b, bt);
		}
	};

	const onTts = async (id: number, text: string) => {
		if (!text || text.trim() === SILENT_TURN || text.trim() === ACTED_TURN) return;
		// a sentence still running on this id stays the one the id names, so it
		// can be cancelled and counts against the limit
		const live = spoken.get(id);
		if (spoken.size >= MAX_TTS_IN_FLIGHT || (live && !live.cancelled)) {
			send({ t: "error", id, text: "tts_busy" });
			return;
		}
		const t = turn && !turn.closed ? turn : null;
		// the reply's first sentence starts a new turn on the dialogue socket
		const newTurn = t?.firstSentence ?? false;
		if (t) {
			t.ttsInFlight++;
			clearTimeout(t.idle);
			if (t.firstSentence) {
				t.firstSentence = false;
				// The app holds the start of a reply, up to 2 s, until a beat for it
				// arrives. An empty one changes nothing and lets the audio start.
				send({ t: "beat", id, bt: 0, emotion: "", talk: "", gesture: "", camera: "" });
			}
		}
		const sp: Spoken = {
			id,
			align: new Alignment(),
			line: stripTags(text),
			pending: [],
			searchAt: 0,
			ended: false,
			cancelled: false,
		};
		spoken.set(id, sp);
		// each extension's beats go out as soon as it returns, so a fast one is
		// not held back by a slow one after it
		if (t && hasHook(exts, "on_sentence")) {
			const takeBeats = (s: State): State => {
				if (Array.isArray(s.beats)) {
					sp.pending.push(...s.beats.filter(isBeat));
					flushBeats(sp);
				}
				return { ...s, beats: [] };
			};
			const before = t.state.ext;
			void runHook(exts, "on_sentence", { ...t.state, sentence: text, beats: [] }, log, takeBeats).then((s) =>
				mergeExt(t, before, s),
			);
		}
		const timing: Timing = { characters: [], starts: [], ends: [] };
		// delivery tags come back at very different loudness; this evens them out
		const leveler = new Leveler();
		const sendLeveled = (pcm: Buffer) => { if (pcm.length) sendAudio(id, pcm); };
		const end = await tts.speak({
			id,
			text: dropTags(text, character.voice.drop_tags),
			newTurn,
			onAudio: (pcm) => sendLeveled(leveler.process(pcm)),
			onAlignment: (a) => {
				pushTiming(timing, a);
				sp.align.push(a);
				flushBeats(sp);
			},
		});
		// the app may have reused the id for a newer sentence
		if (spoken.get(id) === sp) spoken.delete(id);
		if (end === "cancelled") sp.cancelled = true;
		sp.ended = true;
		flushBeats(sp);
		if (end === "done") {
			// the start of a sentence is held until it is leveled
			sendLeveled(leveler.flush());
			send({ t: "tts_done", id });
			if (t && hasHook(exts, "on_speak")) {
				const before = t.state.ext;
				void runHook(exts, "on_speak", { ...t.state, sentence: text, timing }, log).then((s) => mergeExt(t, before, s));
			}
		} else if (end !== "cancelled") {
			// no tts_done after an error: the app retries the sentence on the same id
			send({ t: "error", id, text: end.error });
			log(`sentence ${id}: ${end.error}`);
			if (t) t.state.error = end.error;
		}
		if (t) {
			t.ttsInFlight--;
			settle(t);
		}
	};

	const cancel = (id: number) => {
		const ac = llmStreams.get(id);
		if (ac) {
			cancelledByApp.add(ac);
			ac.abort();
		}
		const sp = spoken.get(id);
		if (sp) sp.cancelled = true;
		tts.cancel(id);
	};

	ws.on("message", (data, isBinary) => {
		if (closed) return;
		if (isBinary) {
			stt.audio(data as Buffer);
			return;
		}
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return;
		// every request names its turn or sentence by a small integer id
		const id = msg.id;
		const hasId = Number.isSafeInteger(id) && (id as number) >= 0;
		if ((msg.t === "llm" || msg.t === "tts" || msg.t === "cancel") && !hasId) return;
		// a reply the app cancelled no longer counts, even while it winds down
		const replying = [...llmStreams.values()].filter((ac) => !ac.signal.aborted).length;
		// a reply still running on this id is refused, so the id keeps naming the
		// running one and it can still be cancelled and counted; one an extension
		// silenced is still winding down, so it counts as running until it's done
		const running = llmStreams.get(id as number);
		const live = running !== undefined && !cancelledByApp.has(running);
		if (msg.t === "llm" && (replying >= MAX_LLM_IN_FLIGHT || live)) {
			send({ t: "error", id, text: "llm_busy" });
			return;
		}
		switch (msg.t) {
			case "stt_start": stt.start(msg.utterance); break;
			case "stt_eos": stt.endOfSpeech(msg.utterance); break;
			case "stt_reset": stt.reset(); break;
			case "llm": void onLlm(id as number, msg.history, msg.source); break;
			case "tts": void onTts(id as number, typeof msg.text === "string" ? msg.text : ""); break;
			case "cancel": cancel(id as number); break;
		}
	});

	const teardown = async (reason: string) => {
		if (closed) return;
		closed = true;
		tts.close();
		for (const ac of llmStreams.values()) ac.abort();
		stt.close();
		offers.close();
		services.abort();
		if (running.length) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<void>((r) => { timer = setTimeout(r, SERVICE_STOP_MS); });
			await Promise.race([Promise.allSettled(running), late]);
			clearTimeout(timer);
		}
		if (turn) await closeTurn(turn);
		await runHook(exts, "on_session_end", { ...baseState(), session: { ...session, end_reason: reason } }, log);
		log(`closed: ${reason}`);
	};
	ws.on("close", () => void teardown("the app disconnected"));
	ws.on("error", () => void teardown("the connection failed"));
}
