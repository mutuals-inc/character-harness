import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { saveProviderKeys } from "../server/provider-keys.ts";

test("provider key replacement preserves unrelated values, comments and blank fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "provider-keys-test-"));
  const file = path.join(root, ".env");
  try {
    writeFileSync(
      file,
      '# Keep this comment\r\n\texport CHAT_KEY="old\nmultiline"\r\nSPEECH_KEY="keep-speech"\r\nOTHER="keep # this"\r\n',
    );
    assert.equal(
      saveProviderKeys(
        file,
        ["CHAT_KEY", "SPEECH_KEY", "NEW_KEY"],
        { CHAT_KEY: "dummy-$#=value", SPEECH_KEY: "", NEW_KEY: "dummy-new" },
        root,
      ),
      undefined,
    );
    const saved = readFileSync(file, "utf8");
    const parsed = parseEnv(saved);
    assert.equal(parsed.CHAT_KEY, "dummy-$#=value");
    assert.equal(parsed.SPEECH_KEY, "keep-speech");
    assert.equal(parsed.OTHER, "keep # this");
    assert.equal(parsed.NEW_KEY, "dummy-new");
    assert.ok(saved.startsWith("# Keep this comment\r\n\texport CHAT_KEY="));
    assert.deepEqual(readdirSync(root), [".env"]);
    const before = saved;
    for (const input of [
      { UNRELATED: "no" },
      { CHAT_KEY: "bad\nINJECTED=yes" },
      { CHAT_KEY: 'bad"quote' },
      { CHAT_KEY: "" },
    ])
      assert.throws(() => saveProviderKeys(file, ["CHAT_KEY"], input, root));
    assert.equal(readFileSync(file, "utf8"), before);
    const unusual =
      'OTHER="text\nCHAT_KEY=inside-another-value\n"\nCHAT_KEY="old"\n';
    writeFileSync(file, unusual);
    assert.throws(
      () =>
        saveProviderKeys(file, ["CHAT_KEY"], { CHAT_KEY: "dummy-new" }, root),
      /safely/,
    );
    assert.equal(readFileSync(file, "utf8"), unusual);
    assert.throws(
      () =>
        saveProviderKeys(
          path.join(root, "package.json"),
          ["CHAT_KEY"],
          { CHAT_KEY: "dummy" },
          root,
        ),
      /local .env/,
    );
    assert.throws(
      () =>
        saveProviderKeys(
          path.join(root, "..", ".env"),
          ["CHAT_KEY"],
          { CHAT_KEY: "dummy" },
          root,
        ),
      /local .env/,
    );
  } finally {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("provider-keys-test-"));
    rmSync(root, { recursive: true, force: true });
  }
});
