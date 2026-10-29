import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { importExtension } from "../server/extension-import.ts";

const manifest =
  "name: import-test\nhandler: index.ts\nhooks: [after_turn]\nrequires_env: []\n";
const archive = (entries: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([name, value]) => [name, strToU8(value)]),
    ),
  );
test("extension import validates packages without executing code and refuses replacement", () => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-extension-"));
  try {
    const handler = 'throw new Error("must not execute during installation");';
    const bytes = archive({
      "package/extension.yaml": manifest,
      "package/index.ts": handler,
      "package/defaults.yaml": "enabled: true\n",
    });
    assert.equal(importExtension(bytes, root), "extensions/import-test");
    assert.equal(
      readFileSync(path.join(root, "extensions/import-test/index.ts"), "utf8"),
      handler,
    );
    assert.throws(() => importExtension(bytes, root), /already installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("extension import rejects traversal, secrets, missing handlers, unknown hooks and excessive expansion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-extension-"));
  try {
    for (const entries of [
      { "extension.yaml": manifest, "../index.ts": "bad" },
      { "extension.yaml": manifest, "index.ts": "ok", ".env": "SECRET=bad" },
      { "extension.yaml": manifest },
      {
        "extension.yaml": manifest.replace("after_turn", "unknown"),
        "index.ts": "ok",
      },
      {
        "extension.yaml": manifest,
        "index.ts": "ok",
        "huge.txt": "a".repeat(51 * 1024 * 1024),
      },
      { "extension.yaml": manifest, "index.ts": "ok", "INDEX.ts": "duplicate" },
    ] as Record<string, string>[])
      assert.throws(() => importExtension(archive(entries), root));
    assert.equal(existsSync(path.join(root, "extensions/import-test")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("service-only packages match the runtime manifest and require a local module", () => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-extension-"));
  try {
    const service = "name: service-test\nhandler: index.ts\nservice: true\n";
    assert.equal(
      importExtension(
        archive({
          "extension.yaml": service,
          "index.ts": "export async function service() {}",
        }),
        root,
      ),
      "extensions/service-test",
    );
    assert.throws(
      () =>
        importExtension(
          archive({
            "extension.yaml": service
              .replace("service-test", "remote-test")
              .replace("index.ts", "https://example.test/handler"),
          }),
          root,
        ),
      /local module/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
