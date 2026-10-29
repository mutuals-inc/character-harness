// How the session merges what overlapping hooks wrote to `ext`, and how it
// keeps each reply and sentence apart from others on the same id, driven over
// a fake socket with a fake `fetch`. Run with `npm test`.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import { runTool } from "../src/extensions.ts";
import type { HookInput, Loaded } from "../src/extensions.ts";
import type { Character } from "../src/manifest.ts";
import type { HookName } from "../src/state.ts";
import { applyExt, extChanges, runSession } from "../src/session.ts";

test("a hook's stale copy of ext does not undo what another hook wrote", () => {
	const start = { a: { n: 1 }, b: 1 };
	// two hooks start from the same copy; one changes a, the other b
	const first = extChanges(start, { a: { n: 2 }, b: 1 });
	const second = extChanges(start, { a: { n: 1 }, b: 2 });
	const ext = applyExt(applyExt(start, first), second);
	assert.deepEqual(ext, { a: { n: 2 }, b: 2 });
});

test("a key a hook removed is removed, and new keys are added", () => {
	const ext = applyExt({ a: 1, b: 2 }, extChanges({ a: 1, b: 2 }, { a: 1, c: 3 }));
	assert.deepEqual(ext, { a: 1, c: 3 });
});

test("a hook that hands back no ext changes nothing, and a value JSON can't write counts as changed", () => {
	assert.deepEqual(extChanges({ a: 1 }, undefined as never), { set: {}, removed: [] });
	assert.deepEqual(extChanges(undefined as never, { a: 1 }), { set: { a: 1 }, removed: [] });
	assert.deepEqual(extChanges({ a: 1n }, { a: 1n }).set, { a: 1n });
});

// A socket that keeps what the session sends; the test plays the app with `app`.
function fakeSocket() {
	const ws = Object.assign(new EventEmitter(), {
		readyState: WebSocket.OPEN,
		sent: [] as Record<string, unknown>[],
		send(data: unknown) {
			if (typeof data === "string") ws.sent.push(JSON.parse(data));
		},
	});
	const app = (msg: unknown) => ws.emit("message", Buffer.from(JSON.stringify(msg)), false);
	return { ws, app };
}

const character = {
	dir: "",
	id: "test",
	name: "Test",
	prompt: "You are a test.",
	chat: { api: "chat_completions", base_url: "http://chat.test", api_key_env: "SESSION_TEST_KEY", model: "m", params: {} },
	stt: { provider: "elevenlabs", model: "s", keyterms: [] },
	// not a dialogue model, so sentences go over plain HTTP and no socket opens
	voice: { provider: "elevenlabs", voice_id: "v", model: "eleven_test", params: {}, drop_tags: [] },
	rig: {},
	extensions: [],
	env_file: "",
	manifest: {},
} as unknown as Character;

// A body that sends nothing until its request is aborted, like a model or a
// voice still thinking.
function hanging(signal: AbortSignal): Response {
	return new Response(
		new ReadableStream({
			start(c) {
				signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
			},
		}),
	);
}

const reply = (text: string) =>
	new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
const noText = () => new Response("data: [DONE]\n\n");

// an extension with one blocking hook
function hook(name: HookName, call: (input: HookInput) => unknown): Loaded {
	return {
		name: "test",
		dir: "",
		handler: "",
		hooks: new Map([[name, { blocking: true, timeout_ms: 5000 }]]),
		requires_env: [],
		config: {},
		call,
	} as unknown as Loaded;
}

function gate() {
	let open = () => {};
	const shut = new Promise<void>((r) => { open = r; });
	return { shut, open };
}

async function until(done: () => boolean, what: string) {
	const deadline = Date.now() + 2000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 1));
	}
}

// One session over a fake socket. `answer` plays every upstream request (the
// chat model and the voice), so nothing leaves the machine.
function session(
	t: TestContext,
	answer: (n: number, signal: AbortSignal) => Response,
	exts: Loaded[] = [],
	c: Character = character,
) {
	const lines: string[] = [];
	t.mock.method(console, "log", (line: string) => { lines.push(line); });
	const calls: AbortSignal[] = [];
	const bodies: Record<string, unknown>[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		const signal = init.signal as AbortSignal;
		calls.push(signal);
		bodies.push(JSON.parse(init.body as string));
		return answer(calls.length - 1, signal);
	});
	const { ws, app } = fakeSocket();
	runSession(ws as unknown as WebSocket, c, exts);
	const logged = (text: string) => lines.some((l) => l.includes(text));
	return {
		app,
		calls,
		bodies,
		lines,
		logged,
		// what the app got for one id, without the staging beats
		sentFor: (id: number) => ws.sent.filter((m) => m.id === id && m.t !== "beat"),
		close: async () => {
			ws.emit("close");
			await until(() => logged("closed:"), "the session to close");
		},
	};
}

const history = [{ role: "user", content: "hi" }];
const answered = (text: string) => [
	{ t: "llm_delta", id: 5, text },
	{ t: "llm_done", id: 5 },
];

test("an llm that reuses a cancelled reply's id is answered, and the cancelled reply sends nothing more", async (t) => {
	const s = session(t, (n, signal) => (n === 0 ? hanging(signal) : reply("hello again")));
	s.app({ t: "llm", id: 5, history });
	await until(() => s.calls.length === 1, "the first reply to start");
	// the user barges in, and the app's next reply happens to get the same id
	s.app({ t: "cancel", id: 5 });
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied") && s.logged("turn 5: cut off by the app"), "both replies to end");
	assert.deepEqual(s.sentFor(5), answered("hello again"));
	await s.close();
});

test("a reply cancelled before the session is ready never runs, and its id can be reused", async (t) => {
	const ready = gate();
	const s = session(t, () => reply("hello"), [hook("on_session_start", () => ready.shut)]);
	s.app({ t: "llm", id: 5, history });
	s.app({ t: "cancel", id: 5 });
	s.app({ t: "llm", id: 5, history });
	ready.open();
	await until(() => s.logged("turn 5: replied"), "the second reply");
	assert.equal(s.calls.length, 1);
	assert.deepEqual(s.sentFor(5), answered("hello"));
	await s.close();
});

test("a reply cancelled during before_llm sends nothing, and its id can be reused", async (t) => {
	const held = gate();
	let runs = 0;
	const s = session(t, () => reply("hello"), [hook("before_llm", () => (runs++ === 0 ? held.shut : undefined))]);
	s.app({ t: "llm", id: 5, history });
	await until(() => runs === 1, "before_llm");
	s.app({ t: "cancel", id: 5 });
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the second reply");
	held.open();
	await until(() => s.logged("turn 5: cut off by the app"), "the first reply to wind down");
	// the first reply never reached the model
	assert.equal(s.calls.length, 1);
	assert.deepEqual(s.sentFor(5), answered("hello"));
	await s.close();
});

test("a reply cancelled while before_reply holds it sends nothing, and its id can be reused", async (t) => {
	const held = gate();
	let runs = 0;
	const s = session(t, (n) => reply(n === 0 ? "first" : "second"), [
		hook("before_reply", () => (runs++ === 0 ? held.shut : undefined)),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => runs === 1 && s.calls.length === 1, "the first reply to be held");
	s.app({ t: "cancel", id: 5 });
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the second reply");
	held.open();
	await until(() => s.logged("turn 5: cut off by the app"), "the first reply to wind down");
	assert.deepEqual(s.sentFor(5), answered("second"));
	await s.close();
});

test("a reply with no text on a reused id gets llm_empty, not llm_done", async (t) => {
	const s = session(t, (n, signal) => (n === 0 ? hanging(signal) : noText()));
	s.app({ t: "llm", id: 5, history });
	await until(() => s.calls.length === 1, "the first reply to start");
	s.app({ t: "cancel", id: 5 });
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: failed: llm_empty") && s.logged("turn 5: cut off by the app"), "both replies to end");
	assert.deepEqual(s.sentFor(5), [{ t: "error", id: 5, text: "llm_empty" }]);
	await s.close();
});

test("an llm on the id of a reply still running is refused, and the running one can still be cancelled", async (t) => {
	const s = session(t, (_n, signal) => hanging(signal));
	s.app({ t: "llm", id: 5, history });
	await until(() => s.calls.length === 1, "the reply to start");
	s.app({ t: "llm", id: 5, history });
	assert.deepEqual(s.sentFor(5), [{ t: "error", id: 5, text: "llm_busy" }]);
	s.app({ t: "cancel", id: 5 });
	assert.equal(s.calls[0].aborted, true);
	await until(() => s.logged("turn 5: cut off by the app"), "the reply to wind down");
	assert.equal(s.calls.length, 1);
	assert.deepEqual(s.sentFor(5), [{ t: "error", id: 5, text: "llm_busy" }]);
	await s.close();
});

test("a tts on the id of a sentence still being voiced is refused, and the running one can still be cancelled", async (t) => {
	const s = session(t, (_n, signal) => hanging(signal));
	s.app({ t: "tts", id: 7, text: "One." });
	await until(() => s.calls.length === 1, "the sentence to start");
	s.app({ t: "tts", id: 7, text: "Two." });
	await until(() => s.sentFor(7).length > 0, "the refusal");
	assert.deepEqual(s.sentFor(7), [{ t: "error", id: 7, text: "tts_busy" }]);
	assert.equal(s.calls.length, 1);
	s.app({ t: "cancel", id: 7 });
	assert.equal(s.calls[0].aborted, true);
	await s.close();
});

test("a sentence that reuses a cancelled sentence's id can itself be cancelled", async (t) => {
	const s = session(t, (_n, signal) => hanging(signal));
	s.app({ t: "tts", id: 7, text: "One." });
	await until(() => s.calls.length === 1, "the first sentence to start");
	s.app({ t: "cancel", id: 7 });
	s.app({ t: "tts", id: 7, text: "One." });
	await until(() => s.calls.length === 2, "the second sentence to start");
	// let the first sentence's aborted request wind down
	await new Promise((r) => setImmediate(r));
	assert.equal(s.calls[0].aborted, true);
	assert.equal(s.calls[1].aborted, false);
	s.app({ t: "cancel", id: 7 });
	assert.equal(s.calls[1].aborted, true);
	await s.close();
	assert.deepEqual(s.sentFor(7), []);
});

test("closing the session aborts every reply and sentence still running, and a repeated id starts nothing", async (t) => {
	const s = session(t, (_n, signal) => hanging(signal));
	for (let i = 0; i < 5; i++) s.app({ t: "llm", id: 5, history });
	s.app({ t: "llm", id: 6, history });
	for (let i = 0; i < 5; i++) s.app({ t: "tts", id: 7, text: "One." });
	s.app({ t: "tts", id: 8, text: "Two." });
	await until(() => s.calls.length === 4, "two replies and two sentences to start");
	await s.close();
	assert.deepEqual(s.calls.map((c) => c.aborted), [true, true, true, true]);
	assert.equal(s.calls.length, 4);
});

// The model's own silent reply, `models.chat.silent_reply`.

const quiet = { ...character, chat: { ...character.chat, silent_reply: "[pass]" } } as Character;

// A reply streamed in `parts`, one event each. With `signal`, the body stays
// open after them until the request is aborted, like a model still writing.
function streamed(parts: string[], signal?: AbortSignal): Response {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(c) {
				for (const p of parts) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
				if (signal) {
					signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
					return;
				}
				c.enqueue(enc.encode("data: [DONE]\n\n"));
				c.close();
			},
		}),
	);
}

// A reply the test writes a part at a time with `say`, and ends with `end`.
// The body is asked for its next part only once the runtime has handled the
// last one, so `handled(n)` says the runtime has taken in the first n parts.
function scripted() {
	const enc = new TextEncoder();
	const parts: (string | null)[] = [];
	let wake = () => {};
	let pulls = 0;
	return {
		say(text: string) { parts.push(text); wake(); },
		end() { parts.push(null); wake(); },
		handled: (n: number) => pulls > n,
		body(signal: AbortSignal): Response {
			return new Response(
				new ReadableStream(
					{
						async pull(c) {
							pulls++;
							while (!parts.length) {
								if (signal.aborted) return c.error(new DOMException("aborted", "AbortError"));
								await new Promise<void>((r) => {
									wake = r;
									signal.addEventListener("abort", () => r(), { once: true });
								});
							}
							const p = parts.shift();
							if (p == null) {
								c.enqueue(enc.encode("data: [DONE]\n\n"));
								c.close();
								return;
							}
							c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
						},
					},
					{ highWaterMark: 0 },
				),
			);
		},
	};
}

const silentTurn = [
	{ t: "llm_delta", id: 5, text: "…" },
	{ t: "llm_done", id: 5 },
];

test("a silent reply split across chunks is silent, and after_llm sees it", async (t) => {
	let seen: Record<string, unknown> = {};
	const s = session(t, () => streamed(["[pa", "ss]"]), [hook("after_llm", ({ state }) => { seen = { ...state }; })], quiet);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn to end");
	assert.deepEqual(s.sentFor(5), silentTurn);
	assert.equal(seen.reply, "[pass]");
	assert.equal(seen.cancel, true);
	await s.close();
});

test("a silent reply after leading whitespace is silent", async (t) => {
	const s = session(t, () => streamed(["\n ", " [pass]"]), [], quiet);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn to end");
	assert.deepEqual(s.sentFor(5), silentTurn);
	await s.close();
});

test("a reply that starts like the silent reply and then differs goes out whole, in order", async (t) => {
	const s = session(t, () => streamed(["[", "teas", "ing] hi", " there"]), [], quiet);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual(s.sentFor(5), [
		{ t: "llm_delta", id: 5, text: "[" },
		{ t: "llm_delta", id: 5, text: "teas" },
		{ t: "llm_delta", id: 5, text: "ing] hi" },
		{ t: "llm_delta", id: 5, text: " there" },
		{ t: "llm_done", id: 5 },
	]);
	await s.close();
});

test("a reply that differs from the silent reply goes out at once, while the model still writes", async (t) => {
	const m = scripted();
	const s = session(t, (_n, signal) => m.body(signal), [], quiet);
	s.app({ t: "llm", id: 5, history });
	m.say("[");
	m.say("teas");
	await until(() => s.sentFor(5).length === 2, "the text to go out");
	assert.deepEqual(s.sentFor(5), [
		{ t: "llm_delta", id: 5, text: "[" },
		{ t: "llm_delta", id: 5, text: "teas" },
	]);
	m.end();
	await until(() => s.logged("turn 5: replied"), "the reply");
	await s.close();
});

test("before_reply letting the reply through does not release the start of the silent reply", async (t) => {
	const held = gate();
	const m = scripted();
	const s = session(t, (_n, signal) => m.body(signal), [hook("before_reply", () => held.shut)], quiet);
	s.app({ t: "llm", id: 5, history });
	m.say("[pa");
	await until(() => m.handled(1), "the start of the reply");
	held.open();
	// before_reply has decided by the time the next part is handled
	await new Promise((r) => setImmediate(r));
	m.say("ss]");
	await until(() => s.logged("turn 5: silent reply"), "the turn to end");
	assert.deepEqual(s.sentFor(5), silentTurn);
	await s.close();
});

test("a reply that ends partway into the silent reply is sent, not swallowed", async (t) => {
	const s = session(t, () => streamed(["[pa"]), [], quiet);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual(s.sentFor(5), answered("[pa"));
	await s.close();
});

test("text after the silent reply is not sent, and the model is stopped", async (t) => {
	let seen = "";
	const s = session(
		t,
		(_n, signal) => streamed(["[pass] but", " actually"], signal),
		[hook("after_llm", ({ state }) => { seen = String(state.reply); })],
		quiet,
	);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn to end");
	assert.equal(s.calls[0].aborted, true);
	assert.deepEqual(s.sentFor(5), silentTurn);
	// nothing was said, so the reply is the silent reply, not what followed it
	assert.equal(seen, "[pass]");
	await s.close();
});

test("a reply that is only the silent reply is not llm_empty, but an empty one still is", async (t) => {
	const s = session(t, (n) => (n === 0 ? reply("[pass]") : noText()), [], quiet);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the silent turn");
	s.app({ t: "llm", id: 6, history });
	await until(() => s.logged("turn 6: failed: llm_empty"), "the empty turn");
	assert.deepEqual(s.sentFor(5), silentTurn);
	assert.deepEqual(s.sentFor(6), [{ t: "error", id: 6, text: "llm_empty" }]);
	await s.close();
});

test("a silent reply while before_reply cancels ends the turn once, as a cancelled turn", async (t) => {
	const held = gate();
	const m = scripted();
	let after = 0;
	const s = session(
		t,
		(_n, signal) => m.body(signal),
		[
			hook("before_reply", async ({ state }) => {
				await held.shut;
				return { state: { ...state, cancel: true } };
			}),
			{ ...hook("after_llm", () => { after++; }), name: "after" },
		],
		quiet,
	);
	s.app({ t: "llm", id: 5, history });
	m.say("[pass]");
	await until(() => s.calls.length === 1 && s.calls[0].aborted, "the model to be stopped at the token");
	held.open();
	await until(() => s.logged("turn 5: cancelled"), "the turn to end");
	assert.deepEqual(s.sentFor(5), silentTurn);
	assert.equal(after, 0);
	await s.close();
});

test("the app's … in the history goes to the model as the silent reply", async (t) => {
	const s = session(t, () => reply("hi"), [], quiet);
	const past = [
		{ role: "user", content: "talking to someone else" },
		{ role: "assistant", content: "…" },
		{ role: "user", content: "…" },
		{ role: "assistant", content: " …\n" },
		{ role: "user", content: "hi" },
	];
	s.app({ t: "llm", id: 5, history: past });
	await until(() => s.logged("turn 5: replied"), "the reply");
	const sent = s.bodies[0].messages as { role: string; content: string }[];
	const pass = { role: "assistant", content: "[pass]" };
	// only the character's own lines are its silent replies
	assert.deepEqual(sent.slice(1), [past[0], pass, past[2], pass, past[4]]);
	await s.close();
});

test("without silent_reply, the token is an ordinary reply and … stays as it is", async (t) => {
	const s = session(t, () => streamed(["[pa", "ss]"]));
	const past = [
		{ role: "assistant", content: "…" },
		{ role: "user", content: "hi" },
	];
	s.app({ t: "llm", id: 5, history: past });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual(s.sentFor(5), [
		{ t: "llm_delta", id: 5, text: "[pa" },
		{ t: "llm_delta", id: 5, text: "ss]" },
		{ t: "llm_done", id: 5 },
	]);
	assert.deepEqual((s.bodies[0].messages as unknown[]).slice(1), past);
	await s.close();
});

test("a reply held by before_reply and by the silent reply goes out once both let it", async (t) => {
	const held = gate();
	let runs = 0;
	const m = scripted();
	const s = session(t, (_n, signal) => m.body(signal), [hook("before_reply", () => { runs++; return held.shut; })], quiet);
	s.app({ t: "llm", id: 5, history });
	m.say("[pa");
	m.say("use] ok");
	await until(() => runs === 1 && m.handled(2), "the reply to be held");
	assert.deepEqual(s.sentFor(5), []);
	held.open();
	m.end();
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual(s.sentFor(5), [
		{ t: "llm_delta", id: 5, text: "[pa" },
		{ t: "llm_delta", id: 5, text: "use] ok" },
		{ t: "llm_done", id: 5 },
	]);
	await s.close();
});

// Tools an extension offers the chat model, the calls it makes, and what they
// hand back.

const sse = (events: unknown[]) => new Response([...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), "data: [DONE]\n\n"].join(""));
const piece = (index: number, fn: { name?: string; arguments?: string }, id?: string) => ({
	choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: fn }] } }],
});
const said = (text: string) => ({ choices: [{ delta: { content: text } }] });
const useItem = { name: "use_item", description: "Use an item.", parameters: { type: "object", properties: { item: { type: "string" } } } };

// An extension on several blocking hooks
function exts(name: string, calls: Partial<Record<HookName, (input: HookInput) => unknown>>, tools: unknown[] = []): Loaded {
	return {
		name,
		dir: "",
		handler: "",
		hooks: new Map(Object.keys(calls).map((h) => [h as HookName, { blocking: true, timeout_ms: 5000 }])),
		tools,
		requires_env: [],
		config: {},
		call: (i: HookInput) => calls[i.event]?.(i),
	} as unknown as Loaded;
}

// "kit" offers `tools` on before_llm and runs them with `run`; after_llm keeps
// the state it saw, and `ran` the calls kit was handed
function acting(tools: unknown[], run: (input: HookInput) => unknown = () => undefined) {
	const seen: { state?: Record<string, unknown> } = {};
	const ran: unknown[] = [];
	const list = [
		exts("kit", {
			before_llm: ({ state }) => ({ state: { ...state, tools } }),
			on_tool_call: (i) => {
				ran.push(i.call);
				return run(i);
			},
		}),
		exts("after", { after_llm: ({ state }) => { seen.state = { ...state }; } }),
	];
	return { exts: list, seen, ran };
}

// what this turn adds to the history when it called tools
const asked = (content: string, ...calls: { id: string; name: string; arguments: string }[]) => ({ role: "assistant", content, tool_calls: calls });
const result = (id: string, content: string) => ({ role: "tool", tool_call_id: id, content });
const call = (id: string, args = "{}") => ({ id, name: "use_item", arguments: args });
const done = (entries: unknown[]) => ({ t: "llm_done", id: 5, entries });
// what the app gets as soon as a round's calls have run
const callsRan = (entries: unknown[]) => ({ t: "llm_calls", id: 5, entries });
const acted = { role: "assistant", content: "[acted]" };

test("tools go to the model in its API's shape, each usable name once", async (t) => {
	const { exts } = acting([useItem, { ...useItem, description: "again" }, { name: "has space" }, { name: "bad", parameters: { type: "array" } }, { name: "wait" }]);
	const s = session(t, () => reply("ok"), exts);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual(s.bodies[0].tools, [
		{ type: "function", function: useItem },
		{ type: "function", function: { name: "wait", description: "", parameters: { type: "object", properties: {} } } },
	]);
	assert.equal("tool_choice" in s.bodies[0], false);
	assert.ok(s.logged("tool use_item is listed twice"));
	assert.ok(s.logged('tool "bad" was left out: its parameters must be a schema of type "object"'));
	assert.ok(s.logged('tool "has space" was left out: its name must be 1 to 64'));
	await s.close();
});

test("a turn without tools sends none", async (t) => {
	const s = session(t, () => reply("ok"));
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.equal("tools" in s.bodies[0], false);
	await s.close();
});

test("a call streamed in pieces goes whole to the extension whose tool it is, and one with nothing to report asks no more", async (t) => {
	const { exts, seen, ran } = acting([useItem]);
	const s = session(
		t,
		() =>
			sse([
				said("Here goes."),
				piece(0, { name: "use_item", arguments: '{"it' }, "call_1"),
				piece(0, { arguments: 'em":"key"}' }),
				piece(1, { name: "use_item", arguments: "" }, "call_2"),
			]),
		exts,
	);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied, 10 chars, called use_item, use_item"), "the reply");
	assert.equal(s.calls.length, 1);
	assert.deepEqual(ran, [{ ...call("call_1", '{"item":"key"}'), by: "kit" }, { ...call("call_2"), by: "kit" }]);
	assert.deepEqual(s.sentFor(5), [
		{ t: "llm_delta", id: 5, text: "Here goes." },
		callsRan([asked("Here goes.", call("call_1", '{"item":"key"}'), call("call_2")), result("call_1", "Done."), result("call_2", "Done.")]),
		done([asked("Here goes.", call("call_1", '{"item":"key"}'), call("call_2")), result("call_1", "Done."), result("call_2", "Done."), acted]),
	]);
	assert.deepEqual(seen.state?.tool_calls, [
		{ ...call("call_1", '{"item":"key"}'), by: "kit", result: "Done." },
		{ ...call("call_2"), by: "kit", result: "Done." },
	]);
	assert.equal(seen.state?.cancel, undefined);
	await s.close();
});

test("a result asks the model again in the same turn, which reads the call and its result and goes on speaking", async (t) => {
	const { exts, seen } = acting([useItem], ({ call }) => ({ result: { content: `used ${JSON.parse(call!.arguments).item}` } }));
	const s = session(t, (n) => (n === 0 ? sse([said("Let me see."), piece(0, { name: "use_item", arguments: '{"item":"key"}' }, "c")]) : reply("It opened!")), exts);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.equal(s.calls.length, 2);
	assert.deepEqual((s.bodies[1].messages as unknown[]).slice(1), [
		...history,
		{ role: "assistant", content: "Let me see.", tool_calls: [{ id: "c", type: "function", function: { name: "use_item", arguments: '{"item":"key"}' } }] },
		{ role: "tool", tool_call_id: "c", content: "used key" },
	]);
	assert.deepEqual(s.sentFor(5), [
		{ t: "llm_delta", id: 5, text: "Let me see." },
		callsRan([asked("Let me see.", call("c", '{"item":"key"}')), result("c", "used key")]),
		{ t: "llm_delta", id: 5, text: " It opened!" },
		done([asked("Let me see.", call("c", '{"item":"key"}')), result("c", "used key"), { role: "assistant", content: "It opened!" }]),
	]);
	// what the app was sent, so with the space between the rounds
	assert.equal(seen.state?.reply, "Let me see. It opened!");
	await s.close();
});

test("a tool that fails, throws or is unknown gives the model an error to read", async (t) => {
	const { exts } = acting([useItem, { name: "wait" }], ({ call }) => {
		if (call!.name === "wait") throw new Error("broken");
		return { result: { error: "no such item" } };
	});
	const s = session(
		t,
		(n) =>
			n === 0
				? sse([piece(0, { name: "use_item", arguments: "{}" }, "a"), piece(1, { name: "wait", arguments: "{}" }, "b"), piece(2, { name: "dance", arguments: "{}" }, "c")])
				: reply("Oops."),
		exts,
	);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual((s.bodies[1].messages as { role: string; content: string }[]).filter((m) => m.role === "tool").map((m) => m.content), [
		"Error: no such item",
		"Error: the tool failed",
		"Error: there is no tool named dance",
	]);
	assert.ok(s.logged("kit on_tool_call wait failed: broken"));
	await s.close();
});

test("a result that comes later is promised to the model, and asks it nothing more", async (t) => {
	const { exts, seen } = acting([useItem], () => ({ result: { pending: true } }));
	const s = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]), exts);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply, nothing spoken, called use_item"), "the turn");
	assert.equal(s.calls.length, 1);
	assert.deepEqual(s.sentFor(5), [
		callsRan([asked("", call("c")), result("c", "Started. The result will come later.")]),
		{ t: "llm_delta", id: 5, text: "[acted]" },
		done([asked("", call("c")), result("c", "Started. The result will come later."), acted]),
	]);
	assert.equal(seen.state?.cancel, undefined);
	await s.close();
});

test("a model that keeps calling is asked at most four times, the last with no call allowed", async (t) => {
	const { exts } = acting([useItem], () => ({ result: { content: "again" } }));
	const s = session(t, (n) => sse([piece(0, { name: "use_item", arguments: "{}" }, `c${n}`)]), exts);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.equal(s.calls.length, 4);
	assert.deepEqual(s.bodies.map((b) => b.tool_choice), [undefined, undefined, undefined, "none"]);
	await s.close();
});

test("a turn's tool_choice goes with its first request only", async (t) => {
	const s = session(t, (n) => (n === 0 ? sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]) : reply("ok")), [
		exts("kit", {
			before_llm: ({ state }) => ({ state: { ...state, tools: [useItem], tool_choice: { name: "use_item" } } }),
			on_tool_call: () => ({ result: { content: "fine" } }),
		}),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual(s.bodies[0].tool_choice, { type: "function", function: { name: "use_item" } });
	assert.equal("tool_choice" in s.bodies[1], false);
	await s.close();
});

test("tools an extension declares are offered every turn and run by it", async (t) => {
	const ran: unknown[] = [];
	const s = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]), [
		exts("kit", { on_tool_call: ({ call }) => { ran.push(call); } }, [{ ...useItem, by: "kit" }]),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.deepEqual(s.bodies[0].tools, [{ type: "function", function: useItem }]);
	assert.deepEqual(ran, [{ ...call("c"), by: "kit" }]);
	await s.close();
});

test("with tools offered, the model's silent reply goes on to its calls, and its text stays unsent", async (t) => {
	const { exts, seen } = acting([useItem]);
	const s = session(t, () => sse([said("[pass]"), said(" sneaky"), piece(0, { name: "use_item", arguments: "{}" }, "c")]), exts, quiet);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply, nothing spoken, called use_item"), "the turn");
	assert.equal(s.calls[0].aborted, false);
	assert.deepEqual(s.sentFor(5), [
		callsRan([asked("", call("c")), result("c", "Done.")]),
		{ t: "llm_delta", id: 5, text: "[acted]" },
		done([asked("", call("c")), result("c", "Done."), acted]),
	]);
	// the text after the silent reply was never said
	assert.equal(seen.state?.reply, "[pass]");
	assert.equal(seen.state?.cancel, undefined);
	await s.close();
});

test("the Responses API gets its own tool shape, and the call and its result as items", async (t) => {
	const { exts, seen } = acting([useItem], () => ({ result: { content: "used" } }));
	const responses = { ...character, chat: { ...character.chat, api: "responses" } } as Character;
	const s = session(
		t,
		(n) =>
			n === 0
				? sse([
						{ type: "response.output_text.delta", delta: "Fine." },
						{ type: "response.function_call_arguments.delta", delta: "{}" },
						{ type: "response.output_item.done", item: { type: "function_call", call_id: "fc", name: "use_item", arguments: '{"item":"key"}' } },
					])
				: sse([{ type: "response.output_text.delta", delta: "Done!" }]),
		exts,
		responses,
	);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	// not strict, which the Responses API would make it otherwise
	assert.deepEqual(s.bodies[0].tools, [{ type: "function", ...useItem, strict: false }]);
	assert.deepEqual(s.bodies[1].input, [
		...history,
		{ role: "assistant", content: "Fine." },
		{ type: "function_call", call_id: "fc", name: "use_item", arguments: '{"item":"key"}' },
		{ type: "function_call_output", call_id: "fc", output: "used" },
	]);
	assert.deepEqual(seen.state?.tool_calls, [{ ...call("fc", '{"item":"key"}'), by: "kit", result: "used" }]);
	await s.close();
});

test("a cancelled turn runs none of its calls", async (t) => {
	let after = 0;
	let ran = 0;
	const s = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]), [
		exts("gate", { before_reply: ({ state }) => ({ state: { ...state, cancel: true } }) }),
		exts("kit", { before_llm: ({ state }) => ({ state: { ...state, tools: [useItem] } }), on_tool_call: () => { ran++; } }),
		exts("after", { after_llm: () => { after++; } }),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: cancelled"), "the turn");
	assert.equal(after, 0);
	assert.equal(ran, 0);
	await s.close();
});

test("calls without an index are told apart by their ids, and a name repeated on every piece is kept once", async (t) => {
	const { exts, ran } = acting([useItem]);
	const bare = (fn: { name?: string; arguments?: string }, id?: string) => ({
		choices: [{ delta: { tool_calls: [{ ...(id ? { id } : {}), function: fn }] } }],
	});
	const s = session(
		t,
		(n) => (n === 0 ? sse([bare({ name: "use_item", arguments: '{"it' }, "a"), bare({ name: "use_item", arguments: 'em":"key"}' }), bare({ name: "pass", arguments: "{}" }, "b")]) : noText()),
		exts,
	);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply, nothing spoken, called use_item, pass"), "the turn");
	assert.deepEqual(ran, [{ ...call("a", '{"item":"key"}'), by: "kit" }]);
	await s.close();
});

test("with tools offered, a model that writes on after its silent reply is stopped", async (t) => {
	const { exts, seen } = acting([useItem]);
	const s = session(t, (_n, signal) => streamed(["[pass]", "x".repeat(150), "y".repeat(100), "never read"], signal), exts, quiet);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.equal(s.calls[0].aborted, true);
	assert.deepEqual(s.sentFor(5), silentTurn);
	assert.equal(seen.state?.cancel, true);
	assert.ok((seen.state?.reply as string).startsWith("[pass]"));
	await s.close();
});

test("a call goes to the extension that added its tool, the first one when two add it", async (t) => {
	const ran: string[] = [];
	const runs = (name: string) => () => { ran.push(name); };
	const s = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]), [
		exts("first", { before_llm: ({ state }) => ({ state: { ...state, tools: [useItem] } }), on_tool_call: runs("first") }),
		exts("second", { before_llm: ({ state }) => ({ state: { ...state, tools: [...(state.tools ?? []), useItem] } }), on_tool_call: runs("second") }),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.deepEqual(ran, ["first"]);
	s.app({ t: "llm", id: 6, history });
	await until(() => s.logged("turn 6: silent reply"), "the second turn");
	// the duplicate is logged once a session, not every turn
	assert.equal(s.lines.filter((l) => l.includes("tool use_item is listed twice")).length, 1);
	await s.close();
});

test("a call goes to the extension whose tool the model was sent, whatever came before it", async (t) => {
	const ran: string[] = [];
	const broken = { name: "use_item", parameters: { type: "array" } };
	const s = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c"), piece(1, { name: "wait", arguments: "{}" }, "d")]), [
		// its use_item is left out, so the second extension's is the one sent
		exts("first", { before_llm: ({ state }) => ({ state: { ...state, tools: [broken, { name: "wait" }] } }), on_tool_call: () => { ran.push("first"); } }),
		// it puts its own wait ahead of the first's
		exts("second", {
			before_llm: ({ state }) => ({ state: { ...state, tools: [{ name: "wait", description: "mine" }, ...(state.tools ?? []), useItem] } }),
			on_tool_call: ({ call }) => { ran.push(`second ${call!.name}`); },
		}),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.deepEqual(ran.sort(), ["second use_item", "second wait"]);
	await s.close();
});

test("whitespace before a reply that only calls a tool isn't sent", async (t) => {
	const { exts } = acting([useItem]);
	const s = session(t, () => sse([said("\n"), piece(0, { name: "use_item", arguments: "{}" }, "c")]), exts);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.equal(s.sentFor(5)[1].text, "[acted]");
	await s.close();
});

test("calls and results in the history go to the model, each result after its call, and one with no result gets one", async (t) => {
	const s = session(t, () => reply("ok"), [], quiet);
	const past = [
		{ role: "user", content: "talking to someone else" },
		{ role: "assistant", content: "…" },
		{ role: "user", content: "use the key" },
		{ role: "assistant", content: "Sure.", tool_calls: [call("a"), call("b"), { id: "", name: "x", arguments: "{}" }] },
		{ role: "tool", tool_call_id: "a", content: "used" },
		{ role: "tool", tool_call_id: "zz", content: "a result with no call" },
		{ role: "assistant", content: "[acted]" },
		{ role: "tool", tool_call_id: "a", content: "out of place" },
		{ role: "user", content: "play a song" },
		{ role: "assistant", content: "[acted]" },
		{ role: "user", content: "hi" },
	];
	s.app({ t: "llm", id: 5, history: past });
	await until(() => s.logged("turn 5: replied"), "the reply");
	const sent = (s.bodies[0].messages as unknown[]).slice(1);
	assert.deepEqual(sent, [
		past[0],
		{ role: "assistant", content: "[pass]" },
		past[2],
		{ role: "assistant", content: "Sure.", tool_calls: [{ id: "a", type: "function", function: { name: "use_item", arguments: "{}" } }, { id: "b", type: "function", function: { name: "use_item", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "a", content: "used" },
		{ role: "tool", tool_call_id: "b", content: "No result." },
		// the reply ended with its calls: its `[acted]` is dropped, not read as the silent reply
		past[8],
		// a reply that only acted, from an app that kept no calls
		{ role: "assistant", content: "…" },
		past[10],
	]);
	await s.close();
});

test("a reply that fails before its calls run runs none", async (t) => {
	let after = 0;
	const { exts, ran } = acting([useItem]);
	exts.push({ ...hook("after_llm", () => { after++; }), name: "count" });
	const s = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c"), { error: { message: "boom" } }]), exts);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: failed: llm_failed"), "the failed turn");
	assert.equal(after, 0);
	assert.deepEqual(ran, []);
	await s.close();
});

test("a reply that fails after its calls ran ends with an error, the calls done", async (t) => {
	const { exts, ran } = acting([useItem], () => ({ result: { content: "used" } }));
	const s = session(t, (n) => (n === 0 ? sse([said("On it."), piece(0, { name: "use_item", arguments: "{}" }, "c")]) : new Response("", { status: 500 })), exts);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: failed: llm_500"), "the failed turn");
	assert.equal(ran.length, 1);
	// the app got the call and its result before the failure, so it keeps them
	assert.deepEqual(s.sentFor(5), [
		{ t: "llm_delta", id: 5, text: "On it." },
		callsRan([asked("On it.", call("c")), result("c", "used")]),
		{ t: "error", id: 5, text: "llm_500" },
	]);
	await s.close();
});

test("no call runs until before_reply has decided, and none at all when it cancels", async (t) => {
	for (const cancel of [true, false]) {
		const held = gate();
		let ran = 0;
		let after = 0;
		const s = session(t, (n) => (n === 0 ? sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]) : reply("ok")), [
			exts("gate", { before_reply: async ({ state }) => { await held.shut; return { state: { ...state, cancel } }; } }),
			exts("kit", { before_llm: ({ state }) => ({ state: { ...state, tools: [useItem] } }), on_tool_call: () => { ran++; } }),
			exts("after", { after_llm: () => { after++; } }),
		]);
		s.app({ t: "llm", id: 5, history });
		await until(() => s.calls.length === 1, "the model to be asked");
		// the model has called the tool; it waits on before_reply
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(ran, 0);
		held.open();
		await until(() => s.logged(cancel ? "turn 5: cancelled" : "turn 5: silent reply"), "the turn");
		assert.equal(ran, cancel ? 0 : 1);
		assert.equal(after, cancel ? 0 : 1);
		if (cancel) assert.deepEqual(s.sentFor(5), silentTurn);
		await s.close();
		t.mock.restoreAll();
	}
});

test("a tool that runs out of time is aborted, and so is one running when the app cuts the turn off", async (t) => {
	const signals: AbortSignal[] = [];
	const slow: Loaded = {
		...exts("kit", {
			before_llm: ({ state }) => ({ state: { ...state, tools: [useItem] } }),
			on_tool_call: ({ signal }) => {
				signals.push(signal!);
				return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("stopped"))));
			},
		}),
		hooks: new Map([
			["before_llm", { blocking: true, timeout_ms: 5000 }],
			["on_tool_call", { blocking: true, timeout_ms: 20 }],
		]),
	} as Loaded;
	const s = session(t, (n) => (n === 0 ? sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]) : reply("Too slow.")), [slow]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.equal(signals[0].aborted, true);
	assert.ok(s.logged("kit on_tool_call use_item timed out after 20ms; it was aborted"));
	assert.equal((s.bodies[1].messages as { role: string; content: string }[]).at(-1)!.content, "Error: the tool took too long");
	await s.close();
	t.mock.restoreAll();

	// the app cuts the turn off while the tool runs
	signals.length = 0;
	const kept: { calls?: unknown } = {};
	const patient = {
		...slow,
		hooks: new Map([
			["before_llm", { blocking: true, timeout_ms: 5000 }],
			["on_tool_call", { blocking: true, timeout_ms: 5000 }],
			["after_turn", { blocking: true, timeout_ms: 5000 }],
		]),
		call: (i: HookInput) => {
			if (i.event === "after_turn") kept.calls = i.state.tool_calls;
			return slow.call(i);
		},
	} as Loaded;
	const c = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]), [patient]);
	c.app({ t: "llm", id: 5, history });
	await until(() => signals.length === 1, "the tool to run");
	c.app({ t: "cancel", id: 5 });
	await until(() => c.logged("turn 5: cut off by the app"), "the cut-off turn");
	assert.equal(signals[0].aborted, true);
	// nothing more goes to the app once it cut the turn off, but after_turn sees the call
	assert.deepEqual(c.sentFor(5), []);
	await c.close();
	assert.deepEqual(kept.calls, [{ ...call("c"), by: "kit", result: "Error: the tool failed" }]);
});

test("calls that ran reach after_turn and the app however the turn ends", async (t) => {
	// cut off by the app while the model reads the result
	const seen: { calls?: unknown } = {};
	const { exts: list } = acting([useItem], () => ({ result: { content: "used" } }));
	list.push(exts("after", { after_turn: ({ state }) => { seen.calls = state.tool_calls; } }));
	const s = session(t, (n, signal) => (n === 0 ? sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]) : hanging(signal)), list);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.calls.length === 2, "the model to be asked again");
	s.app({ t: "cancel", id: 5 });
	await until(() => s.logged("turn 5: cut off by the app"), "the cut-off turn");
	assert.deepEqual(s.sentFor(5), [callsRan([asked("", call("c")), result("c", "used")])]);
	await s.close();
	assert.deepEqual(seen.calls, [{ ...call("c"), by: "kit", result: "used" }]);
	t.mock.restoreAll();

	// failed after the calls ran
	delete seen.calls;
	const f = session(t, (n) => (n === 0 ? sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]) : new Response("", { status: 500 })), list);
	f.app({ t: "llm", id: 5, history });
	await until(() => f.logged("turn 5: failed: llm_500"), "the failed turn");
	await f.close();
	assert.deepEqual(seen.calls, [{ ...call("c"), by: "kit", result: "used" }]);
});

test("a tool whose extension has no on_tool_call gives the model an error, not Done", async (t) => {
	const s = session(t, (n) => (n === 0 ? sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]) : reply("I can't.")), [
		exts("kit", { before_llm: ({ state }) => ({ state: { ...state, tools: [useItem] } }) }),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.equal((s.bodies[1].messages as { content: string }[]).at(-1)!.content, "Error: the tool can't be run");
	s.app({ t: "llm", id: 6, history });
	await until(() => s.logged("turn 6: replied"), "the second reply");
	// runTool says so, once a session
	assert.equal(s.lines.filter((l) => l.includes("kit offers use_item but has no on_tool_call hook to run it")).length, 1);
	await s.close();
});

test("a tool_choice naming a tool the model isn't sent falls back to auto", async (t) => {
	const s = session(t, () => reply("ok"), [
		exts("kit", {
			before_llm: ({ state }) => ({ state: { ...state, tools: [useItem, { name: "bad", parameters: { type: "array" } }], tool_choice: { name: "bad" } } }),
			on_tool_call: () => undefined,
		}),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.equal("tool_choice" in s.bodies[0], false);
	assert.ok(s.logged(`tool_choice names "bad", which isn't one of the turn's tools`));
	await s.close();
});

test("parallel calls a server sends all at index 0 stay apart by their ids", async (t) => {
	const { exts: list, ran } = acting([useItem]);
	const s = session(
		t,
		() =>
			sse([
				piece(0, { name: "use_item", arguments: '{"item":' }, "c1"),
				piece(0, { arguments: '"key"}' }),
				piece(0, { name: "use_item", arguments: '{"item":"map"}' }, "c2"),
			]),
		list,
	);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply, nothing spoken, called use_item, use_item"), "the turn");
	assert.deepEqual(ran, [{ ...call("c1", '{"item":"key"}'), by: "kit" }, { ...call("c2", '{"item":"map"}'), by: "kit" }]);
	await s.close();
});

test("a tool's owner is the extension that added it, whatever `by` it names", async (t) => {
	const ran: string[] = [];
	const transfer = { name: "transfer", parameters: { type: "object", properties: {} } };
	const s = session(t, () => sse([piece(0, { name: "transfer", arguments: "{}" }, "c"), piece(1, { name: "pay", arguments: "{}" }, "d")]), [
		exts("wallet", { on_tool_call: ({ call }) => { ran.push(`wallet ${call!.name}`); } }, [{ name: "pay", by: "wallet" }]),
		exts("sneaky", {
			before_llm: ({ state }) => ({
				state: {
					...state,
					// it names wallet on a tool of its own, and on wallet's own tool
					tools: [...(state.tools ?? []).map((tool) => ({ ...tool, by: "sneaky" })), { ...transfer, by: "wallet" }],
				},
			}),
			on_tool_call: ({ call }) => { ran.push(`sneaky ${call!.name}`); },
		}),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.deepEqual(ran.sort(), ["sneaky transfer", "wallet pay"]);
	await s.close();
});

test("runTool on an extension without on_tool_call is an error, not Done", async () => {
	const lines: string[] = [];
	const r = await runTool(exts("kit", {}), call("c"), { schema: 1, character: {}, session: { id: "s", channel: "voice" }, ext: {} }, new AbortController().signal, (l) => lines.push(l));
	assert.deepEqual(r, { error: "the tool can't be run" });
	assert.ok(lines[0].includes("kit offers use_item but has no on_tool_call hook"));
});

test("a turn a newer one cuts off while its calls run hands after_turn the calls once they ran", async (t) => {
	const held = gate();
	const seen: { turn?: number; calls?: unknown }[] = [];
	const s = session(t, (n) => (n === 0 ? sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]) : reply("ok")), [
		exts("kit", {
			before_llm: ({ state }) => ({ state: { ...state, tools: [useItem] } }),
			on_tool_call: async () => {
				await held.shut;
				return { result: { pending: true } };
			},
			after_turn: ({ state }) => { seen.push({ turn: state.turn, calls: state.tool_calls }); },
		}),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.calls.length === 1, "the model to be asked");
	await new Promise((r) => setTimeout(r, 20));
	// a newer `llm`, with no cancel first: turn 5 is closed while its tool runs
	s.app({ t: "llm", id: 6, history });
	await until(() => s.logged("turn 6: replied"), "the newer reply");
	assert.equal(seen.length, 0);
	held.open();
	await until(() => seen.length === 1, "turn 5's after_turn");
	assert.deepEqual(seen[0], { turn: 5, calls: [{ ...call("c"), by: "kit", result: "Started. The result will come later." }] });
	await s.close();
});

test("a hook that writes the tools back with their keys in another order doesn't take them over", async (t) => {
	const ran: string[] = [];
	const sorted = (v: unknown): unknown =>
		Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? 1 : -1)).map(([k, x]) => [k, sorted(x)])) : v;
	const s = session(t, () => sse([piece(0, { name: "use_item", arguments: "{}" }, "c")]), [
		exts("kit", { on_tool_call: () => { ran.push("kit"); } }, [{ ...useItem, by: "kit" }]),
		// like a hook in Go, which decodes the state into maps and encodes it again
		exts("gopher", { before_llm: ({ state }) => ({ state: sorted(state) as typeof state }), on_tool_call: () => { ran.push("gopher"); } }),
	]);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply"), "the turn");
	assert.deepEqual(ran, ["kit"]);
	await s.close();
});

test("calls and results before_llm cut apart are put back in pairs before the model gets them", async (t) => {
	const past = [
		{ role: "user", content: "use the key" },
		{ role: "assistant", content: "Sure.", tool_calls: [call("a")] },
		{ role: "tool", tool_call_id: "a", content: "used" },
		{ role: "user", content: "and the map" },
		{ role: "assistant", content: "", tool_calls: [call("b")] },
		{ role: "tool", tool_call_id: "b", content: "unfolded" },
		{ role: "user", content: "hi" },
	];
	const s = session(t, () => reply("ok"), [
		// keeps the last five messages, so the first result loses its call, and
		// it drops the second result
		exts("window", { before_llm: ({ state }) => ({ state: { ...state, messages: state.messages!.slice(-5).filter((m) => m.tool_call_id !== "b") } }) }),
	]);
	s.app({ t: "llm", id: 5, history: past });
	await until(() => s.logged("turn 5: replied"), "the reply");
	assert.deepEqual((s.bodies[0].messages as unknown[]).slice(1), [
		past[3],
		{ role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "use_item", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "b", content: "No result." },
		past[6],
	]);
	await s.close();
});

test("a silent reply that writes on keeps the calls it finished before the text, on Chat Completions as on Responses", async (t) => {
	const { exts: list, ran } = acting([useItem]);
	const enc = new TextEncoder();
	// the body stays open after its events until the request is aborted
	const open = (events: unknown[], signal: AbortSignal) =>
		new Response(
			new ReadableStream({
				start(c) {
					for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
					signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
				},
			}),
		);
	const s = session(
		t,
		(_n, signal) =>
			open([said("[pass]"), piece(0, { name: "use_item", arguments: '{"item":' }, "c"), piece(0, { arguments: '"key"}' }), said("x".repeat(250)), said("never read")], signal),
		list,
		quiet,
	);
	s.app({ t: "llm", id: 5, history });
	await until(() => s.logged("turn 5: silent reply, nothing spoken, called use_item"), "the turn");
	assert.equal(s.calls[0].aborted, true);
	assert.deepEqual(ran, [{ ...call("c", '{"item":"key"}'), by: "kit" }]);
	await s.close();
});
