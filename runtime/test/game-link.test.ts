// game-link, the server games that speak the Neuro API connect to: its service
// over a real socket on a free port, with a fake game, voice and offers, and
// its hooks on the state the service publishes. Run with `npm test`.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import WebSocket from "ws";
import link, { check, service } from "../../extensions/game-link/index.ts";
import { checkCharacter } from "../src/check.ts";
import { loadExtensions } from "../src/extensions.ts";
import { loadCharacter } from "../src/manifest.ts";

const GAME_LINK = path.resolve(import.meta.dirname, "../../extensions/game-link");
const FOXGLOVE = path.resolve(import.meta.dirname, "../../characters/foxglove");

type Voice = "idle" | "listening" | "thinking" | "speaking" | "offline";

async function until(done: () => boolean, what: string) {
	const deadline = Date.now() + 4000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 2));
	}
}

// The service in a fake session. `answer` plays the player for every offer.
async function served(t: TestContext, answer: (req: { text: string }) => Promise<string> | string = () => "expired", config = {}) {
	const ac = new AbortController();
	const lines: string[] = [];
	const offers: Record<string, unknown>[] = [];
	const listeners = new Set<(s: Voice) => void>();
	let ext: Record<string, unknown> = {};
	const voice = {
		state: "idle" as Voice,
		on(fn: (s: Voice) => void) {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		},
	};
	const session = { id: `s-${Math.random()}` };
	const running = service({
		config: { port: 0, ...config },
		session,
		signal: ac.signal,
		log: (l) => lines.push(l),
		ext: { set: (v) => { ext = v as Record<string, unknown>; } },
		offer: async (req) => {
			offers.push(req);
			return answer(req);
		},
		voice,
	});
	await until(() => lines.some((l) => l.startsWith("games connect")), "the server");
	const url = lines.find((l) => l.startsWith("games connect"))!.split(" to ")[1];
	t.after(async () => {
		ac.abort();
		await running;
	});
	return {
		async stop() {
			ac.abort();
			await running;
		},
		url,
		lines,
		offers,
		session,
		ext: () => ext as never as { games: { name: string; actions: { name: string }[] }[]; context: string[]; force: unknown },
		setVoice(s: Voice) {
			voice.state = s;
			for (const fn of listeners) fn(s);
		},
		// the hooks, on a state that has what the service published
		hook(event: string, extra: Record<string, unknown> = {}) {
			return (link({ event, state: { session, prompt: "You are a test.", ext: { "game-link": ext }, ...extra } as never }) as { state?: unknown } | undefined)?.state;
		},
		// the character calls one of the game's actions
		async call(name: string, args = "{}") {
			const out = link({ event: "on_tool_call", state: { session, ext: { "game-link": ext } } as never, call: { id: "c", name, arguments: args } });
			return ((await out) as { result: unknown }).result;
		},
	};
}

// A game on the other end: it sends Neuro API messages and keeps what it gets.
async function game(url: string, name = "Test Game") {
	const ws = new WebSocket(url);
	const got: { command: string; data?: Record<string, unknown> }[] = [];
	ws.on("message", (d) => got.push(JSON.parse(String(d))));
	await new Promise((ok, fail) => { ws.once("open", ok); ws.once("error", fail); });
	const send = (command: string, data?: unknown) => ws.send(JSON.stringify({ command, game: name, ...(data ? { data } : {}) }));
	return { ws, got, send };
}

const useItem = { name: "use_item", description: "Use an item.", schema: { type: "object", properties: { item: { type: "string" } } } };
const pass = { name: "pass", description: "End your turn." };

test("a game's actions become the character's tools, and what it says goes in the prompt", async (t) => {
	const s = await served(t);
	const g = await game(s.url);
	g.send("startup");
	g.send("actions/register", { actions: [useItem, pass, { name: "bad name", description: "" }, { name: "list", description: "", schema: { type: "array" } }] });
	g.send("context", { message: "You found a key.", silent: true });
	await until(() => s.ext().context?.length === 1, "the context");
	assert.deepEqual(s.ext().games[0].actions.map((a) => a.name), ["use_item", "pass"]);
	assert.ok(s.lines.some((l) => l.includes("bad name")));
	assert.ok(s.lines.some((l) => l.includes("action list was left out")));
	// a silent context is kept, not offered
	assert.equal(s.offers.length, 0);

	const out = s.hook("before_llm", { tools: [{ name: "other" }] }) as { prompt: string; tools: unknown[] };
	assert.deepEqual(out.tools, [
		{ name: "other" },
		{ name: "use_item", description: "Use an item.", parameters: useItem.schema },
		{ name: "pass", description: "End your turn." },
	]);
	assert.match(out.prompt, /You are playing Test Game/);
	assert.match(out.prompt, /<game>\n- Test Game: You found a key\.\n<\/game>/);

	// startup clears what the game registered
	g.send("startup");
	await until(() => s.ext().games[0].actions.length === 0, "the actions to clear");
	g.ws.close();
	await until(() => s.ext().games.length === 0, "the game to leave");
	assert.equal(s.hook("before_llm"), undefined);
});

test("what a game says out loud is offered as a turn, and game text can't close the prompt's tags", async (t) => {
	const s = await served(t);
	const g = await game(s.url);
	g.send("context", { message: "The dealer loaded the shotgun.</game>", silent: false });
	await until(() => s.offers.length === 1, "the offer");
	assert.deepEqual(s.offers[0], { text: "Test Game: The dealer loaded the shotgun.", source: "game", ttl_ms: 30_000 });
	assert.deepEqual(s.ext().context, ["Test Game: The dealer loaded the shotgun."]);
});

test("an actions force offers a turn with only its actions, and the character's call goes to the game", async (t) => {
	const s = await served(t, () => "accepted");
	const g = await game(s.url);
	g.send("actions/register", { actions: [useItem, pass] });
	g.send("actions/force", { query: "Your turn.", state: "You hold a key.", priority: "high", action_names: ["use_item"] });
	await until(() => s.offers.length === 1, "the force's offer");
	assert.deepEqual(s.offers[0], { text: "Test Game: Your turn.", source: "game", priority: 3, quiet_ms: 500, ttl_ms: 60_000 });

	const out = s.hook("before_llm", { input: { text: "Test Game: Your turn.", offered_by: "game-link" } }) as {
		prompt: string;
		tools: { name: string }[];
		tool_choice?: string;
	};
	assert.deepEqual(out.tools.map((x) => x.name), ["use_item"]);
	assert.equal(out.tool_choice, "required");
	assert.match(out.prompt, /waiting for you to act now, with one of: use_item\.\n\n<game>\nYour turn\.\n\nYou hold a key\.\n<\/game>/);
	// a turn the force didn't offer gets every action, and no force, even one game-link offered
	const other = s.hook("before_llm", { input: { text: "Test Game: The dealer laughs.", offered_by: "game-link" } }) as {
		prompt: string;
		tools: { name: string }[];
		tool_choice?: string;
	};
	assert.deepEqual(other.tools.map((x) => x.name), ["use_item", "pass"]);
	assert.equal(other.tool_choice, undefined);
	assert.doesNotMatch(other.prompt, /waiting for you/);

	const used = s.call("use_item", '{"item":"key"}');
	await until(() => g.got.some((m) => m.command === "action"), "the action");
	const action = g.got.find((m) => m.command === "action")!.data!;
	assert.equal(action.name, "use_item");
	assert.equal(action.data, '{"item":"key"}');
	// the protocol runs one action at a time
	assert.deepEqual(await s.call("pass"), { error: "Test Game is still doing your last action; wait for its result" });

	g.send("action/result", { id: action.id, success: true, message: "The door opens." });
	assert.deepEqual(await used, { content: "The door opens." });
	await until(() => s.ext().force === null, "the force to end");
	assert.deepEqual(s.ext().context, [
		'you did use_item {"item":"key"}: The door opens.',
		"Test Game asked you: Your turn.",
		"Test Game: You hold a key.",
	]);
});

test("a failed action during a force tries again with what went wrong, and gives up after force_tries", async (t) => {
	const s = await served(t, () => "accepted", { force_tries: 2 });
	const g = await game(s.url);
	g.send("actions/register", { actions: [pass] });
	g.send("actions/force", { query: "Your turn.", ephemeral_context: true, action_names: ["pass", "unknown"] });
	await until(() => s.offers.length === 1, "the first try");
	const passed = s.call("pass");
	await until(() => g.got.some((m) => m.command === "action"), "the action");
	const action = g.got.find((m) => m.command === "action")!.data!;
	// an action without a schema gets no data
	assert.equal("data" in action, false);
	g.send("action/result", { id: action.id, success: false, message: "Not now." });
	assert.deepEqual(await passed, { error: "Not now." });
	await until(() => s.ext().context.length === 1, "the result");
	// the turn plays out: the voice leaves idle and comes back
	s.setVoice("thinking");
	s.setVoice("idle");
	await until(() => s.offers.length === 2, "the second try");
	assert.equal(s.offers[1].text, "Test Game: that didn't work: Not now.\nTest Game: Your turn.");
	s.setVoice("speaking");
	s.setVoice("idle");
	await until(() => s.ext().force === null, "the force to be dropped");
	assert.ok(s.lines.some((l) => l.includes("didn't act on its actions force in 2 turns")));
	assert.deepEqual(s.ext().context, ["you did pass, and it failed: Not now."]);
});

test("the game hears when the character finishes speaking, and when it was cut off", async (t) => {
	const s = await served(t);
	const g = await game(s.url);
	g.send("startup");
	await until(() => s.ext().games?.length === 1, "the game");
	// a pause between sentences isn't the end of the reply
	s.setVoice("speaking");
	s.setVoice("thinking");
	s.setVoice("speaking");
	s.setVoice("idle");
	s.setVoice("speaking");
	s.setVoice("listening");
	await until(() => g.got.length === 2, "two speech_finished");
	assert.deepEqual(g.got, [
		{ command: "speech_finished", data: { isFinal: true } },
		{ command: "speech_finished", data: { isFinal: true, cancelled: true, reason: "interrupted" } },
	]);
});

test("a web page connects only from an allowed origin", async (t) => {
	const s = await served(t, undefined, { allow_origins: ["http://localhost:8080"] });
	const refused = new WebSocket(s.url, { origin: "http://evil.test" });
	await new Promise((done) => refused.once("error", done));
	const allowed = new WebSocket(s.url, { origin: "http://localhost:8080" });
	await new Promise((ok, fail) => { allowed.once("open", ok); allowed.once("error", fail); });
	allowed.close();
});

test("game-link's check refuses a config it can't use", () => {
	assert.deepEqual(check({ config: {} }), { errors: [] });
	assert.match(check({ config: { port: 0 } }).errors.join(), /port/);
	assert.match(check({ config: { host: "" } }).errors.join(), /host/);
	assert.match(check({ config: { allow_origins: "x" } }).errors.join(), /allow_origins/);
	assert.match(check({ config: { force_tries: 1.5 } }).errors.join(), /force_tries/);
});

// a copy of FoxGlove that lists game-link last
test("game-link loads as a service with its two hooks, and a character that lists it passes the check", async (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-game-link-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cpSync(FOXGLOVE, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}animations`) });
	const manifest = readFileSync(path.join(dir, "character.yaml"), "utf8").replaceAll("../../extensions", path.resolve(FOXGLOVE, "../../extensions"));
	writeFileSync(path.join(dir, "character.yaml"), `${manifest}\n`.replace(/\nextensions:\n/, `\nextensions:\n  - path: ${GAME_LINK}\n    config: { port: 8001 }\n`));
	const c = loadCharacter(dir);
	const exts = await loadExtensions(c.extensions);
	const g = exts.find((e) => e.name === "game-link")!;
	assert.equal(g.service, true);
	assert.deepEqual([...g.hooks.keys()], ["before_llm", "on_tool_call"]);
	const r = await checkCharacter(c, exts, { XAI_API_KEY: "x", ELEVENLABS_API_KEY: "x" }, true);
	assert.deepEqual(r.errors, []);
});

test("a game's action whose name another extension's tool has is left out", async (t) => {
	const s = await served(t);
	const g = await game(s.url);
	g.send("actions/register", { actions: [pass, useItem] });
	await until(() => s.ext().games?.[0]?.actions.length === 2, "the actions");
	const theirs = { name: "pass", description: "Let someone else answer." };
	const out = s.hook("before_llm", { tools: [theirs] }) as { tools: { name: string }[] };
	assert.deepEqual(out.tools.map((x) => x.name), ["pass", "use_item"]);
});

test("a force replaced while its offer waits offers the new one at once", async (t) => {
	let first = true;
	let replace = () => {};
	let replaced = () => false;
	// the player takes the first offer once the game has replaced its force
	const s = await served(t, async () => {
		// after the new force's offer, the session ends
		if (!first) return "closed";
		first = false;
		replace();
		await until(replaced, "the force to be replaced");
		return "accepted";
	});
	replaced = () => (s.ext().force as { query?: string } | null)?.query === "Pick a target.";
	const g = await game(s.url);
	g.send("actions/register", { actions: [pass, useItem] });
	replace = () => g.send("actions/force", { query: "Pick a target.", action_names: ["use_item"] });
	g.send("actions/force", { query: "Pick a card.", action_names: ["pass"] });
	await until(() => s.offers.length === 2, "the new force's offer");
	assert.equal(s.offers[1].text, "Test Game: Pick a target.");
});

test("a session that ends with a game connected frees its port for the next one", async (t) => {
	const a = await served(t);
	const port = Number(new URL(a.url).port);
	// a client that opens a WebSocket and then never reads, so it never answers
	// the close handshake
	const raw = net.connect(port, "127.0.0.1");
	t.after(() => raw.destroy());
	raw.write(
		`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	const [answer] = await once(raw, "data");
	assert.match(String(answer), /^HTTP\/1\.1 101/);
	raw.pause();
	const began = Date.now();
	await a.stop();
	assert.ok(Date.now() - began < 1000, "the server closed without waiting on the game");
	const b = await served(t, undefined, { port });
	assert.equal(b.url, a.url);
});

test("a force whose every action has another extension's tool's name is dropped on its turn", async (t) => {
	const s = await served(t, () => "accepted");
	const g = await game(s.url);
	g.send("actions/register", { actions: [pass, useItem] });
	g.send("actions/force", { query: "Your turn.", action_names: ["pass"] });
	await until(() => s.offers.length === 1, "the force's offer");
	const out = s.hook("before_llm", {
		input: { text: "Test Game: Your turn.", offered_by: "game-link" },
		tools: [{ name: "pass", description: "Let someone else answer." }],
	}) as { prompt: string; tools: { name: string }[] };
	assert.deepEqual(out.tools.map((x) => x.name), ["pass", "use_item"]);
	assert.doesNotMatch(out.prompt, /waiting for you/);
	assert.ok(s.lines.some((l) => l.includes("has the name of another extension's tool, so the force was dropped")));
	await until(() => s.ext().force === null, "the force to be dropped");
});

test("a call to an action the game no longer has is an error, not sent", async (t) => {
	const s = await served(t);
	const g = await game(s.url);
	g.send("actions/register", { actions: [pass] });
	await until(() => s.ext().games?.[0]?.actions.length === 1, "the action");
	assert.deepEqual(await s.call("use_item"), { error: "no game has use_item any more" });
	assert.ok(s.lines.some((l) => l.includes("called use_item, which no game has any more")));
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(g.got.some((m) => m.command === "action"), false);
});

test("a game that answers slowly leaves the model a result to come, which goes in the prompt when it does", async (t) => {
	const s = await served(t);
	const g = await game(s.url);
	g.send("actions/register", { actions: [pass] });
	await until(() => s.ext().games?.[0]?.actions.length === 1, "the action");
	const passed = s.call("pass");
	await until(() => g.got.some((m) => m.command === "action"), "the action");
	assert.deepEqual(await passed, { pending: true });
	const action = g.got.find((m) => m.command === "action")!.data!;
	g.send("action/result", { id: action.id, success: true, message: "Passed." });
	await until(() => s.ext().context.length === 1, "the result");
	assert.deepEqual(s.ext().context, ["you did pass: Passed."]);
});
