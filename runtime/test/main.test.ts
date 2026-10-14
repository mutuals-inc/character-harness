import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import YAML from "yaml";

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
	const manifest = YAML.parse(readFileSync(path.join(root, "characters/foxglove/character.yaml"), "utf8"));
	manifest.id = "startup-test";
	manifest.name = "Startup test";
	manifest.prompt = path.join(root, "characters/foxglove/system.md");
	manifest.models.chat.api_key_env = "STARTUP_TEST_KEY";
	manifest.env_file = ".env";
	manifest.extensions = [];
	writeFileSync(path.join(dir, "character.yaml"), YAML.stringify(manifest));
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
