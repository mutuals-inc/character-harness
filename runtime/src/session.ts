// One app connection: a single WebSocket for the whole conversation, with
// everything multiplexed over it:
//
//   app -> runtime
//     text  {t:"stt_start",utterance?} | {t:"stt_eos",utterance?} | {t:"stt_reset"}
//           {t:"llm",id,history,source?} | {t:"tts",id,text} | {t:"cancel",id}
//     bin   PCM16 16 kHz mic frames
//   runtime -> app
//     text  {t:"mode",text,v} | {t:"stt_partial"|"stt_final",text,utterance?}
//           {t:"llm_delta",id,text} | {t:"llm_done",id} | {t:"tts_done",id}
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
import { hasHook, runHook } from "./extensions.ts";
import type { Loaded, ServiceContext } from "./extensions.ts";
import { LlmHttpError, LlmStreamError, streamChat } from "./llm.ts";
import { ELEVENLABS_KEY } from "./manifest.ts";
import type { Character } from "./manifest.ts";
import { STATE_SCHEMA } from "./state.ts";
import type { Beat, Message, State, Timing } from "./state.ts";
import { SttRelay } from "./stt.ts";
import { Heard } from "./utterances.ts";
import { Tts } from "./tts.ts";
import { Alignment } from "./align.ts";
import { Leveler } from "./level.ts";
import { Offers } from "./offers.ts";
import type { LinkHub } from "./offers.ts";
import type { AlignmentChunk } from "./align.ts";

const PROTOCOL_VERSION = 1;

// What a turn that makes no sound sends instead of nothing. The app waits ~12 s
// on a turn with no text before calling the model dead, so a cancelled turn
// sends this one character and `llm_done`. The app hands it back as a `tts`,
// which is dropped without a sound.
const SILENT_TURN = "…";

// How long a finished reply waits for more sentences before after_turn fires.
// The app sends a sentence's `tts` as a playback slot frees up, so most of a
// reply's sentences arrive after its `llm_done`.
const TURN_IDLE_MS = 1500;

// The app runs one reply at a time and voices a few sentences ahead; past
// these, a request is refused rather than spent.
const MAX_LLM_IN_FLIGHT = 2;
const MAX_TTS_IN_FLIGHT = 8;

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
}

function toMessages(history: unknown): Message[] {
	if (!Array.isArray(history)) return [];
	return history
		// the system prompt is the character's; the app only sends the conversation
		.filter((h): h is Message => (h?.role === "user" || h?.role === "assistant") && typeof h?.content === "string")
		// the app's `interrupted` marker is not for the model
		.map((h) => ({ role: h.role, content: h.content }));
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
		};
		turn = t;
		const finish = (how: string) => {
			// the app may have reused the id for a newer reply
			if (llmStreams.get(id) === ac) llmStreams.delete(id);
			t.llmDone = true;
			log(`turn ${id}: ${how}`);
			settle(t);
		};
		const silent = () => {
			t.state.cancel = true;
			send({ t: "llm_delta", id, text: SILENT_TURN });
			send({ t: "llm_done", id });
			finish("cancelled, nothing spoken");
		};

		// before_reply works on its own copy; only its `cancel` is kept
		const replyCancelled = hasHook(exts, "before_reply")
			? runHook(exts, "before_reply", t.state, log).then((s) => s.cancel === true)
			: Promise.resolve(false);

		// a service may write its ext while before_llm runs on a copy
		const beforeLlm = t.state.ext;
		const prepared = await runHook(exts, "before_llm", t.state, log);
		t.state = { ...prepared, ext: applyExt(t.state.ext, extChanges(beforeLlm, prepared.ext)) };
		if (closed) return;
		if (cancelledByApp.has(ac)) return finish("cut off by the app");
		if (t.state.cancel === true) return silent();

		// The reply streams as it is written, but nothing reaches the app until
		// before_reply has decided, nor while it could still be the model's
		// silent reply.
		const token = character.chat.silent_reply ?? "";
		let maybeSilent = token !== "";
		let passed = false; // the model answered its silent reply
		let decided = false;
		const held: string[] = [];
		const release = () => {
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
			if (!maybeSilent) release();
		});

		let reply = "";
		let failure: string | null = null;
		try {
			const apiKey = process.env[character.chat.api_key_env] ?? "";
			// the app keeps a silent reply as `…`; the model wrote it as the token
			const said = (m: Message): Message =>
				token && m.role === "assistant" && m.content.trim() === SILENT_TURN ? { ...m, content: token } : m;
			const request: Message[] = [{ role: "system", content: t.state.prompt ?? "" }, ...(t.state.messages ?? []).map(said)];
			for await (const text of streamChat(character.chat, apiKey, request, ac.signal)) {
				// what arrived in the same chunk as a cancel is not sent
				if (closed || ac.signal.aborted) break;
				reply += text;
				held.push(text);
				if (maybeSilent) {
					const lead = reply.trimStart();
					if (lead.startsWith(token)) {
						// whatever the model meant to add after it goes unwritten
						passed = true;
						ac.abort();
						break;
					}
					if (!token.startsWith(lead)) maybeSilent = false;
				}
				if (decided && !maybeSilent) release();
			}
		} catch (e) {
			if (!ac.signal.aborted)
				failure = e instanceof LlmHttpError ? `llm_${e.status}` : e instanceof LlmStreamError ? "llm_failed" : "llm_network";
		}
		// a reply that ended while it still looked like the start of the token was not it
		if (!passed) {
			maybeSilent = false;
			if (decided && !ac.signal.aborted && !closed) release();
		}
		// a reply with no text would leave the app waiting on the model
		if (!failure && !reply.trim() && !ac.signal.aborted && !closed) failure = "llm_empty";
		const cancelled = await replyCancelled;
		if (closed) return;
		// a barge-in: the app tore the turn down and expects nothing more for it
		if (cancelledByApp.has(ac)) return finish("cut off by the app");
		if (cancelled) return silent();
		t.state.reply = reply;
		if (failure) {
			t.state.error = failure;
			send({ t: "error", id, text: failure });
			return finish(`failed: ${failure}`);
		}
		// the model chose silence: the turn ends like a cancelled one, but after_llm
		// still sees the reply
		if (passed) {
			t.state.cancel = true;
			send({ t: "llm_delta", id, text: SILENT_TURN });
		}
		send({ t: "llm_done", id });
		// the reply is done; after_llm below no longer counts against the limit
		if (llmStreams.get(id) === ac) llmStreams.delete(id);
		// sentences arrive while after_llm runs, and their hooks write `ext` too
		const before = t.state.ext;
		const after = await runHook(exts, "after_llm", t.state, log);
		t.state = { ...after, ext: t.state.ext };
		writeExt(t, extChanges(before, after.ext));
		finish(passed ? "silent reply, nothing spoken" : `replied, ${reply.length} chars`);
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
		if (!text || text.trim() === SILENT_TURN) return;
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
