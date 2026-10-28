import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import path from "node:path";
import WebSocket from "ws";
import { characterById, ROOT } from "../server/catalog.ts";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { parseDocument } from "yaml";

test(
  "the production host protects metadata and rejects cross-origin sessions and writes",
  { timeout: 15000 },
  async (context) => {
    const port = 32000 + Math.floor(Math.random() * 10000);
    const host = `127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      [path.resolve(import.meta.dirname, "../server/index.ts"), "--production"],
      {
        env: { ...process.env, FRONTEND_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    context.after(() => {
      child.kill();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Studio startup timed out.")),
        9000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Studio exited during startup."));
      });
      child.stdout.on("data", (data) => {
        if (String(data).includes("Mutuals Character Studio:")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    function get(
      url: string,
      method = "GET",
      headers: Record<string, string> = {},
      data?: string,
    ) {
      return new Promise<{ status: number; cookie?: string; body: string }>(
        (resolve, reject) => {
          const req = request(
            `http://${host}${url}`,
            { method, headers },
            (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += chunk;
              });
              res.on("end", () =>
                resolve({
                  status: res.statusCode!,
                  cookie: res.headers["set-cookie"]?.[0],
                  body,
                }),
              );
            },
          );
          req.on("error", reject);
          req.end(data);
        },
      );
    }
    assert.equal((await get("/api/bootstrap")).status, 401);
    assert.equal((await get("/api/native-stage?character=foxglove")).status, 401);
    assert.equal(
      (await get("/", "GET", { Host: `untrusted.test:${port}` })).status,
      403,
    );
    assert.equal(
      (await get("/api/extensions/import", "POST", {}, "{}")).status,
      401,
    );
    const opened = await get("/");
    assert.equal(opened.status, 200);
    assert.match(opened.cookie!, /HttpOnly; SameSite=Strict/);
    const cookie = opened.cookie!.split(";")[0];
    const native = await get('/api/native-stage?character=foxglove','GET',{Cookie:cookie});
    assert.equal(native.status,200);
    assert.deepEqual(JSON.parse(native.body),{character:characterById('foxglove').rig.kind==='profile' ? (characterById('foxglove').rig as {profile:string}).profile : ''});
    assert.equal((await get('/api/native-stage?character=missing-character','GET',{Cookie:cookie})).status,400);
    assert.equal(
      (
        await get(
          "/api/extensions/import",
          "POST",
          { Cookie: cookie, Origin: "https://untrusted.test" },
          "{}",
        )
      ).status,
      403,
    );
    const metadata = await get("/api/bootstrap", "GET", { Cookie: cookie });
    assert.equal(metadata.status, 200);
    const body = JSON.parse(metadata.body);
    assert.equal(body.hooks.length, 8);
    assert.ok(body.chatPresets.length > 0);
    const foxglove = characterById("foxglove");
    assert.equal(body.voicePresets[0].name, foxglove.name);
    assert.equal(body.voicePresets[0].voiceId, foxglove.voice.voice_id);
    assert.equal(
      new Set(
        body.voicePresets.map((preset: { voiceId: string }) => preset.voiceId),
      ).size,
      body.voicePresets.length,
    );
    assert.ok(
      body.chatPresets.every(
        (preset: object) =>
          Object.keys(preset).sort().join(",") === "api,baseUrl,keyName,model",
      ),
    );
    assert.ok(
      body.character.keys.every(
        (key: object) => Object.keys(key).sort().join(",") === "name,ready",
      ),
    );
    assert.equal(
      (
        await get(
          "/api/character",
          "POST",
          { Cookie: cookie, Origin: "https://untrusted.test" },
          "{}",
        )
      ).status,
      403,
    );
    assert.equal(
      (await get("/api/provider-keys", "POST", {}, "{}")).status,
      401,
    );
    assert.equal(
      (
        await get(
          "/api/provider-keys",
          "POST",
          { Cookie: cookie, Origin: "https://untrusted.test" },
          "{}",
        )
      ).status,
      403,
    );
    const fixture = mkdtempSync(
      path.join(ROOT, "characters", "provider-key-test-"),
    );
    context.after(() => {
      assert.equal(path.dirname(fixture), path.join(ROOT, "characters"));
      assert.ok(path.basename(fixture).startsWith("provider-key-test-"));
      const archive = path.join(ROOT, ".cache/frontend/test-artifacts");
      mkdirSync(archive, { recursive: true });
      if (existsSync(fixture))
        renameSync(
          fixture,
          path.join(archive, `${path.basename(fixture)}-${Date.now()}`),
        );
    });
    const manifest = parseDocument(
      readFileSync(path.join(foxglove.dir, "character.yaml"), "utf8"),
    );
    const id = path.basename(fixture).toLowerCase();
    manifest.set("id", id);
    manifest.set("env_file", ".env");
    manifest.set("prompt", "system.md");
    manifest.set("extensions", []);
    manifest.set("disabled_extensions", []);
    writeFileSync(path.join(fixture, "character.yaml"), String(manifest));
    writeFileSync(
      path.join(fixture, "system.md"),
      "A local credential test fixture.",
    );
    writeFileSync(
      path.join(fixture, ".env"),
      'ELEVENLABS_API_KEY="dummy-original-speech"\n',
    );
    const savedKeys = await get(
      "/api/provider-keys",
      "POST",
      {
        Cookie: cookie,
        Origin: `http://${host}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        id,
        keys: {
          [foxglove.chat.api_key_env]: "dummy-new-chat",
          ELEVENLABS_API_KEY: "",
        },
      }),
    );
    assert.equal(savedKeys.status, 200, savedKeys.body);
    assert.ok(!savedKeys.body.includes("dummy-new-chat"));
    assert.ok(!savedKeys.body.includes("dummy-original-speech"));
    const status = JSON.parse(savedKeys.body).keys;
    assert.ok(status.every((key: { ready: boolean }) => key.ready));
    assert.ok(
      status.every(
        (key: object) => Object.keys(key).sort().join(",") === "name,ready",
      ),
    );
    assert.equal(
      (await get("/api/character-delete", "POST", {}, "{}")).status,
      401,
    );
    assert.equal(
      (
        await get(
          "/api/character-delete",
          "POST",
          { Cookie: cookie, Origin: "https://untrusted.test" },
          "{}",
        )
      ).status,
      403,
    );
    const headers = {
      Cookie: cookie,
      Origin: `http://${host}`,
      "Content-Type": "application/json",
    };
    const protectedDelete = await get(
      "/api/character-delete",
      "POST",
      headers,
      JSON.stringify({ id: foxglove.id, revision: body.character.revision }),
    );
    assert.equal(protectedDelete.status, 400);
    assert.match(protectedDelete.body, /built-in/);
    const deleted = await get(
      "/api/character-delete",
      "POST",
      headers,
      JSON.stringify({ id, revision: JSON.parse(savedKeys.body).revision }),
    );
    assert.equal(deleted.status, 200, deleted.body);
    const afterDelete = JSON.parse(
      (await get("/api/bootstrap", "GET", { Cookie: cookie })).body,
    );
    assert.ok(
      !afterDelete.characters.some(
        (character: { id: string }) => character.id === id,
      ),
    );
    const refused = new WebSocket(
      `ws://${host}/studio-session?character=${body.character.id}`,
      { headers: { Cookie: cookie, Origin: "https://untrusted.test" } },
    );
    const [error] = await once(refused, "error");
    assert.match(String(error), /socket hang up|Unexpected server response/);
    refused.terminate();
  },
);
