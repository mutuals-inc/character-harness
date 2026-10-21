import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCharacter } from "../../runtime/src/manifest.ts";
import {
  describeCharacter,
  revision,
  saveCharacter,
} from "../server/catalog.ts";

test("character edits preserve YAML comments, reject stale revisions and protect provider configuration", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mutuals-studio-test-"));
  const file = path.join(dir, "character.yaml");
  const prompt = path.join(dir, "system.md");
  const original = `# Keep this comment\nschema: 1\nid: studio-test\nname: Test Character\ndescription: A test character.\nauthor: Mutuals\nlicense: Apache-2.0\nprompt: system.md\nmodels:\n  chat:\n    api: chat_completions\n    base_url: https://example.test/v1\n    api_key_env: STUDIO_TEST_KEY\n    model: fixture\nvoice:\n  provider: elevenlabs\n  voice_id: fixture\n  model: fixture\nstt:\n  provider: elevenlabs\n  model: fixture\nrig:\n  engine: '>=0.5.8'\n  profile: foxglove\nemotions: foxglove\nextensions: []\nenv_file: .env\n`;
  writeFileSync(file, original);
  writeFileSync(prompt, "You are a test character.");
  try {
    const c = loadCharacter(dir);
    const before = revision(c);
    const result = await saveCharacter(c, {
      revision: before,
      name: "Changed Name",
      temperature: 0.65,
      prompt: "Updated personality.",
      base_url: "https://untrusted.test",
      api_key_env: "ATTACKER_KEY",
    });
    assert.equal(result.name, "Changed Name");
    assert.equal(result.prompt, "Updated personality.");
    assert.equal(result.temperature, 0.65);
    assert.equal(result.baseUrl, "https://example.test/v1");
    assert.ok(readFileSync(file, "utf8").startsWith("# Keep this comment"));
    assert.equal(loadCharacter(dir).chat.api_key_env, "STUDIO_TEST_KEY");
    await assert.rejects(
      saveCharacter(loadCharacter(dir), { revision: before, name: "Stale" }),
      /changed on disk/,
    );
    const saved = readFileSync(file, "utf8");
    await assert.rejects(
      saveCharacter(loadCharacter(dir), {
        revision: result.revision,
        stability: 2,
      }),
      /out of range/,
    );
    assert.equal(readFileSync(file, "utf8"), saved);
    const description = await describeCharacter(loadCharacter(dir));
    assert.ok(
      description.keys.every(
        (key) => Object.keys(key).sort().join(",") === "name,ready",
      ),
    );
    assert.ok(description.hiddenJoints.length > 0);
    assert.ok(Object.keys(description.expressions).length > 0);
  } finally {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith("mutuals-studio-test-"));
    rmSync(dir, { recursive: true, force: true });
  }
});
