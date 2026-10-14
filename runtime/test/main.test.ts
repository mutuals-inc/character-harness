// Runtime startup with settings from .env. Uses only a local HTTP connection.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("runtime reads HOST and PORT from the character's env file", { timeout: 10000 }, async () => {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const address = probe.address();
	assert.ok(address && typeof address === "object");
	const port = address.port;
	await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
	const root = path.resolve(import.meta.dirname, "../..");
	const dir = mkdtempSync(path.join(tmpdir(), "harness-startup-"));
	writeFileSync(path.join(dir, "system.md"), "You are a test.");
	writeFileSync(path.join(dir, "character.yaml"), `schema: 1
id: startup-test
name: Startup test
description: A character for the tests.
author: tests
license: none
prompt: system.md
models:
  chat: { api: chat_completions, base_url: "https://example.invalid/v1", api_key_env: STARTUP_TEST_KEY, model: m }
stt: { provider: elevenlabs, model: scribe_v2_realtime }
voice: { provider: elevenlabs, voice_id: v, model: eleven_v4_turbo }
rig: { profile: test, engine: ">=0.5.8" }
emotions: test
extensions: []
env_file: .env
`);
	writeFileSync(path.join(dir, ".env"), `HOST=127.0.0.1\nPORT=${port}\nSTARTUP_TEST_KEY=test-only\nELEVENLABS_API_KEY=test-only\n`);
	const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_PLAYER: "" };
	delete env.HOST;
	delete env.PORT;
	const child = spawn(process.execPath, [path.join(root, "runtime/src/main.ts"), dir], {
		env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
	});
	const closed = once(child, "close");
	let output = "", errors = "";
	child.stdout.on("data", (b) => { output += b; });
	child.stderr.on("data", (b) => { errors += b; });
	try {
		for (let i = 0; i < 100 && !output.includes(`ws://127.0.0.1:${port}/session/`); i++) {
			if (child.exitCode !== null) break;
			await delay(50);
		}
		assert.ok(output.includes(`ws://127.0.0.1:${port}/session/`), errors || "runtime started on env-file port");
		const response = await fetch(`http://127.0.0.1:${port}`);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /Startup test/);
	} finally {
		child.kill();
		await closed;
		rmSync(dir, { recursive: true, force: true });
	}
});
