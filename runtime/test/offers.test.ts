// Services and offers: a service runs for the session and keeps its data where
// the hooks see it, and an offer waits for the player's voice to be free, goes
// out over the offers link, and becomes a turn the player sends back. Driven
// over a fake session socket and a fake link. Run with `npm test`.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import type { HookInput, Loaded, ServiceContext } from "../src/extensions.ts";
import type { Character } from "../src/manifest.ts";
import { LinkServer, Offers, OFFER_ACK_MS, OFFER_TEXT_MAX, pendingResultText, type LinkHub } from "../src/offers.ts";
import { runSession } from "../src/session.ts";
import type { HookName, State } from "../src/state.ts";

type LinkMessage = Parameters<Parameters<LinkHub["subscribe"]>[0]>[0];

// The player's end of the offers link: what the runtime sent, and `player` to answer.
function fakeHub() {
	const listeners = new Set<(m: LinkMessage) => void>();
	let ids = 0;
	const hub = {
		open: true,
		sent: [] as Record<string, unknown>[],
		isOpen: () => hub.open,
		send: (obj: unknown) => {
			if (!hub.open) return false;
			hub.sent.push(obj as Record<string, unknown>);
			return true;
		},
		nextId: () => ++ids,
		subscribe: (fn: (m: LinkMessage) => void) => {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		},
		player: (m: LinkMessage) => { for (const fn of [...listeners]) fn(m); },
		offers: () => hub.sent.filter((m) => m.t === "offer"),
	};
	return hub;
}

async function until(done: () => boolean, what: string, ms = 2000) {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 1));
	}
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an offer waits for the voice to be free, then goes out with the epoch the player reported", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const outcome = o.offer({ text: "  @ana asked: hi?  ", source: "chat", quiet_ms: 0 }, "chat");
	hub.player({ t: "status", voice: "listening", epoch: 3 });
	await pause(5);
	assert.deepEqual(hub.offers(), []);
	hub.player({ t: "status", voice: "idle", epoch: 4 });
	await until(() => hub.offers().length === 1, "the offer");
	assert.deepEqual(hub.offers()[0], { t: "offer", id: 1, epoch: 4, text: "@ana asked: hi?" });
	hub.player({ t: "ack", id: 1, accepted: true });
	assert.equal(await outcome, "accepted");
	// the turn the player sends back for it names where it came from, once
	assert.equal(o.take("someone else")?.by, undefined);
	assert.deepEqual({ ...o.take("@ana asked: hi?"), at: 0 }, { text: "@ana asked: hi?", source: "chat", by: "chat", at: 0 });
	assert.equal(o.take("@ana asked: hi?"), undefined);
	o.close();
});

test("an offer waits for the voice to have been quiet for its quiet_ms", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	void o.offer({ text: "hello", quiet_ms: 60 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await pause(20);
	assert.equal(hub.offers().length, 0);
	await until(() => hub.offers().length === 1, "the quiet to be long enough");
	o.close();
});

test("a refused offer waits for the next quiet moment, and goes out again", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const outcome = o.offer({ text: "hello", quiet_ms: 0 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 1 });
	await until(() => hub.offers().length === 1, "the offer");
	// someone spoke just before it landed
	hub.player({ t: "ack", id: 1, accepted: false });
	hub.player({ t: "status", voice: "listening", epoch: 2 });
	await pause(5);
	assert.equal(hub.offers().length, 1);
	hub.player({ t: "status", voice: "idle", epoch: 2 });
	await until(() => hub.offers().length === 2, "the offer again");
	assert.equal(hub.offers()[1].epoch, 2);
	hub.player({ t: "ack", id: 2, accepted: true });
	assert.equal(await outcome, "accepted");
	o.close();
});

test("an accepted offer holds the next one until its turn has started and ended", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	void o.offer({ text: "one", quiet_ms: 0 }, "x");
	const second = o.offer({ text: "two", quiet_ms: 0 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "the first offer");
	hub.player({ t: "ack", id: 1, accepted: true });
	await pause(10);
	// still idle: the player has not started the first one's turn yet
	assert.equal(hub.offers().length, 1);
	hub.player({ t: "status", voice: "thinking", epoch: 1 });
	hub.player({ t: "status", voice: "idle", epoch: 1 });
	await until(() => hub.offers().length === 2, "the second offer");
	hub.player({ t: "ack", id: 2, accepted: true });
	assert.equal(await second, "accepted");
	o.close();
});

test("the highest priority goes first, then the oldest; an offer past its ttl expires", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const late = o.offer({ text: "late", quiet_ms: 0, ttl_ms: 20 }, "x");
	void o.offer({ text: "low", quiet_ms: 0 }, "x");
	void o.offer({ text: "high", quiet_ms: 0, priority: 5 }, "x");
	assert.equal(await late, "expired");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "an offer");
	assert.equal(hub.offers()[0].text, "high");
	o.close();
});

test("without a link, or after it closes, offers wait; closing the session ends them", async () => {
	const hub = fakeHub();
	hub.open = false;
	const o = new Offers(hub, () => {});
	const outcome = o.offer({ text: "hello", quiet_ms: 0 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await pause(10);
	assert.deepEqual(hub.sent, []);
	hub.player("closed");
	assert.equal(o.voice, "offline");
	o.close();
	assert.equal(await outcome, "closed");
	assert.equal(await o.offer({ text: "again" }, "x"), "closed");
});

test("a refusal decided against a status the runtime already has doesn't hold the next offer back", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	void o.offer({ text: "hello", quiet_ms: 0 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 1 });
	await until(() => hub.offers().length === 1, "the offer");
	// the player's own order: a blip of voice, its statuses, then the refusal
	hub.player({ t: "status", voice: "listening", epoch: 2 });
	hub.player({ t: "status", voice: "idle", epoch: 2 });
	hub.player({ t: "ack", id: 1, accepted: false });
	await until(() => hub.offers().length === 2, "the offer again, with no further status");
	assert.equal(hub.offers()[1].epoch, 2);
	o.close();
});

test("an ack that comes late still counts: the offer is taken once, not offered again", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const outcome = o.offer({ text: "hello", quiet_ms: 0 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "the offer");
	await pause(OFFER_ACK_MS + 50);
	// no answer counts as refused, so it waits for a status rather than going out again
	assert.equal(hub.offers().length, 1);
	hub.player({ t: "ack", id: 1, accepted: true });
	assert.equal(await outcome, "accepted");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await pause(10);
	assert.equal(hub.offers().length, 1);
	assert.equal(o.take("hello")?.by, "x");
	o.close();
});

test("an offer whose signal is aborted leaves the queue, and the next one goes out", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	assert.equal(await o.offer({ text: "too late", signal: AbortSignal.abort() }, "x"), "withdrawn");
	const ac = new AbortController();
	const old = o.offer({ text: "old", quiet_ms: 0, priority: 2, signal: ac.signal }, "x");
	const next = o.offer({ text: "new", quiet_ms: 0, priority: 1 }, "x");
	ac.abort();
	assert.equal(await old, "withdrawn");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "the offer");
	assert.equal(hub.offers()[0].text, "new");
	hub.player({ t: "ack", id: 1, accepted: true });
	assert.equal(await next, "accepted");
	o.close();
});

test("an offer withdrawn while the player has it is over if refused, and taken if accepted", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const ac = new AbortController();
	const refused = o.offer({ text: "one", quiet_ms: 0, signal: ac.signal }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "the offer");
	ac.abort();
	hub.player({ t: "ack", id: 1, accepted: false });
	assert.equal(await refused, "withdrawn");
	hub.player({ t: "status", voice: "idle", epoch: 1 });
	await pause(10);
	assert.equal(hub.offers().length, 1, "a withdrawn offer doesn't go out again");

	const ac2 = new AbortController();
	const taken = o.offer({ text: "two", quiet_ms: 0, signal: ac2.signal }, "x");
	await until(() => hub.offers().length === 2, "the second offer");
	ac2.abort();
	hub.player({ t: "ack", id: 2, accepted: true });
	assert.equal(await taken, "accepted");
	o.close();
});

test("an offer withdrawn while out, and over when its ack never came, is still the turn the player takes after all", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const ac = new AbortController();
	const outcome = o.offer({ text: "one", source: "game", quiet_ms: 0, signal: ac.signal }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "the offer");
	ac.abort();
	await pause(OFFER_ACK_MS + 50);
	assert.equal(await outcome, "withdrawn");
	// the player took it after all: its turn names it, and holds the next offer
	hub.player({ t: "ack", id: 1, accepted: true });
	const next = o.offer({ text: "two", quiet_ms: 0 }, "y");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await pause(20);
	assert.equal(hub.offers().length, 1);
	const taken = o.take("one");
	assert.equal(taken?.by, "x");
	assert.equal(taken?.source, "game");
	// one whose ack is lost with the link is found by its turn's text too
	hub.player({ t: "status", voice: "speaking", epoch: 1 });
	hub.player({ t: "status", voice: "idle", epoch: 2 });
	await until(() => hub.offers().length === 2, "the next offer");
	hub.player({ t: "ack", id: 2, accepted: true });
	assert.equal(await next, "accepted");
	const ac3 = new AbortController();
	void o.offer({ text: "three", quiet_ms: 0, signal: ac3.signal }, "z");
	hub.player({ t: "status", voice: "speaking", epoch: 3 });
	hub.player({ t: "status", voice: "idle", epoch: 4 });
	await until(() => hub.offers().length === 3, "the third offer");
	ac3.abort();
	hub.player("closed");
	assert.equal(o.take("three")?.by, "z");
	o.close();
});

test("a turn that names an offer whose ack never came settles it as taken", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const outcome = o.offer({ text: "hello", source: "chat", quiet_ms: 0 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "the offer");
	// the player took it, and the link dropped before its ack
	hub.player("closed");
	assert.equal(o.take("hello")?.source, "chat");
	assert.equal(await outcome, "accepted");
	o.close();
});

test("an offer out when the link drops still expires on time", async () => {
	const hub = fakeHub();
	const o = new Offers(hub, () => {});
	const outcome = o.offer({ text: "hello", quiet_ms: 0, ttl_ms: 60 }, "x");
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => hub.offers().length === 1, "the offer");
	hub.open = false;
	hub.player("closed");
	assert.equal(await outcome, "expired");
	o.close();
});

test("the link tells a new session the last status, and a newer link replaces the old one", () => {
	class Socket extends EventEmitter {
		readyState = 1;
		sent: string[] = [];
		closed = false;
		send(d: string) { this.sent.push(d); }
		close() { this.closed = true; this.emit("close"); }
	}
	const socket = () => new Socket();
	const server = new LinkServer();
	const first = socket();
	server.attach(first);
	first.emit("message", Buffer.from(JSON.stringify({ t: "status", voice: "idle", epoch: 4 })), false);
	const o = new Offers(server, () => {});
	assert.equal(o.voice, "idle");
	const second = socket();
	server.attach(second);
	assert.equal(first.closed, true);
	assert.equal(o.voice, "offline");
	// the old link is not listened to any more
	first.emit("message", Buffer.from(JSON.stringify({ t: "status", voice: "idle", epoch: 5 })), false);
	assert.equal(o.voice, "offline");
	second.emit("message", Buffer.from(JSON.stringify({ t: "status", voice: "speaking", epoch: 5 })), false);
	assert.equal(o.voice, "speaking");
	assert.equal(server.send({ t: "x" }), true);
	assert.deepEqual(second.sent, [JSON.stringify({ t: "x" })]);
	o.close();
});

test("a voice listener that rejects is logged, not left unhandled", async () => {
	const hub = fakeHub();
	const lines: string[] = [];
	const o = new Offers(hub, (l) => lines.push(l));
	o.onVoice(async () => { throw new Error("nope"); });
	hub.player({ t: "status", voice: "idle", epoch: 0 });
	await until(() => lines.some((l) => l.includes("nope")), "the log line");
	o.close();
});

test("an offer needs text, and its source is a word", () => {
	const o = new Offers(undefined, () => {});
	assert.throws(() => o.offer({ text: " " }, "x"), /text/);
	assert.throws(() => o.offer({ text: "hi", source: "Group Chat" }, "x"), /source/);
	assert.throws(() => o.offer({ text: "hi", ttl_ms: Number.NaN }, "x"), /ttl_ms/);
	assert.throws(() => o.offer({ text: "hi", quiet_ms: 2 ** 31 * 10 }, "x"), /quiet_ms/);
	assert.throws(() => o.offer({ text: "hi\u0000there" }, "x"), /control characters/);
	assert.throws(() => o.offer({ text: "hi", signal: {} as AbortSignal }, "x"), /signal/);
	assert.doesNotThrow(() => void o.offer({ text: "two\nlines\tand a tab" }, "x"));
	o.close();
});

// --- a whole session, with a service in it ---

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
	chat: { api: "chat_completions", base_url: "http://chat.test", api_key_env: "OFFERS_TEST_KEY", model: "m", params: {} },
	stt: { provider: "elevenlabs", model: "s", keyterms: [] },
	voice: { provider: "elevenlabs", voice_id: "v", model: "eleven_test", params: {}, drop_tags: [] },
	rig: {},
	extensions: [],
	env_file: "",
	manifest: {},
} as unknown as Character;

const reply = (text: string) =>
	new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);

function extension(name: string, opts: { hooks?: [HookName, (i: HookInput) => unknown][]; service?: (ctx: ServiceContext) => unknown }): Loaded {
	const calls = new Map(opts.hooks ?? []);
	return {
		name,
		dir: "",
		handler: "",
		hooks: new Map([...calls.keys()].map((h) => [h, { blocking: true, timeout_ms: 5000 }])),
		service: !!opts.service,
		requires_env: [],
		config: { from: name },
		call: (i: HookInput) => calls.get(i.event)?.(i),
		run: opts.service,
	} as unknown as Loaded;
}

function session(t: TestContext, exts: Loaded[]) {
	const lines: string[] = [];
	t.mock.method(console, "log", (line: string) => { lines.push(line); });
	t.mock.method(globalThis, "fetch", async () => reply("hello"));
	const { ws, app } = fakeSocket();
	const hub = fakeHub();
	runSession(ws as unknown as WebSocket, character, exts, hub);
	const logged = (text: string) => lines.some((l) => l.includes(text));
	return {
		app,
		hub,
		logged,
		close: async () => {
			ws.emit("close");
			await until(() => logged("closed:"), "the session to close", 4000);
		},
	};
}

test("a service starts after on_session_start, its ext reaches the hooks, and an accepted offer is a turn that names it", async (t) => {
	const order: string[] = [];
	let ctx: ServiceContext | undefined;
	let outcome: Promise<string> | undefined;
	const seen: State[] = [];
	const room = extension("room", {
		hooks: [
			["on_session_start", () => { order.push("on_session_start"); }],
			["before_llm", (i) => { seen.push(i.state); }],
		],
		service: async (c) => {
			order.push("service");
			ctx = c;
			c.ext.set({ chat: ["@ana: hi"] });
			outcome = c.offer({ text: "@ana asked: hi?", source: "chat", quiet_ms: 0 });
			await new Promise((r) => c.signal.addEventListener("abort", r));
			order.push("stopped");
		},
	});
	const s = session(t, [room]);
	await until(() => ctx !== undefined, "the service");
	assert.deepEqual(order, ["on_session_start", "service"]);
	assert.deepEqual(ctx!.config, { from: "room" });
	assert.deepEqual(ctx!.ext.get(), { chat: ["@ana: hi"] });
	assert.equal(ctx!.voice.state, "offline");

	const voices: string[] = [];
	ctx!.voice.on((v) => voices.push(v));
	s.hub.player({ t: "status", voice: "idle", epoch: 0 });
	assert.equal(ctx!.voice.state, "idle");
	await until(() => s.hub.offers().length === 1, "the offer");
	s.hub.player({ t: "ack", id: 1, accepted: true });
	assert.equal(await outcome, "accepted");
	assert.deepEqual(voices, ["idle"]);

	// the player injects the offer as the user's turn
	s.app({ t: "llm", id: 1, history: [{ role: "user", content: "@ana asked: hi?" }] });
	await until(() => seen.length === 1, "before_llm");
	assert.deepEqual(seen[0].input, { text: "@ana asked: hi?", channel: "chat", offered_by: "room" });
	assert.deepEqual(seen[0].ext.room, { chat: ["@ana: hi"] });
	await until(() => s.logged("turn 1: replied"), "the reply");

	// a turn the user started is a voice turn, and sees the service's latest write
	ctx!.ext.set({ chat: ["@bia: yo"] });
	s.app({ t: "llm", id: 2, history: [{ role: "user", content: "hey" }] });
	await until(() => seen.length === 2, "the second before_llm");
	assert.deepEqual(seen[1].input, { text: "hey", channel: "voice" });
	assert.deepEqual(seen[1].ext.room, { chat: ["@bia: yo"] });

	await s.close();
	assert.equal(ctx!.signal.aborted, true);
	assert.deepEqual(order, ["on_session_start", "service", "stopped"]);
});

test("a service write made while before_llm runs is kept", async (t) => {
	let ctx: ServiceContext | undefined;
	let release = () => {};
	const held = new Promise<void>((r) => { release = r; });
	const finals: unknown[] = [];
	const svc = extension("svc", {
		hooks: [
			["before_llm", async (i) => { await held; return { state: { ...i.state, ext: { ...i.state.ext, other: 1 } } }; }],
			["after_llm", (i) => { finals.push(i.state.ext); }],
		],
		service: async (c) => {
			ctx = c;
			await new Promise((r) => c.signal.addEventListener("abort", r));
		},
	});
	const s = session(t, [svc]);
	await until(() => ctx !== undefined, "the service");
	s.app({ t: "llm", id: 1, history: [{ role: "user", content: "hey" }] });
	await pause(10);
	ctx!.ext.set("written meanwhile");
	release();
	await until(() => finals.length === 1, "after_llm");
	assert.deepEqual(finals[0], { svc: "written meanwhile", other: 1 });
	await s.close();
});

test("a service that fails is started again", async (t) => {
	let runs = 0;
	const s = session(t, [
		extension("flaky", {
			service: async (c) => {
				if (++runs === 1) throw new Error("boom");
				await new Promise((r) => c.signal.addEventListener("abort", r));
			},
		}),
	]);
	await until(() => runs === 2, "the second run", 3000);
	assert.ok(s.logged("flaky service failed: boom; starting it again in 1s"));
	await s.close();
});

test("a service reads what its own hook wrote on the turn still open, and a run that failed leaves no listener", async (t) => {
	let ctx: ServiceContext | undefined;
	let runs = 0;
	const heard: number[] = [];
	let release = () => {};
	const held = new Promise<void>((r) => { release = r; });
	const svc = extension("svc", {
		hooks: [
			["before_llm", (i) => ({ state: { ...i.state, ext: { ...i.state.ext, svc: { seen: i.state.input?.text } } } })],
			["after_llm", () => held],
		],
		service: async (c) => {
			const run = ++runs;
			c.voice.on(() => { heard.push(run); });
			if (run === 1) throw new Error("first run");
			ctx = c;
			await new Promise((r) => c.signal.addEventListener("abort", r));
		},
	});
	const s = session(t, [svc]);
	await until(() => ctx !== undefined, "the second run", 3000);
	// the failed run's listener is gone; only the live run's hears the voice
	s.hub.player({ t: "status", voice: "idle", epoch: 0 });
	assert.deepEqual(heard, [2]);
	s.app({ t: "llm", id: 1, history: [{ role: "user", content: "hey" }] });
	await until(() => (ctx!.ext.get() as { seen?: string } | undefined)?.seen === "hey", "the hook's write");
	assert.deepEqual(ctx!.ext.get(), { seen: "hey" });
	release();
	await s.close();
});

test("a pending call's result is made to fit an offer, and a bad request rejects rather than throws", async (t) => {
	const long = pendingResultText("play_song", "x".repeat(5000));
	assert.equal(long.length, OFFER_TEXT_MAX);
	assert.ok(long.startsWith("The result of play_song: xxx"));
	assert.ok(long.endsWith("… (cut short)"));
	assert.equal(pendingResultText("play_song", "a\r\nb\rc\u0000d\te"), "The result of play_song: a\nb\nc d\te");
	assert.equal(pendingResultText("play_song", "ok"), "The result of play_song: ok");

	let ctx: ServiceContext | undefined;
	const s = session(t, [
		extension("kit", {
			service: async (c) => {
				ctx = c;
				await new Promise((r) => c.signal.addEventListener("abort", r));
			},
		}),
	]);
	await until(() => ctx !== undefined, "the service");
	const call = { id: "c", name: "play_song", arguments: "{}" };
	// a result too long or with a \r still goes out as an offer
	s.hub.player({ t: "status", voice: "idle", epoch: 0 });
	const sent = ctx!.result(call, "y".repeat(4500) + "\r", { quiet_ms: 0 });
	await until(() => s.hub.offers().length === 1, "the offer");
	assert.equal((s.hub.offers()[0].text as string).length, OFFER_TEXT_MAX);
	s.hub.player({ t: "ack", id: 1, accepted: true });
	assert.equal(await sent, "accepted");
	// a request that isn't a valid offer is a rejected promise
	let returned: Promise<unknown> | undefined;
	assert.doesNotThrow(() => { returned = ctx!.result(call, "ok", { ttl_ms: -1 }); });
	await assert.rejects(returned!, /ttl_ms/);
	await s.close();
});

test("a long pending result is cut between characters, not inside an emoji", () => {
	const head = "The result of play_song: ";
	const cut = " … (cut short)";
	// the cut falls right after the first half of an emoji
	const before = OFFER_TEXT_MAX - head.length - cut.length - 1;
	const text = pendingResultText("play_song", "x".repeat(before) + "🎵".repeat(1000));
	assert.ok(text.endsWith(`x${cut}`));
	assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false);
	assert.ok(text.length <= OFFER_TEXT_MAX);
});
