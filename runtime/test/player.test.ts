import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manualStart, startPlayer } from "../src/player.ts";

test("manual player settings can be pasted into PowerShell, including quotes in model paths", () => {
	assert.equal(manualStart({ url: "ws://127.0.0.1/session/token", character: "C:\\a b\\Fox's model.vrm" }, "win32"),
		"$env:HARNESS_URL='ws://127.0.0.1/session/token'; $env:HARNESS_CHARACTER='C:\\a b\\Fox''s model.vrm'");
	assert.equal(manualStart({ url: "ws://local/session/token", character: "/a b/model.vrm" }, "darwin"),
		'HARNESS_URL=ws://local/session/token HARNESS_CHARACTER="/a b/model.vrm"');
});

test("stopping the player command stops its descendants and excludes named keys", { timeout: 15000 }, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "harness-player-"));
	const marker = path.join(dir, "started.json");
	const script = path.join(dir, "player.mjs");
	const keyName = "HARNESS_TEST_SECRET";
	const oldKey = process.env[keyName];
	process.env[keyName] = "test-only";
	writeFileSync(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, child: child.pid,
  secretPresent: !!process.env.${keyName}, url: process.env.HARNESS_URL, character: process.env.HARNESS_CHARACTER }));
setInterval(() => {}, 1000);
`);
	const launch = { url: "ws://127.0.0.1/session/test", character: "test model.vrm" };
	let ended = false;
	const stop = startPlayer(`"${process.execPath}" "${script}"`, launch,
		new Set([process.platform === "win32" ? keyName.toLowerCase() : keyName]), () => { ended = true; });
	try {
		let started: { pid: number; child: number; secretPresent: boolean; url: string; character: string } | undefined;
		for (let i = 0; i < 100 && !started; i++) {
			try { started = JSON.parse(readFileSync(marker, "utf8")); } catch { await delay(50); }
		}
		assert.ok(started, "player command started");
		assert.equal(started.secretPresent, false);
		assert.equal(started.url, launch.url);
		assert.equal(started.character, launch.character);
		stop();
		for (let i = 0; i < 100 && !ended; i++) await delay(50);
		assert.ok(ended, "player command exits after stop");
		for (const pid of [started.pid, started.child]) {
			let alive = true;
			for (let i = 0; i < 100 && alive; i++) {
				try { process.kill(pid, 0); await delay(50); } catch { alive = false; }
			}
			assert.equal(alive, false, `process ${pid} stopped`);
		}
		stop(); // cleanup is safe after the command has exited
	} finally {
		stop();
		if (oldKey === undefined) delete process.env[keyName]; else process.env[keyName] = oldKey;
		rmSync(dir, { recursive: true, force: true });
	}
});
