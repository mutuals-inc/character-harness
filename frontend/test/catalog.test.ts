import {
  createCharacter,
  updateAssets,
  updateExtensions,
  deleteCharacter,
} from "../server/character-files.ts";
import { fixtureGlb } from "../../runtime/test/fixture.ts";
import { writeGlb } from "../../runtime/src/rig/glb.ts";
import { availableExtensions } from "../server/extensions.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCharacter } from "../../runtime/src/manifest.ts";
import {
  describeCharacter,
  characterById,
  listCharacters,
  portraitFile,
  ROOT,
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
    assert.equal(result.author, "Mutuals");
    assert.equal(result.license, "Apache-2.0");
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

function freshCharacterForm(name: string) {
  const model = fixtureGlb();
  const humanoid = (
    model.json.extensions!.VRMC_vrm_animation as { humanoid: unknown }
  ).humanoid;
  model.json.extensions = {
    VRMC_vrm: {
      specVersion: "1.0",
      meta: {
        name: "Test model",
        authors: ["Tests"],
        licenseUrl: "https://vrm.dev/licenses/1.0/",
      },
      humanoid,
    },
  };
  model.json.extensionsUsed = ["VRMC_vrm"];
  const form = new FormData();
  form.set("model", new Blob([new Uint8Array(writeGlb(model))]), "model.vrm");
  form.set(
    "portrait",
    new Blob([
      new Uint8Array(readFileSync(path.join(ROOT, "docs/images/foxglove.jpg"))),
    ]),
    "portrait.jpg",
  );
  form.set(
    "definition",
    JSON.stringify({
      name,
      description: "An independently authored test character.",
      prompt: "A completely fresh personality.",
      api: "chat_completions",
      baseUrl: "https://example.test/v1",
      keyName: "TEST_CHAT_KEY",
      model: "test-model",
      temperature: 0.6,
      voiceId: "test-voice",
      voiceModel: "test-voice-model",
      stability: 0.5,
      similarity: 0.7,
      sttModel: "scribe_v2_realtime",
      language: "en",
      extensions: availableExtensions().map((e) => ({
        id: e.id,
        enabled: false,
        config: e.defaultConfig,
      })),
      animations: [],
    }),
  );
  return form;
}

test("characters are created from uploads with independent prompts, assets and extension settings", async () => {
  const created: string[] = [];
  const original = readFileSync(
    path.join(characterById("foxglove").dir, "character.yaml"),
    "utf8",
  );
  try {
    const name = `Library test ${Date.now()}`;
    const first = await createCharacter(freshCharacterForm(name));
    created.push(first.id);
    const second = await createCharacter(freshCharacterForm(name));
    created.push(second.id);
    assert.notEqual(first.id, second.id);
    let c = characterById(first.id);
    assert.equal(c.prompt, "A completely fresh personality.");
    assert.equal(c.manifest.author, "Local creator");
    assert.equal(c.manifest.license, "All rights reserved");
    assert.equal(c.voice.voice_id, "test-voice");
    assert.equal(c.chat.model, "test-model");
    assert.equal(c.rig.kind, "model");
    if (c.rig.kind === "model") assert.equal(path.dirname(c.rig.model), c.dir);
    assert.ok(portraitFile(c)?.startsWith(c.dir));
    assert.equal(c.extensions.length, 0);
    const info = await describeCharacter(c);
    assert.ok(info.extensionSettings.length >= 4);
    await updateExtensions(c, {
      revision: revision(c),
      extensions: info.extensionSettings.map((e) => ({
        ...e,
        enabled: e.id === "extensions/memory",
      })),
    });
    c = characterById(first.id);
    assert.deepEqual(
      c.extensions.map((e) => e.name),
      ["memory"],
    );
    assert.deepEqual(characterById(second.id).extensions, []);
    const ordered = (await describeCharacter(c)).extensionSettings;
    assert.deepEqual(
      ordered.map((extension) => extension.id),
      info.extensionSettings.map((extension) => extension.id),
    );
    const reordered = [...ordered].reverse();
    reordered[0].config += "\n# Keep this configuration with its extension.\n";
    await updateExtensions(c, { revision: revision(c), extensions: reordered });
    c = characterById(first.id);
    const savedOrder = (await describeCharacter(c)).extensionSettings;
    assert.deepEqual(savedOrder, reordered);
    assert.deepEqual(
      c.extensions.map((extension) => extension.name),
      ["memory"],
    );
    const before = revision(c);
    await assert.rejects(
      updateExtensions(c, {
        revision: before,
        extensions: [{ id: "extensions/memory", enabled: true, config: "{}" }],
      }),
    );
    assert.equal(revision(characterById(first.id)), before);
    const assets = new FormData();
    assets.set(
      "definition",
      JSON.stringify({
        revision: before,
        animations: [
          { kind: "gesture", name: "wave", hold: true, file: "clip" },
        ],
      }),
    );
    assets.set(
      "clip",
      new Blob([new Uint8Array(writeGlb(fixtureGlb()))]),
      "wave.vrma",
    );
    await updateAssets(c, assets);
    c = characterById(first.id);
    assert.equal(c.rig.kind, "model");
    if (c.rig.kind === "model")
      assert.equal(c.rig.gestures.get("wave")?.hold, true);
    assert.ok(listCharacters().some((e) => e.id === first.id && e.portrait));
    assert.equal(
      readFileSync(
        path.join(characterById("foxglove").dir, "character.yaml"),
        "utf8",
      ),
      original,
    );
    await assert.rejects(
      updateExtensions(c, { revision: before, extensions: [] }),
      /changed on disk/,
    );
    const bad = freshCharacterForm("Invalid upload");
    bad.set("model", new Blob(["not a model"]), "bad.vrm");
    await assert.rejects(createCharacter(bad), /Invalid model/);
    const builtIn = characterById("foxglove");
    assert.ok(
      listCharacters().find((character) => character.id === builtIn.id)
        ?.protected,
    );
    assert.throws(
      () => deleteCharacter(builtIn, revision(builtIn)),
      /built-in/,
    );
    const removable = characterById(second.id);
    assert.throws(() => deleteCharacter(removable, "stale"), /changed on disk/);
    deleteCharacter(removable, revision(removable));
    created.splice(created.indexOf(second.id), 1);
    assert.ok(
      !listCharacters().some((character) => character.id === second.id),
    );
    const archive = path.join(ROOT, ".cache/frontend/deleted-characters");
    const recovered = readdirSync(archive).find((name) =>
      name.startsWith(`${second.id}-`),
    );
    assert.ok(recovered);
    assert.equal(
      readFileSync(path.join(archive, recovered, "system.md"), "utf8").trim(),
      "A completely fresh personality.",
    );
  } finally {
    for (const id of created) {
      const dir = path.resolve(ROOT, "characters", id);
      assert.equal(path.dirname(dir), path.join(ROOT, "characters"));
      assert.ok(id.startsWith("library-test-"));
      const archive = path.join(ROOT, ".cache/frontend/test-artifacts");
      mkdirSync(archive, { recursive: true });
      renameSync(dir, path.join(archive, id));
    }
  }
});

test("portrait lookup accepts local images and rejects files outside the repository or non-images", () => {
  const source = characterById("foxglove");
  assert.ok(portraitFile(source)?.endsWith("foxglove.jpg"));
  assert.equal(
    portraitFile({
      ...source,
      manifest: { ...source.manifest, portrait: "../../.env" },
    }),
    null,
  );
  const dir = mkdtempSync(path.join(tmpdir(), "mutuals-portrait-test-"));
  try {
    const outside = path.join(dir, "portrait.jpg");
    writeFileSync(outside, "not a repository asset");
    assert.equal(
      portraitFile({
        ...source,
        manifest: { ...source.manifest, portrait: outside },
      }),
      null,
    );
  } finally {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith("mutuals-portrait-test-"));
    rmSync(dir, { recursive: true, force: true });
  }
});
