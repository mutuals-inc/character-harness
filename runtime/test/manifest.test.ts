// The `rig`, `listen` and extension sections of character.yaml. Run with `npm test`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCharacter } from "../src/manifest.ts";

// a minimal character whose rig is `rig` (YAML text), with empty files for its
// model and clips
function character(rig: string, id = "test", chat = ""): string {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-character-"));
	writeFileSync(
		path.join(dir, "character.yaml"),
		`schema: 1
id: ${id}
name: Test
description: A character for the tests.
author: tests
license: none
prompt: system.md
models:
  chat: { api: chat_completions, base_url: "https://example.invalid/v1", api_key_env: TEST_KEY, model: m${chat} }
stt: { provider: elevenlabs, model: scribe_v2_realtime }
voice: { provider: elevenlabs, voice_id: v, model: eleven_v4_turbo }
rig:
${rig}
extensions: []
env_file: .env
`,
	);
	writeFileSync(path.join(dir, "system.md"), "You are a test.");
	writeFileSync(path.join(dir, "model.vrm"), "");
	for (const clip of ["idle", "talk", "wave"]) writeFileSync(path.join(dir, `${clip}.vrma`), "");
	return dir;
}

test("a model with animations loads, with .vrma files and clip names told apart", () => {
	const dir = character(`  engine: ">=0.5.8"
  model: model.vrm
  animations:
    idle: [idle.vrma, Breathing]
    talk: { regular: talk.vrma }
    gestures:
      wave: wave.vrma
      lean: { clip: Lean, hold: true }`);
	const c = loadCharacter(dir);
	assert.equal(c.rig.kind, "model");
	if (c.rig.kind !== "model") return;
	assert.deepEqual(c.rig.idle, [{ file: path.join(dir, "idle.vrma") }, { clip: "Breathing" }]);
	assert.deepEqual(c.rig.gestures.get("lean"), { source: { clip: "Lean" }, hold: true });
	assert.equal(c.rig.talk.get("regular")?.length, 1);
});

test("a rig takes a profile or a model, not both", () => {
	assert.throws(
		() => loadCharacter(character(`  engine: ">=0.5.8"\n  profile: x\n  model: model.vrm`)),
		/takes `profile` or `model`, not both/,
	);
});

test("a missing animation file is named", () => {
	assert.throws(
		() => loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm\n  animations:\n    idle: missing.vrma`)),
		/`rig.animations.idle` .*missing\.vrma does not exist/,
	);
});

test("a gesture takes one clip, not a list", () => {
	assert.throws(
		() => loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm\n  animations:\n    gestures: { wave: [wave.vrma, idle.vrma] }`)),
		/`rig.animations.gestures.wave` takes one clip, not a list/,
	);
});

test("a misspelt animations key is an error", () => {
	assert.throws(
		() => loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm\n  animations:\n    idles: idle.vrma`)),
		/`rig.animations.idles` is not a key/,
	);
});

test("an animation file that isn't .vrma is named, not taken as a clip name", () => {
	assert.throws(
		() => loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm\n  animations:\n    idle: idle.fbx`)),
		/only VRM Animation \(\.vrma\) files are loaded/,
	);
});

test("an id that could leave the cache folder is refused", () => {
	const rig = `  engine: ">=0.5.8"\n  model: model.vrm`;
	assert.throws(() => loadCharacter(character(rig, "../../x")), /`id` must be lowercase letters/);
	assert.equal(loadCharacter(character(rig, "my-char_2")).id, "my-char_2");
});

test("rig.springs is on unless set to false, and must be true or false", () => {
	const on = loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm`));
	assert.equal(on.rig.kind === "model" && on.rig.springs, true);
	const off = loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm\n  springs: false`));
	assert.equal(off.rig.kind === "model" && off.rig.springs, false);
	assert.throws(() => loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm\n  springs: "no"`)), /rig\.springs/);
});

test("models.chat.silent_reply is optional and must be a non-empty string", () => {
	const rig = `  engine: ">=0.5.8"\n  model: model.vrm`;
	assert.equal(loadCharacter(character(rig)).chat.silent_reply, undefined);
	assert.equal(loadCharacter(character(rig, "test", ', silent_reply: "[pass]"')).chat.silent_reply, "[pass]");
	assert.throws(() => loadCharacter(character(rig, "test", ', silent_reply: "  "')), /`models.chat.silent_reply` must be a non-empty string/);
	assert.throws(() => loadCharacter(character(rig, "test", ", silent_reply: 1")), /`models.chat.silent_reply`/);
});

// a character with this `listen` block (YAML flow mapping)
function withListen(listen: string): string {
	const dir = character(`  engine: ">=0.5.8"\n  model: model.vrm`);
	const file = path.join(dir, "character.yaml");
	writeFileSync(file, readFileSync(file, "utf8").replace("extensions: []", `listen: ${listen}\nextensions: []`));
	return dir;
}

test("listen is optional, and a key left out keeps the player's default", () => {
	assert.deepEqual(loadCharacter(character(`  engine: ">=0.5.8"\n  model: model.vrm`)).listen, {});
	assert.deepEqual(loadCharacter(withListen("{ end_of_speech_ms: 800 }")).listen, { end_of_speech_ms: 800 });
	assert.deepEqual(loadCharacter(withListen("~")).listen, {});
	// the thresholds' extremes, and the closest pair allowed
	assert.deepEqual(loadCharacter(withListen("{ speech_threshold: 0.95, silence_threshold: 0.05 }")).listen, { speech_threshold: 0.95, silence_threshold: 0.05 });
	assert.deepEqual(loadCharacter(withListen("{ speech_threshold: 0.06, silence_threshold: 0.05 }")).listen, { speech_threshold: 0.06, silence_threshold: 0.05 });
	assert.deepEqual(
		loadCharacter(withListen("{ end_of_speech_ms: 1500, barge_in_ms: 1200, speech_threshold: 0.7, silence_threshold: 0.5, echo_floor: 0.2 }")).listen,
		{ end_of_speech_ms: 1500, barge_in_ms: 1200, speech_threshold: 0.7, silence_threshold: 0.5, echo_floor: 0.2 },
	);
});

test("listen refuses misspelt keys, values out of range and crossed thresholds", () => {
	const bad: [string, RegExp][] = [
		["{ endpoint_ms: 800 }", /`listen.endpoint_ms` is not a key; they are end_of_speech_ms, /],
		["{ end_of_speech_ms: 50 }", /`listen.end_of_speech_ms` must be between 200 and 5000 \(got 50\)/],
		["{ barge_in_ms: 700.5 }", /`listen.barge_in_ms` must be a whole number/],
		["{ barge_in_ms: fast }", /`listen.barge_in_ms` must be a number/],
		["{ echo_floor: 1 }", /`listen.echo_floor` must be between 0.01 and 0.9/],
		["{ speech_threshold: 0.6 }", /set both or neither/],
		["{ speech_threshold: 0.4, silence_threshold: 0.4 }", /`listen.silence_threshold` must be at least 0.01 below `listen.speech_threshold`/],
		["{ speech_threshold: 0.5000000001, silence_threshold: 0.5 }", /must be at least 0.01 below/],
		["{ end_of_speech_ms: .nan }", /`listen.end_of_speech_ms` must be a number/],
		["{ end_of_speech_ms: ~ }", /`listen.end_of_speech_ms` must be a number/],
		["{ __proto__: { end_of_speech_ms: 900 } }", /`listen.__proto__` is not a key/],
		["[800]", /`listen` must be a mapping/],
	];
	for (const [listen, error] of bad) assert.throws(() => loadCharacter(withListen(listen)), error, listen);
});

// a character whose one extension has this extension.yaml (YAML text)
function withExtension(extensionYaml: string): string {
	const dir = character(`  engine: ">=0.5.8"\n  model: model.vrm`);
	const ext = path.join(dir, "ext");
	mkdirSync(ext);
	writeFileSync(path.join(ext, "extension.yaml"), extensionYaml);
	writeFileSync(path.join(ext, "index.ts"), "export function service() {}\n");
	const file = path.join(dir, "character.yaml");
	writeFileSync(file, readFileSync(file, "utf8").replace("extensions: []", "extensions:\n  - path: ext"));
	return dir;
}

test("an extension that is only a service needs no hooks, but a service needs a module handler", () => {
	const c = loadCharacter(withExtension("name: svc\nhandler: index.ts\nservice: true\n"));
	assert.equal(c.extensions[0].service, true);
	assert.equal(c.extensions[0].hooks.size, 0);
	assert.throws(() => loadCharacter(withExtension("name: svc\nhandler: index.ts\n")), /`hooks` is required/);
	assert.throws(
		() => loadCharacter(withExtension("name: svc\nhandler: https://example.invalid/hook\nservice: true\nhooks: [after_turn]\n")),
		/`service` needs a module handler/,
	);
});

test("an extension's tools are read with it, and need a blocking on_tool_call to run them", () => {
	const yaml = (hooks: string) =>
		`name: kit\nhandler: index.ts\nhooks:\n${hooks}\ntools:\n  - name: use_item\n    description: Use an item.\n    parameters: { type: object, properties: { item: { type: string } } }\n  - name: wait\n`;
	const c = loadCharacter(withExtension(yaml("  on_tool_call: { timeout_ms: 3000 }")));
	assert.deepEqual(c.extensions[0].tools, [
		{ name: "use_item", description: "Use an item.", parameters: { type: "object", properties: { item: { type: "string" } } }, by: "kit" },
		{ name: "wait", by: "kit" },
	]);
	assert.throws(() => loadCharacter(withExtension(yaml("  after_turn: {}"))), /`tools` needs the `on_tool_call` hook/);
	assert.throws(() => loadCharacter(withExtension(yaml("  on_tool_call: { blocking: false }"))), /`hooks.on_tool_call` must be blocking/);
	assert.throws(
		() => loadCharacter(withExtension("name: kit\nhandler: index.ts\nhooks: [on_tool_call]\ntools:\n  - name: has space\n")),
		/`tools\[0\].name` must be 1 to 64/,
	);
	assert.throws(
		() => loadCharacter(withExtension("name: kit\nhandler: index.ts\nhooks: [on_tool_call]\ntools:\n  - name: a\n  - name: a\n")),
		/lists a twice/,
	);
});
