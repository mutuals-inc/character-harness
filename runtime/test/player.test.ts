// What the runtime gives the player to start it. Run with `npm test`.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadCharacter } from "../src/manifest.ts";
import { listenEnv, manualStart } from "../src/player.ts";
import { readAccessor, readGlb } from "../src/rig/glb.ts";
import { compose, mmul, mpoint, type Mat4, type Quat, type Vec3 } from "../src/rig/math.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const player = path.join(repo, "player");
const read = (file: string) => readFileSync(path.join(player, file), "utf8").replace(/\r\n/g, "\n");
const config = read("src/app/app_config.h");
const define = (name: string) => Number(new RegExp(`#define ${name} ([\\d.]+)f`).exec(config)![1]);

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

// Where a cooked-in character's head is in its bind pose, from its own files:
// the eyes and chest from the rig's roles, and the top of the head from the highest
// vertex that follows the head joint (or a joint under it, like the hair's),
// leaving out the joints the rig hides.
function head(profile: string) {
	const assets = path.join(player, "assets");
	const field = (text: string, name: string) => new RegExp(`^${name} "([^"]+)"`, "m").exec(text)![1];
	const profileText = read(`assets/characters/${profile}.hzt`);
	const rig = read(`assets/${field(profileText, "rig").replace(/\.hza$/, ".hzt")}`);
	const role = (name: string) => new RegExp(`^  role "${name}"\\n  joint "([^"]+)"$`, "m").exec(rig)![1];
	const hidden = new Set([...(/^hidden \d+ (.*)$/m.exec(rig)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));
	// a model cooks to <folder>/<name>/<name>.hza from <folder>/<name>.glb or .vrm
	const cooked = field(profileText, "model");
	const base = path.join(assets, path.dirname(path.dirname(cooked)), path.basename(cooked, ".hza"));
	const source = [".glb", ".vrm"].map((ext) => base + ext).find((f) => existsSync(f));
	assert.ok(source, `${profile}: no ${base}.glb or .vrm to read the head from`);
	const glb = readGlb(source);
	const nodes = glb.json.nodes!;
	const parent = new Map<number, number>();
	nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
	const world: Mat4[] = [];
	const at = (i: number): Mat4 => {
		const n = nodes[i];
		const local = n.matrix ?? compose((n.translation ?? [0, 0, 0]) as Vec3, (n.rotation ?? [0, 0, 0, 1]) as Quat, (n.scale ?? [1, 1, 1]) as Vec3);
		return (world[i] ??= parent.has(i) ? mmul(at(parent.get(i)!), local) : local);
	};
	const index = (name: string) => nodes.findIndex((n) => n.name === name);
	const eye = [role("eye_l"), role("eye_r")].map((j) => mpoint(at(index(j)), [0, 0, 0]));
	const chest = mpoint(at(index(role("chest"))), [0, 0, 0]);
	const headJoint = index(role("head"));
	const underHead = (i: number): boolean => !hidden.has(nodes[i].name ?? "") && (i === headJoint || (parent.has(i) && underHead(parent.get(i)!)));
	const skins = glb.json.skins as { joints: number[]; inverseBindMatrices?: number }[];
	let top = -Infinity;
	nodes.forEach((n) => {
		const skin = (n as { skin?: number }).skin;
		if (n.mesh === undefined || skin === undefined) return;
		const follows = skins[skin].joints.map(underHead);
		// a vertex's bind position: its joint's world matrix over the joint's inverse bind
		const inverseBind = skins[skin].inverseBindMatrices;
		const ibm = inverseBind === undefined ? undefined : readAccessor(glb, inverseBind);
		const bind = skins[skin].joints.map((j, k) => (ibm ? mmul(at(j), Array.from(ibm.subarray(k * 16, k * 16 + 16))) : at(j)));
		for (const prim of (glb.json.meshes as { primitives: { attributes: Record<string, number> }[] }[])[n.mesh].primitives) {
			const pos = readAccessor(glb, prim.attributes.POSITION);
			const joints = readAccessor(glb, prim.attributes.JOINTS_0);
			const weights = readAccessor(glb, prim.attributes.WEIGHTS_0);
			for (let v = 0; v < pos.length / 3; v++) {
				let k = 0;
				for (let c = 1; c < 4; c++) if (weights[v * 4 + c] > weights[v * 4 + k]) k = c;
				const j = joints[v * 4 + k];
				if (follows[j]) top = Math.max(top, mpoint(bind[j], [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])[1]);
			}
		}
	});
	return { eye: [(eye[0][0] + eye[1][0]) / 2, (eye[0][1] + eye[1][1]) / 2, (eye[0][2] + eye[1][2]) / 2] as Vec3, top, chest };
}

// The close-up keeps the whole head in view, the eyes in the upper part of the
// frame and centred, on a landscape Studio stage and a portrait window, and at
// every step of its transition. The camera is placed as player.c does: the
// stage camera raised by the character's eye height over the stage's, aimed
// at PLAYER_CAM_AIM_Y over it, then the move applied along the camera's own
// axes, its fov widened on a stage narrower than PLAYER_CAM_MOVE_MIN_ASPECT.
test("the close-up frames the head and shoulders, landscape and portrait", () => {
	const camFov = define("PLAYER_CAM_FOV"), stageFov = define("PLAYER_STAGE_FOV"), aimY = define("PLAYER_CAM_AIM_Y");
	const minAspect = define("PLAYER_CAM_MOVE_MIN_ASPECT");
	const scene = read("assets/mutuals/main_scene/chunk_0.hzt");
	const camera = scene.slice(scene.indexOf("component Camera\n"));
	const camPos = /^  pos (\S+) (\S+) (\S+)$/m.exec(camera)!.slice(1).map(Number) as Vec3;
	const framedEye = Number(/^  framed_eye_height (\S+)$/m.exec(scene)![1]);
	const block = /^ {2}name "close-up"\n((?: {2}\w+ \S+\n?)+)/m.exec(read("assets/mutuals/camera_moves.hzt"))![1];
	const value = (k: string) => Number(new RegExp(`^ {2}${k} (\\S+)$`, "m").exec(block)![1]);
	const closeUp = { fov: (value("fov") * camFov) / stageFov, x: value("x"), y: value("y"), distance: value("distance") };
	assert.ok(value("fov") > 0, "the close-up sets its own fov");

	const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
	const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const unit = (a: Vec3): Vec3 => a.map((x) => x / Math.hypot(...a)) as Vec3;
	const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const tanHalf = (deg: number) => Math.tan((deg * Math.PI) / 360);

	const profiles = readdirSync(path.join(repo, "characters"))
		.filter((id) => existsSync(path.join(repo, "characters", id, "character.yaml")))
		.map((id) => loadCharacter(path.join(repo, "characters", id)).rig)
		.flatMap((rig) => (rig.kind === "profile" ? [rig.profile] : []));
	assert.ok(profiles.length > 0, "a character with a cooked-in profile to check");
	for (const profile of profiles) {
		const { eye, top, chest } = head(profile);
		const lift = eye[1] - framedEye;
		const base: Vec3 = [camPos[0], camPos[1] + lift, camPos[2]];
		const aim: Vec3 = [0, aimY + lift, 0];
		const forward = unit(sub(aim, base));
		const right = unit(cross(forward, [0, 1, 0]));
		const up = cross(right, forward);
		const reach = Math.hypot(...sub(aim, base));
		for (const [stage, w, h] of [["landscape Studio stage", 536, 385], ["4:3 Studio stage", 960, 720], ["portrait window", 540, 900]] as const) {
			const aspect = w / h;
			let to = closeUp;
			if (aspect < minAspect) {
				const wide = (tanHalf(to.fov) * minAspect) / aspect;
				to = { ...to, y: to.y - (reach - to.distance) * (wide - tanHalf(to.fov)), fov: (360 / Math.PI) * Math.atan(wide) };
			}
			// eased from the stage camera; every curve runs 0 to 1, so these steps cover it
			for (let step = 0; step <= 10; step++) {
				const a = step / 10;
				const m = { fov: camFov + (to.fov - camFov) * a, x: to.x * a, y: to.y * a, distance: to.distance * a };
				const from: Vec3 = [0, 1, 2].map((i) => base[i] + right[i] * m.x + up[i] * m.y + forward[i] * m.distance) as Vec3;
				const t = tanHalf(m.fov);
				// 0 at the top of the frame, 1 at the bottom; 0 at the centre across
				const down = (p: Vec3) => 0.5 - dot(sub(p, from), up) / (2 * dot(sub(p, from), forward) * t);
				const across = (p: Vec3) => dot(sub(p, from), right) / (dot(sub(p, from), forward) * t * aspect);
				const crown: Vec3 = [eye[0], top, eye[2]];
				const where = `${profile}, ${stage}, ${Math.round(a * 100)}% into the move`;
				assert.ok(down(crown) >= 0.04, `${where}: the top of the head is cut off or touches the frame (${down(crown).toFixed(3)})`);
				assert.ok(Math.abs(across(eye)) < 0.1, `${where}: the face is off centre (${across(eye).toFixed(3)})`);
				if (step < 10) continue;
				assert.ok(down(eye) > 0.15 && down(eye) < 0.4, `${where}: the eyes are not in the upper part of the frame (${down(eye).toFixed(3)})`);
				// measured at the face, in the character's own proportions
				const depth = dot(sub(eye, from), forward);
				const tall = 2 * depth * t, wide = tall * aspect;
				const below = (1 - down(eye)) * tall;
				if (aspect >= minAspect)
					// head and bust: the frame ends well above the waist
					assert.ok(below < 1.6 * (eye[1] - chest[1]), `${where}: the frame reaches the waist (${below.toFixed(3)} m under the eyes)`);
				// head and shoulders: the frame is a good deal wider than the head
				else assert.ok(wide > 2.5 * (top - eye[1]), `${where}: the frame is too narrow for the shoulders (${wide.toFixed(3)} m)`);
			}
		}
	}
});
