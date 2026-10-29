// The reactions extension (extensions/reactions): one judge call on
// before_reply, a beat on the reply's first sentence. The judge is never
// called: `fetch` is replaced. Run with `npm test`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { parse } from "yaml";
import reactions, { check, decide, judgement, kept, resolve, strength, type Answer, type Judgement } from "../../extensions/reactions/index.ts";
import { bodyOf } from "../src/check.ts";
import { ACTED_TURN } from "../src/markers.ts";
import { runHook, type Loaded } from "../src/extensions.ts";
import { loadCharacter, type HookOptions } from "../src/manifest.ts";
import type { HookName, State } from "../src/state.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const example = () => parse(readFileSync(path.join(ROOT, "extensions/reactions/example.yaml"), "utf8")) as Record<string, unknown>;

const realFetch = globalThis.fetch;
const KEY = "TEST_REACTIONS_KEY";
let sessions = 0;
afterEach(async () => {
	globalThis.fetch = realFetch;
	delete process.env[KEY];
});

// a config that uses the test key
const config = (more: Record<string, unknown> = {}) => ({ ...example(), model: { api_key_env: KEY }, ...more });

// a judgement with a plain, strong delight, to change one thing at a time
const judged = (j: Partial<Judgement> = {}): Judgement => ({
	beat: { choice: "delight", confidence: 0.9 },
	settle: { choice: "warm", confidence: 0.8 },
	gesture: { choice: "still", confidence: 0.9 },
	intensity: 0.6,
	guarded: 0,
	amused: 0,
	personal: 0,
	...j,
});

// answers shaped like the judge's, extra fields and all
function answers(j: { beat?: string; beatConf?: number; settle?: string; settleConf?: number; gesture?: string; gestureConf?: number; intensity?: number; amused?: number } = {}) {
	const choice = (c: string, conf: number) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf } });
	// a score's probabilities split between the levels either side of it, so they agree
	const level = (s: number) => {
		const lo = Math.floor(s);
		const hi = Math.min(4, lo + 1);
		return { type: "score", score: s, confidence: 0.6, legend: { 0: "…" }, probabilities: lo === hi ? { [lo]: 1 } : { [lo]: hi - s, [hi]: s - lo } };
	};
	return {
		beat: choice(j.beat ?? "delight", j.beatConf ?? 0.9),
		settle: choice(j.settle ?? "warm", j.settleConf ?? 0.8),
		gesture: choice(j.gesture ?? "still", j.gestureConf ?? 0.9),
		intensity: level(j.intensity ?? 2.6),
		guarded: { type: "noul", noul: 0.1 },
		amused: { type: "noul", noul: j.amused ?? 0.1 },
		personal: { type: "noul", noul: 0.1 },
	};
}

// replaces fetch with one that answers `body` and records what it was asked
function judge(body: unknown, status = 200) {
	const calls: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	}) as typeof fetch;
	return calls;
}

// a turn's state for one session; each test gets sessions of its own
const newSession = () => `s${++sessions}`;
const state = (session: string, turn: number, more: Partial<State> = {}): State => ({
	schema: 1,
	character: { name: "Test", description: "A test character." },
	session: { id: session, channel: "voice" },
	turn,
	input: { text: "I finally finished my first song!", channel: "voice" },
	messages: [
		{ role: "assistant", content: "Hi!" },
		{ role: "user", content: "I finally finished my first song!" },
	],
	ext: {},
	...more,
});
const sentence = async (session: string, turn: number, text = "No way!", cfg = config()) => {
	const out = await reactions({ event: "on_sentence", state: state(session, turn, { sentence: text, beats: [] }), config: cfg });
	return (out?.state.beats ?? []) as unknown[];
};

// ---- choosing the beat ----

test("a strong reaction is the emotion the reply starts with, with no gesture unless the judge is sure", () => {
	const c = resolve(config());
	assert.deepEqual(decide(judged(), c), { span: "", emotion: "happy" });
	assert.deepEqual(decide(judged({ beat: { choice: "lit_up", confidence: 0.8 }, gesture: { choice: "cheer", confidence: 0.9 } }), c), {
		span: "",
		emotion: "sparkle eyes",
		gesture: "cheer",
	});
});

test("how strong a reaction is: a guarded one shows less, one about the character shows more", () => {
	const open = strength(judged());
	near(open, 0.14 + 1.05 * 0.6);
	near(strength(judged({ guarded: 1 })), open * 0.45);
	near(strength(judged({ personal: 1 })), open * 1.2);
	assert.equal(strength(judged({ intensity: 1, personal: 1 })), 1.4);
	// out of range numbers stay in range
	assert.equal(strength(judged({ intensity: 7, personal: 9 })), 1.4);
});

test("a mild or unsure reaction gives way to the mood, and a light line to nothing", () => {
	const c = resolve(config());
	// mild: strength under 0.55
	assert.equal(decide(judged({ intensity: 0.35 }), c)?.emotion, "warm");
	// unsure of the reaction
	assert.equal(decide(judged({ beat: { choice: "delight", confidence: 0.3 } }), c)?.emotion, "warm");
	// a guarded one doesn't show as itself
	assert.equal(decide(judged({ guarded: 1 }), c)?.emotion, "warm");
	// the mood needs confidence, and a message that moved the character
	assert.equal(decide(judged({ intensity: 0.35, settle: { choice: "warm", confidence: 0.1 } }), c), null);
	assert.equal(decide(judged({ intensity: 0.2 }), c), null);
	// "nothing" has no emotion: the mood it is
	assert.equal(decide(judged({ beat: { choice: "nothing", confidence: 0.9 } }), c)?.emotion, "warm");
});

test("a really funny line laughs, whatever the reaction", () => {
	const c = resolve(config());
	assert.equal(decide(judged({ beat: { choice: "tease", confidence: 0.9 }, amused: 0.82 }), c)?.emotion, "happy");
	assert.equal(decide(judged({ beat: { choice: "tease", confidence: 0.9 }, amused: 0.8 }), c)?.emotion, "playful");
	// without a laugh configured, the reaction it is
	assert.equal(decide(judged({ beat: { choice: "tease", confidence: 0.9 }, amused: 0.95 }), resolve(config({ laugh: null })))?.emotion, "playful");
});

test("a gesture plays only when it isn't still, the judge is sure, and the message moved the character or it's a sure one", () => {
	const c = resolve(config());
	const gesture = (j: Partial<Judgement>) => decide(judged(j), c)?.gesture;
	assert.equal(gesture({ gesture: { choice: "cheer", confidence: 0.8 } }), "cheer");
	assert.equal(gesture({ gesture: { choice: "still", confidence: 0.9 } }), undefined);
	assert.equal(gesture({ gesture: { choice: "cheer", confidence: 0.6 } }), undefined);
	assert.equal(gesture({ gesture: { choice: "cheer", confidence: 0.8 }, intensity: 0.3 }), undefined);
	// a wave at hello: no emotion, just the gesture
	assert.deepEqual(decide(judged({ intensity: 0.02, beat: { choice: "nothing", confidence: 0.5 }, gesture: { choice: "wave", confidence: 0.98 } }), c), {
		span: "",
		gesture: "wave",
	});
});

test("the thresholds come from the config", () => {
	const c = resolve(config({ thresholds: { strong: 1.2, gesture: 0.5 } }));
	assert.deepEqual(decide(judged({ gesture: { choice: "nod", confidence: 0.6 } }), c), { span: "", emotion: "warm", gesture: "nod" });
});

test("the judge's answers are read as levels and probabilities", () => {
	const c = resolve(config());
	const j = judgement(answers({ intensity: 2.64, amused: 0.7 }) as Record<string, Answer>, c)!;
	near(j.intensity, 0.66);
	near(j.amused, 0.7);
	// no `score`: the weighted level from the probabilities, ignoring ones that aren't
	near(judgement({ ...answers(), intensity: { probabilities: { "2": 0.5, "4": 0.5, "0": -3, "1": Number.NaN } } } as Record<string, Answer>, c)!.intensity, 0.75);
	assert.equal(judgement({ ...answers(), intensity: { score: 9 } } as Record<string, Answer>, c)!.intensity, 1);
	// an option it doesn't have: the likeliest one it does, as sure as its own probability
	const picked = judgement({ ...answers(), beat: { choice: "dance", confidence: 0.9, probabilities: { delight: 0.4, tease: 0.3 } } } as Record<string, Answer>, c)!;
	assert.deepEqual(picked.beat, { choice: "delight", confidence: 0.4 });
	// the fixture's probabilities say the same as its score
	near(judgement({ ...answers({ intensity: 2.6 }), intensity: { probabilities: answers({ intensity: 2.6 }).intensity.probabilities } } as Record<string, Answer>, c)!.intensity, 0.65);
	// a yes/no answer as a number, as true/false probabilities, or as a boolean
	const amused = (a: unknown) => judgement({ ...answers(), amused: a } as Record<string, Answer>, c)!.amused;
	near(amused({ type: "noul", noul: 0.7 }), 0.7);
	near(amused({ probabilities: { true: 0.3, false: 0.7 } }), 0.3);
	near(amused({ probabilities: { false: 0.6 } }), 0.4);
	assert.equal(amused({ noul: true }), 1);
	assert.equal(amused({ noul: false }), 0);
	assert.equal(amused({ noul: "yes" }), 0);
	// no usable reaction or intensity: no judgement
	assert.equal(judgement({ ...answers(), beat: { choice: "dance", confidence: 1 } } as Record<string, Answer>, c), null);
	assert.equal(judgement({ beat: answers().beat } as Record<string, Answer>, c), null);
});

// ---- the turn ----

test("before_reply asks the judge once, and the reply's first sentence gets the beat", async () => {
	process.env[KEY] = "secret";
	const calls = judge({ answers: answers({ gesture: "cheer", gestureConf: 0.9 }), usage: {} });
	const s = newSession();
	assert.equal(await reactions({ event: "before_reply", state: state(s, 1), config: config() }), undefined);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
	assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret");
	const body = JSON.parse(String(calls[0].init.body));
	assert.equal(body.model, "jev-latest");
	assert.deepEqual(Object.keys(body.questions).sort(), ["amused", "beat", "gesture", "guarded", "intensity", "personal", "settle"]);
	assert.ok("still" in body.questions.gesture.criteria);
	assert.match(body.questions.personal.instructions, /about Test/);
	assert.equal(body.state.message, "I finally finished my first song!");
	assert.deepEqual(body.state.conversation, [{ role: "assistant", content: "Hi!" }]);
	assert.match(body.state.character.about, /popstar/);

	assert.deepEqual(await sentence(s, 1), [{ span: "", emotion: "happy", gesture: "cheer" }]);
	// later sentences of the turn get nothing
	assert.deepEqual(await sentence(s, 1, "Tell me everything."), []);
});

test("another turn or session gets nothing, and a newer turn drops the older one's decision", async () => {
	process.env[KEY] = "secret";
	judge({ answers: answers() });
	const s = newSession();
	await reactions({ event: "before_reply", state: state(s, 1), config: config() });
	assert.deepEqual(await sentence(newSession(), 1), []);
	assert.deepEqual(await sentence(s, 2), []);
	await reactions({ event: "before_reply", state: state(s, 2, { input: { text: "", channel: "voice" } }), config: config() });
	assert.deepEqual(await sentence(s, 1), []);
	assert.deepEqual(await sentence(s, 2), []);
});

test("nothing decided is no beat", async () => {
	process.env[KEY] = "secret";
	judge({ answers: answers({ beat: "nothing", intensity: 0.1, settleConf: 0.1 }) });
	const s = newSession();
	await reactions({ event: "before_reply", state: state(s, 1), config: config() });
	assert.deepEqual(await sentence(s, 1), []);
});

test("an answer after the first sentence went out is dropped", async () => {
	process.env[KEY] = "secret";
	let answer!: () => void;
	globalThis.fetch = (() =>
		new Promise<Response>((r) => {
			answer = () => r(new Response(JSON.stringify({ answers: answers() })));
		})) as typeof fetch;
	const s = newSession();
	const asking = reactions({ event: "before_reply", state: state(s, 1), config: config() });
	await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(await sentence(s, 1), []);
	answer();
	await asking;
	assert.deepEqual(await sentence(s, 1), []);
});

test("a failed, late or malformed answer is no beat, and the turn goes on", async () => {
	process.env[KEY] = "secret";
	const cfg = config({ model: { api_key_env: KEY, timeout_ms: 50 } });
	const ext: Loaded = {
		name: "reactions",
		dir: path.join(ROOT, "extensions/reactions"),
		handler: "index.ts",
		hooks: new Map<HookName, HookOptions>([["before_reply", { blocking: true, timeout_ms: 1500 }]]),
		service: false,
		tools: [],
		requires_env: [KEY],
		config: cfg,
		call: reactions as Loaded["call"],
	};
	const run = async () => {
		const lines: string[] = [];
		const s = newSession();
		const out = await runHook([ext], "before_reply", state(s, 1), (l) => lines.push(l));
		assert.equal(out.cancel, undefined);
		assert.deepEqual(await sentence(s, 1, "Hm.", cfg), []);
		assert.doesNotMatch(lines.join("\n"), /secret/);
		return lines.join("\n");
	};
	judge({ error: "nope" }, 500);
	assert.match(await run(), /HTTP 500/);
	judge("not json");
	assert.match(await run(), /isn't JSON/);
	judge({ answers: { beat: { choice: "delight" } } });
	assert.match(await run(), /missing/);
	globalThis.fetch = ((_: string, init: RequestInit) =>
		new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
	assert.match(await run(), /didn't answer in 50 ms/);
	globalThis.fetch = (async () => {
		throw new Error("connect ECONNREFUSED");
	}) as typeof fetch;
	assert.match(await run(), /couldn't be reached/);
});

test("no key, no message or a cancelled turn is no call", async () => {
	const calls = judge({ answers: answers() });
	await assert.rejects(reactions({ event: "before_reply", state: state(newSession(), 1), config: config() }), /TEST_REACTIONS_KEY isn't set/);
	process.env[KEY] = "secret";
	await reactions({ event: "before_reply", state: state(newSession(), 1, { input: { text: " ", channel: "voice" } }), config: config() });
	await reactions({ event: "before_reply", state: state(newSession(), 1, { input: { text: 5 as never, channel: "voice" } }), config: config() });
	const s = newSession();
	await reactions({ event: "before_reply", state: state(s, 1, { cancel: true }), config: config() });
	assert.equal(calls.length, 0);
	assert.deepEqual(await sentence(s, 1), []);
});

test("what goes to the judge is bounded", async () => {
	process.env[KEY] = "secret";
	const calls = judge({ answers: answers() });
	const long = "x".repeat(10_000);
	const history = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: long }));
	const cfg = config({ context: 500, about: long, model: { api_key_env: KEY, base_url: "https://example.invalid/v1///" } });
	await reactions({
		event: "before_reply",
		state: state(newSession(), 1, { character: { name: long, description: long }, input: { text: long, channel: "voice" }, messages: [...history, { role: "user", content: long }] }),
		config: cfg,
	});
	assert.equal(calls[0].url, "https://example.invalid/v1/systemone");
	const body = JSON.parse(String(calls[0].init.body));
	assert.equal(body.state.message.length, 4001);
	assert.equal(body.state.conversation.length, 50);
	assert.ok(body.state.conversation.every((m: { content: string }) => m.content.length === 1001));
	assert.equal(body.state.character.name.length, 201);
	assert.equal(body.state.character.description.length, 1001);
	assert.equal(body.state.character.about.length, 2001);
	assert.ok(String(calls[0].init.body).length < 80_000);
});

test("an answer that's too large is refused, whether it says so or not", async () => {
	process.env[KEY] = "secret";
	const big = JSON.stringify({ answers: answers(), padding: "x".repeat(70_000) });
	const run = async () => {
		const lines: string[] = [];
		const s = newSession();
		const ext: Loaded = {
			name: "reactions",
			dir: path.join(ROOT, "extensions/reactions"),
			handler: "index.ts",
			hooks: new Map<HookName, HookOptions>([["before_reply", { blocking: true, timeout_ms: 1500 }]]),
			service: false,
			tools: [],
			requires_env: [KEY],
			config: config(),
			call: reactions as Loaded["call"],
		};
		await runHook([ext], "before_reply", state(s, 1), (l) => lines.push(l));
		assert.deepEqual(await sentence(s, 1), []);
		return lines.join("\n");
	};
	// with its length up front
	globalThis.fetch = (async () => new Response(big, { headers: { "content-length": String(big.length) } })) as typeof fetch;
	assert.match(await run(), /too large/);
	// streamed, with no length
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream({
				start(c) {
					for (let i = 0; i < big.length; i += 8192) c.enqueue(new TextEncoder().encode(big.slice(i, i + 8192)));
					c.close();
				},
			}),
		)) as typeof fetch;
	assert.match(await run(), /too large/);
});

test("the judge never gets longer than the hook", async () => {
	process.env[KEY] = "secret";
	assert.equal(resolve(config({ model: { api_key_env: KEY, timeout_ms: 5000 } })).timeoutMs, 1400);
	const body = { emotions: null, gestures: null };
	assert.match(check({ config: config({ model: { api_key_env: KEY, timeout_ms: 1500 } }), body }).warnings!.join("\n"), /timeout_ms/);
	assert.deepEqual(check({ config: config({ model: { api_key_env: KEY, timeout_ms: 1000 } }), body }).warnings, []);
});

test("a session that ends is forgotten", async () => {
	process.env[KEY] = "secret";
	judge({ answers: answers() });
	const s = newSession();
	await reactions({ event: "before_reply", state: state(s, 1), config: config() });
	const before = kept();
	await reactions({ event: "on_session_end", state: state(s, 1), config: config() });
	assert.equal(kept(), before - 1);
	assert.deepEqual(await sentence(s, 1), []);
});

// ---- its check ----

test("the example config fits FoxGlove's body", () => {
	const body = bodyOf(loadCharacter(path.join(ROOT, "characters/foxglove")), { ok: [], errors: [], warnings: [] });
	assert.deepEqual(check({ config: example(), body }), { errors: [], warnings: [] });
});

test("the check refuses a config it can't use and warns about words the character doesn't have", () => {
	const body = { emotions: ["happy", "warm"], gestures: ["wave"] };
	const errors = (c: unknown) => check({ config: c, body }).errors;
	assert.match(errors({ beat: { a: "happy", b: "" } }).join("\n"), /model/);
	assert.match(errors(config({ beat: undefined })).join("\n"), /`beat` is required/);
	assert.match(errors(config({ beat: { delight: "happy" } })).join("\n"), /at least two/);
	assert.match(errors(config({ beat: { delight: "happy", dance: "happy" } })).join("\n"), /`beat.dance` needs a `rubric`/);
	assert.match(errors(config({ thresholds: { laugh: 2 } })).join("\n"), /thresholds.laugh/);
	assert.match(errors(config({ thresholds: { speed: 0.5 } })).join("\n"), /isn't a threshold/);
	assert.match(errors(config({ gestures: { still: "x" } })).join("\n"), /still/);
	assert.match(errors(config({ laugh: {} })).join("\n"), /laugh.emotion/);
	assert.deepEqual(errors(config({ beat: { delight: "happy", dance: { emotion: "happy", rubric: "Dancing." } } })), []);

	const warnings = check({ config: config(), body }).warnings!.join("\n");
	assert.match(warnings, /emotion .*"sparkle eyes"/);
	assert.match(warnings, /gesture .*"cheer"/);
	assert.doesNotMatch(warnings, /"warm"|"wave"/);
});

function near(a: number | undefined, b: number, tolerance = 0.01) {
	assert.ok(a !== undefined && Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);
}

test("the judge reads what was said, not calls, their results or a reply that only acted", async () => {
	process.env[KEY] = "secret";
	const calls = judge({ answers: answers() });
	const messages = [
		{ role: "user", content: "play something" },
		{ role: "assistant", content: "", tool_calls: [{ id: "c", name: "play_song", arguments: "{}" }] },
		{ role: "tool", tool_call_id: "c", content: "Done." },
		{ role: "assistant", content: ACTED_TURN },
		{ role: "user", content: "nice" },
		{ role: "assistant", content: "Here's another.", tool_calls: [{ id: "d", name: "play_song", arguments: "{}" }] },
		{ role: "tool", tool_call_id: "d", content: "Done." },
		{ role: "assistant", content: ` ${ACTED_TURN} ` },
		{ role: "user", content: "I finally finished my first song!" },
	];
	await reactions({ event: "before_reply", state: state(newSession(), 1, { messages: messages as State["messages"] }), config: config() });
	const body = JSON.parse(String(calls[0].init.body));
	assert.deepEqual(body.state.conversation, [
		{ role: "user", content: "play something" },
		{ role: "user", content: "nice" },
		{ role: "assistant", content: "Here's another." },
	]);
});
