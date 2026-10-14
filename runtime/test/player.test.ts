// Player launch settings, credential isolation and process-tree cleanup. No network.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { manualStart, startPlayer } from "../src/player.ts";

async function waitFor(check: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < deadline, message);
		await delay(50);
	}
}

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw e;
	}
}

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
		await waitFor(() => existsSync(marker), "player command started");
		const started = JSON.parse(readFileSync(marker, "utf8"));
		assert.equal(started.secretPresent, false);
		assert.equal(started.url, launch.url);
		assert.equal(started.character, launch.character);
		stop();
		await waitFor(() => ended, "player command exits after stop");
		await waitFor(() => !running(started.pid) && !running(started.child), "player and its child stopped");
		stop(); // cleanup is safe after the command has exited
	} finally {
		stop();
		if (oldKey === undefined) delete process.env[keyName]; else process.env[keyName] = oldKey;
		rmSync(dir, { recursive: true, force: true });
	}
});
