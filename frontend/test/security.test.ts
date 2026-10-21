import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  authenticated,
  readJson,
  sameOrigin,
  trustedHost,
} from "../server/security.ts";

const request = (headers: Record<string, string>) =>
  ({ headers }) as IncomingMessage;

test("only the exact local host and studio port are trusted", () => {
  assert.equal(trustedHost(request({ host: "127.0.0.1:4173" }), 4173), true);
  assert.equal(trustedHost(request({ host: "localhost:4173" }), 4173), true);
  for (const host of [
    "evil.example:4173",
    "localhost.evil.example:4173",
    "127.0.0.1:4174",
    "localhost",
  ]) {
    assert.equal(trustedHost(request({ host }), 4173), false);
  }
});

test("websocket and write requests require the exact browser origin", () => {
  assert.equal(
    sameOrigin(
      request({ host: "localhost:4173", origin: "http://localhost:4173" }),
    ),
    true,
  );
  for (const origin of [
    "",
    "null",
    "https://evil.example",
    "http://127.0.0.1:4173",
    "http://localhost:4174",
  ]) {
    assert.equal(
      sameOrigin(request({ host: "localhost:4173", origin })),
      false,
    );
  }
});

test("a session cookie cannot be forged with a prefix or another cookie name", () => {
  const secret = "example-secret-for-unit-test";
  assert.equal(
    authenticated(
      request({ cookie: `other=value; mutuals_studio=${secret}` }),
      secret,
    ),
    true,
  );
  for (const cookie of [
    "",
    `mutuals_studio=${secret}x`,
    `xmutuals_studio=${secret}`,
    `mutuals_studio=x${secret}`,
    `mutuals_studio=${secret.slice(1)}`,
  ]) {
    assert.equal(authenticated(request({ cookie }), secret), false);
  }
});

test("JSON requests are bounded and must contain an object", async () => {
  const body = (data: string) =>
    Readable.from([Buffer.from(data)]) as IncomingMessage;
  assert.deepEqual(await readJson(body('{"name":"A character"}')), {
    name: "A character",
  });
  await assert.rejects(readJson(body("[]")), /Expected a JSON object/);
  await assert.rejects(readJson(body("null")), /Expected a JSON object/);
  await assert.rejects(readJson(body("x".repeat(256 * 1024 + 1))), /too large/);
});
