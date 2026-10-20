import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import path from "node:path";
import WebSocket from "ws";

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
    assert.equal(
      (await get("/", "GET", { Host: `untrusted.test:${port}` })).status,
      403,
    );
    const opened = await get("/");
    assert.equal(opened.status, 200);
    assert.match(opened.cookie!, /HttpOnly; SameSite=Strict/);
    const cookie = opened.cookie!.split(";")[0];
    const metadata = await get("/api/bootstrap", "GET", { Cookie: cookie });
    assert.equal(metadata.status, 200);
    const body = JSON.parse(metadata.body);
    assert.equal(body.hooks.length, 8);
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
    const refused = new WebSocket(
      `ws://${host}/studio-session?character=${body.character.id}`,
      { headers: { Cookie: cookie, Origin: "https://untrusted.test" } },
    );
    const [error] = await once(refused, "error");
    assert.match(String(error), /socket hang up|Unexpected server response/);
    refused.terminate();
  },
);
