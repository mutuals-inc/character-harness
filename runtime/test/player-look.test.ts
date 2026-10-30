// How the player's toon shaders and stage are set up, read from player/. Run
// with `npm test`. The engine isn't needed: these read the shader and asset
// sources the player is cooked from.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const player = path.resolve(import.meta.dirname, "../../player");
const read = (file: string) => readFileSync(path.join(player, file), "utf8").replace(/\r\n/g, "\n");

// WebGPU guarantees 16 sampled textures per shader stage, and the engine's
// shader compiler fails a WGSL stage above that. The shadows take 2 and the
// sky light and fog 5 (hz_env, hz_ssr, hz_sky_aerial, hz_fog_volume, hz_clouds).
const WEBGPU_TEXTURES = 16;
const SHADOW_TEXTURES = 2;
const SKY_AND_FOG_TEXTURES = 5;

// the @texture2D fields of a shader's @material struct
const materialMaps = (glsl: string) => {
	const struct = glsl.slice(glsl.indexOf("@material\nstruct"), glsl.indexOf("};", glsl.indexOf("@material\nstruct")));
	return [...struct.matchAll(/@texture2D @\w+\n\s+uint (\w+);/g)].map((m) => m[1]);
};

test("the web toon shader has room for the sky light and fog on every FoxGlove material", () => {
	const glsl = read("shaders/mutuals/mtoon.glsl");
	const maps = materialMaps(glsl);
	// the maps a material can leave out, by the keyword that does it
	const optional = new Map([...glsl.matchAll(/^#ifdef MTOON_NO_(\w+)\n#define MTOON_HAS_\1 0$/gm)].map((m) => [m[1].toLowerCase(), `MTOON_NO_${m[1]}`]));
	assert.ok(optional.size > 0, "mtoon.glsl names no MTOON_NO_ keywords");
	for (const map of optional.keys()) assert.ok(maps.includes(map), `MTOON_NO_${map.toUpperCase()} names no map of the material`);
	assert.deepEqual(maps.filter((m) => !optional.has(m)), ["map", "normal_map"], "only map and normal_map always stay");
	// a left-out map reads on the web as what its default texture gives on the desktop
	for (const [map, kw] of optional) {
		const fallback = new RegExp(`^#define MTOON_SAMPLE_${map}\\(uv\\) vec4\\((\\S+)\\)$`, "m").exec(glsl)?.[1];
		const annotation = new RegExp(`@texture2D @(\\w+)\\n\\s+uint ${map};`).exec(glsl)?.[1];
		assert.equal(fallback, { white: "1.0", black: "0.0" }[annotation ?? ""], `${kw}: ${map} defaults to @${annotation} but reads as vec4(${fallback})`);
	}
	const limit = Number(/^#if !defined\(SHADER_BACKEND_WGSL\) \|\| MTOON_MAP_COUNT <= (\d+)$/m.exec(glsl)![1]);
	assert.equal(limit, WEBGPU_TEXTURES - SHADOW_TEXTURES - SKY_AND_FOG_TEXTURES);

	const dir = "assets/foxglove/materials";
	const files = readdirSync(path.join(player, dir)).filter((f) => f.endsWith(".hzt"));
	assert.ok(files.length > 0);
	for (const file of files) {
		const hzt = read(`${dir}/${file}`);
		if (!hzt.includes('shader_source "/shaders/mutuals/mtoon.glsl"')) continue;
		const set = new Set([...hzt.matchAll(/^ {2}name "(\w+)"\n {2}type MAT_PROP_TEXTURE$/gm)].map((m) => m[1]));
		// the material's own keywords, not its extra passes' (indented)
		const block = /^keywords (\d+)\n((?: {2}.*\n|\n)*?)(?=^\S)/m.exec(hzt)!;
		const keywords = [...block[2].matchAll(/^ {2}name "(\w+)"$/gm)].map((m) => m[1]);
		assert.equal(keywords.length, Number(block[1]), `${file}: keyword count`);
		const left = [...optional].filter(([, kw]) => keywords.includes(kw)).map(([map]) => map);
		for (const map of left)
			// on the web a left-out map reads as its default, so it must be unset: what native draws then too
			assert.ok(!set.has(map), `${file} leaves out ${map} but sets it`);
		const bound = maps.length - left.length;
		assert.ok(bound <= limit, `${file} binds ${bound} maps on the web; leave out unset ones to fit ${limit}`);
	}
});

test("the web outline shader fits the sky light and fog without leaving maps out", () => {
	const glsl = read("shaders/mutuals/mtoon_outline.glsl");
	assert.match(glsl, /^#define HZ_RENDERER_IBL\n#define HZ_RENDERER_FOG$/m);
	assert.doesNotMatch(glsl, /#ifndef SHADER_BACKEND_WGSL\n#define HZ_RENDERER_IBL/);
	assert.ok(materialMaps(glsl).length + SHADOW_TEXTURES + SKY_AND_FOG_TEXTURES <= WEBGPU_TEXTURES);
});

// The engine hands shaders a directional light as pre-exposed lux over pi, and
// the toon shader takes it as MToon's light colour: a sun of 1 shows the lit
// side at the base colour. At the engine's default exposure (EV100 15, which
// the player keeps) that is 1.2 x 2^15 x pi lux.
test("the stage's sun reaches the toon shader at 1", () => {
	assert.doesNotMatch(read("src/app/player.c"), /renderer_set_exposure_ev100|renderer_set_auto_exposure/);
	const scene = read("assets/mutuals/main_scene/chunk_0.hzt");
	const sun = scene.slice(scene.indexOf("component EcsDirectionalLight\n"));
	const lux = Number(/^ {2}intensity (\S+)$/m.exec(sun)![1]);
	const preExposure = 1 / (1.2 * 2 ** 15);
	assert.ok(Math.abs((lux * preExposure) / Math.PI - 1) < 1e-4, `the sun is ${lux} lux`);
});
