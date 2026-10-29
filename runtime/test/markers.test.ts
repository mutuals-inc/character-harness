// The bundled extensions import nothing from the runtime, so each writes out
// the markers it reads again; these must be the runtime's. Run with `npm test`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as markers from "../src/markers.ts";

const root = path.join(import.meta.dirname, "../../extensions");

test("every extension's copy of a marker is the runtime's", () => {
	let copies = 0;
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		for (const file of readdirSync(path.join(root, dir.name), { recursive: true, encoding: "utf8" })) {
			if (!/\.[cm]?[jt]s$/.test(file) || file.includes("node_modules")) continue;
			const source = readFileSync(path.join(root, dir.name, file), "utf8");
			for (const [name, value] of Object.entries(markers)) {
				for (const m of source.matchAll(new RegExp(`\\bconst ${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`, "g"))) {
					assert.equal(JSON.parse(m[1]), value, `${dir.name}/${file} has ${name} = ${m[1]}`);
					copies++;
				}
			}
		}
	}
	// memory and reactions each have ACTED_TURN
	assert.ok(copies >= 2, `found ${copies} copies`);
});
