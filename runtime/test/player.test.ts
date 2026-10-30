// What the runtime gives the player to start it. Run with `npm test`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { listenEnv, manualStart } from "../src/player.ts";

test("HARNESS_LISTEN is empty without listen settings, and JSON with only the keys set", () => {
	assert.equal(listenEnv({}), "");
	assert.deepEqual(JSON.parse(listenEnv({ end_of_speech_ms: 900, speech_threshold: 0.6, silence_threshold: 0.4 })), {
		end_of_speech_ms: 900,
		speech_threshold: 0.6,
		silence_threshold: 0.4,
	});
});

test("the printed start command carries HARNESS_LISTEN, quoted, only when there is one", () => {
	const url = "ws://127.0.0.1:8788/session/t";
	assert.equal(manualStart({ url, character: "foxglove", listen: {} }), `HARNESS_URL=${url} HARNESS_CHARACTER="foxglove"`);
	assert.equal(
		manualStart({ url, character: "foxglove", listen: { barge_in_ms: 1000 } }),
		`HARNESS_URL=${url} HARNESS_CHARACTER="foxglove" HARNESS_LISTEN='{"barge_in_ms":1000}'`,
	);
});

// How much of the character a camera move leaves in view: the height seen at
// the point the player aims at, as player.c frames it (a move's fov is scaled
// from the stage's to the player's, and its distance is toward the character)
test("push-in and close-up frame tighter than the stage camera, close-up the tightest", () => {
	const player = path.resolve(import.meta.dirname, "../../player");
	const read = (file: string) => readFileSync(path.join(player, file), "utf8").replace(/\r\n/g, "\n");
	const config = read("src/app/app_config.h");
	const define = (name: string) => Number(new RegExp(`#define ${name} ([\\d.]+)f`).exec(config)![1]);
	const camFov = define("PLAYER_CAM_FOV"), stageFov = define("PLAYER_STAGE_FOV"), aimY = define("PLAYER_CAM_AIM_Y");
	const scene = read("assets/mutuals/main_scene/chunk_0.hzt");
	const camera = scene.slice(scene.indexOf("component Camera\n"));
	const [, y, z] = /^  pos (\S+) (\S+) (\S+)$/m.exec(camera)!.slice(1).map(Number);
	const reach = Math.hypot(y - aimY, z);
	const moves = read("assets/mutuals/camera_moves.hzt");
	const seen = new Map(
		[...moves.matchAll(/^ {2}name "([^"]+)"\n {2}fov (\S+)\n(?: {2}\w+ \S+\n)*? {2}distance (\S+)$/gm)].map((m) => {
			const fov = Number(m[2]) > 0 ? (Number(m[2]) * camFov) / stageFov : camFov;
			return [m[1], 2 * Math.tan((fov * Math.PI) / 360) * (reach - Number(m[3]))];
		}),
	);
	const stage = 2 * Math.tan((camFov * Math.PI) / 360) * reach;
	assert.deepEqual([...seen.keys()], ["hold", "push-in", "close-up", "pull-back"]);
	assert.equal(seen.get("pull-back"), stage);
	assert.ok(seen.get("push-in")! < stage);
	assert.ok(seen.get("close-up")! < seen.get("push-in")!);
});
