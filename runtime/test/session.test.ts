// How the session merges what overlapping hooks wrote to `ext`, and how it
// keeps each reply and sentence apart from others on the same id, driven over
// a fake socket with a fake `fetch`. Run with `npm test`.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
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
	// what had arrived when the model was stopped
	assert.equal(seen, "[pass] but");
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
