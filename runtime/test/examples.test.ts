// The example extensions in examples/extensions/. gesture-cues is the one
// docs/your-first-extension.md builds: its handler, its check, and a
// character that lists it. dead-air is the smallest service. Run with `npm test`.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import cues, { check } from "../../examples/extensions/gesture-cues/index.ts";
import { check as deadAirCheck, service as deadAir } from "../../examples/extensions/dead-air/index.ts";
import { checkCharacter } from "../src/check.ts";
import { loadExtensions, runHook } from "../src/extensions.ts";
import { loadCharacter } from "../src/manifest.ts";
import type { State } from "../src/state.ts";

const EXAMPLE = path.resolve(import.meta.dirname, "../../examples/extensions/gesture-cues");
const DEAD_AIR = path.resolve(import.meta.dirname, "../../examples/extensions/dead-air");
const FOXGLOVE = path.resolve(import.meta.dirname, "../../characters/foxglove");
const config = { cues: { hello: "wave", "you did it": "cheer", "C++": "nod" } };
const on = (sentence: string, beats: object[] = []) => cues({ event: "on_sentence", state: { sentence, beats }, config });
const body = { gestures: ["wave", "cheer", "nod"] };

test("a cue phrase adds its gesture, on the phrase as the sentence writes it", () => {
	assert.deepEqual(on("Well, HELLO there!")?.state.beats, [{ span: "HELLO", gesture: "wave" }]);
	assert.deepEqual(on("[excited] You did it!")?.state.beats, [{ span: "You did it", gesture: "cheer" }]);
});

test("a sentence without a cue is left alone", () => {
	assert.equal(on("Nothing to see here."), undefined);
	// part of a longer word isn't the phrase
	assert.equal(on("Othello is a play."), undefined);
});

test("the first cue in the sentence wins, and beats already there are kept", () => {
	const earlier = { span: "", emotion: "happy" };
	assert.deepEqual(on("You did it, hello world.", [earlier])?.state.beats, [earlier, { span: "You did it", gesture: "cheer" }]);
});

test("a delivery tag isn't a cue, but a cue right after one is", () => {
	const laughs = { cues: { laughs: "nod", okay: "wave" } };
	const out = (sentence: string) => cues({ event: "on_sentence", state: { sentence }, config: laughs });
	assert.deepEqual(out("[laughs] Okay, fine.")?.state.beats, [{ span: "Okay", gesture: "wave" }]);
	assert.equal(out("[laughs] Fine."), undefined);
	assert.deepEqual(out("She laughs.")?.state.beats, [{ span: "laughs", gesture: "nod" }]);
});

test("a phrase with regex characters is matched as written", () => {
	assert.deepEqual(on("I write C++ all day.")?.state.beats, [{ span: "C++", gesture: "nod" }]);
	assert.equal(on("I write C all day."), undefined);
});

test("the check refuses a config it can't use and warns about a gesture the character doesn't have", () => {
	assert.deepEqual(check({ config, body }), { errors: [], warnings: [] });
	assert.match(check({ config: {}, body }).errors!.join(), /cues/);
	assert.match(check({ config: { cues: ["wave"] }, body }).errors!.join(), /cues/);
	assert.match(check({ config: { cues: { hi: 3 } }, body }).errors!.join(), /"hi"/);
	assert.match(check({ config: { cues: { "": "wave" } }, body }).errors!.join(), /""/);
	assert.match(check({ config: { cues: { ["la ".repeat(100)]: "wave" } }, body }).errors!.join(), /200 characters/);
	const r = check({ config: { cues: { bye: "bow" } }, body });
	assert.deepEqual(r.errors, []);
	assert.match(r.warnings!.join(), /"bow"/);
	// a body that can't be told from here isn't judged
	assert.deepEqual(check({ config: { cues: { bye: "bow" } }, body: { gestures: null } }), { errors: [], warnings: [] });
});

const temp: string[] = [];
after(() => temp.forEach((d) => rmSync(d, { recursive: true, force: true })));

// a copy of FoxGlove that lists gesture-cues where the guide does: after
// emotion-tags, before the director
function withCues(cuesYaml: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-cues-"));
	temp.push(dir);
	cpSync(FOXGLOVE, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}animations`) });
	const manifest = readFileSync(path.join(dir, "character.yaml"), "utf8")
		.replace(/\r\n/g, "\n")
		.replaceAll("../../extensions", path.resolve(FOXGLOVE, "../../extensions"))
		.replace(/(emotion-tags\n    config_file: director\.yaml\n)/, `$1  - path: ${EXAMPLE}\n    config:\n      cues: ${cuesYaml}\n`);
	writeFileSync(path.join(dir, "character.yaml"), manifest);
	return dir;
}
const keys = { XAI_API_KEY: "x", ELEVENLABS_API_KEY: "x" };

test("a character that lists gesture-cues passes the check, and its gestures reach the beats", async () => {
	const c = loadCharacter(withCues(`{ hello: wave, "you did it": cheer }`));
	const exts = await loadExtensions(c.extensions);
	assert.deepEqual(exts.map((e) => e.name), ["emotion-tags", "gesture-cues", "director"]);
	const r = await checkCharacter(c, exts, keys, true);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.warnings, []);
	assert.ok(r.ok.includes("gesture-cues: config"));

	const state: State = { schema: 1, character: {}, session: { id: "s", channel: "voice" }, sentence: "Hello, little comets!", beats: [], ext: {} };
	const out = await runHook(exts.filter((e) => e.name === "gesture-cues"), "on_sentence", state, () => {});
	assert.deepEqual(out.beats, [{ span: "Hello", gesture: "wave" }]);
});

test("a gesture FoxGlove doesn't have is a warning; cues that aren't a map stop her", async () => {
	const warned = loadCharacter(withCues(`{ bye: bow }`));
	const r = await checkCharacter(warned, await loadExtensions(warned.extensions), keys, true);
	assert.deepEqual(r.errors, []);
	assert.match(r.warnings.join(), /gesture-cues: "bye" plays "bow"/);
	const broken = loadCharacter(withCues(`[wave]`));
	const s = await checkCharacter(broken, await loadExtensions(broken.extensions), keys, true);
	assert.match(s.errors.join(), /gesture-cues: `cues` must map/);
});

// dead-air, the smallest service: a copy of FoxGlove that lists it last
test("dead-air loads as a service with no hooks, and offers a turn once the voice has been quiet", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-dead-air-"));
	temp.push(dir);
	cpSync(FOXGLOVE, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}animations`) });
	const manifest = readFileSync(path.join(dir, "character.yaml"), "utf8")
		.replace(/\r\n/g, "\n")
		.replaceAll("../../extensions", path.resolve(FOXGLOVE, "../../extensions"))
		.replace(/\nextensions:\n/, `\nextensions:\n  - path: ${DEAD_AIR}\n    config: { after_s: 30 }\n`);
	writeFileSync(path.join(dir, "character.yaml"), manifest);
	const c = loadCharacter(dir);
	const exts = await loadExtensions(c.extensions);
	const dead = exts.find((e) => e.name === "dead-air")!;
	assert.equal(dead.service, true);
	assert.equal(dead.hooks.size, 0);
	assert.equal(typeof dead.run, "function");
	const r = await checkCharacter(c, exts, keys, true);
	assert.deepEqual(r.errors, []);

	const ac = new AbortController();
	const asked: object[] = [];
	const outcomes = ["accepted", "closed"];
	await deadAir({
		config: { after_s: 30, cooldown_s: 0.01 },
		signal: ac.signal,
		offer: async (req) => {
			asked.push(req);
			return outcomes.shift()!;
		},
	});
	assert.equal(asked.length, 2);
	assert.deepEqual({ ...asked[0], text: "" }, { text: "", source: "idle", quiet_ms: 30_000, ttl_ms: 600_000 });
});

test("dead-air's check refuses times that aren't seconds above 0", () => {
	assert.deepEqual(deadAirCheck({ config: {} }), { errors: [] });
	assert.match(deadAirCheck({ config: { after_s: 0 } }).errors.join(), /after_s/);
	assert.match(deadAirCheck({ config: { cooldown_s: "1" as never } }).errors.join(), /cooldown_s/);
	assert.match(deadAirCheck({ config: { text: " " } }).errors.join(), /text/);
	assert.match(deadAirCheck({ config: { text: "x".repeat(4001) } }).errors.join(), /4000/);
});
