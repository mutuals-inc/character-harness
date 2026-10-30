import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { chooseStage } from "../src/stage/choose.ts";
import {
  ISOLATION_HEADERS,
  validStageId,
  webPlayerFile,
  webPlayerProfile,
  webPlayerReady,
  webStageMessage,
} from "../server/web-player.ts";
import {
  archivePath,
  extractTarGz,
  listedSum,
  webRelease,
} from "../scripts/web-player.ts";

function fakePlayer() {
  const dir = mkdtempSync(path.join(tmpdir(), "web-player-"));
  mkdirSync(path.join(dir, "cooked/characters"), { recursive: true });
  for (const name of ["main.js", "main_worker.js", "worker.js", "cooked/catalog.hza", "cooked/characters/foxglove.hza"])
    writeFileSync(path.join(dir, name), "x");
  writeFileSync(path.join(dir, "game.wasm.br"), "brotli");
  return dir;
}

test("Browser mode picks the web player only when it can run, and three.js otherwise", () => {
  const base = { native: false, webPlayer: "foxglove", webgpu: true, override: null };
  assert.deepEqual(chooseStage(base), { kind: "web-player", forced: false });
  assert.deepEqual(chooseStage({ ...base, webgpu: false }), { kind: "three", forced: false });
  assert.deepEqual(chooseStage({ ...base, webPlayer: null }), { kind: "three", forced: false });
  assert.deepEqual(chooseStage({ ...base, override: "three" }), { kind: "three", forced: true });
  assert.deepEqual(chooseStage({ ...base, webgpu: false, override: "wasm" }), { kind: "web-player", forced: true });
  // forcing it can't conjure a player that isn't installed
  assert.deepEqual(chooseStage({ ...base, webPlayer: null, override: "wasm" }), { kind: "three", forced: false });
  assert.deepEqual(chooseStage({ ...base, native: true }), { kind: "native", forced: false });
});

test("the web player is found only when installed with the character's profile", () => {
  const dir = fakePlayer();
  assert.equal(webPlayerReady(dir), true);
  assert.equal(webPlayerProfile({ kind: "profile", profile: "foxglove" }, dir), "foxglove");
  assert.equal(webPlayerProfile({ kind: "profile", profile: "someone-else" }, dir), null);
  assert.equal(webPlayerProfile({ kind: "profile", profile: "../foxglove" }, dir), null);
  assert.equal(webPlayerProfile({ kind: "model" }, dir), null);
  const empty = mkdtempSync(path.join(tmpdir(), "web-player-"));
  assert.equal(webPlayerReady(empty), false);
  assert.equal(webPlayerProfile({ kind: "profile", profile: "foxglove" }, empty), null);
  process.env.WEB_PLAYER = "off";
  try {
    assert.equal(webPlayerReady(dir), false);
  } finally {
    delete process.env.WEB_PLAYER;
  }
});

test("web player files are isolated, typed and confined to the build", () => {
  const dir = fakePlayer();
  const page = webPlayerFile("/web-player/", dir)!;
  assert.match(page.file, /web-player\.html$/);
  assert.equal(page.headers["Document-Isolation-Policy"], "isolate-and-require-corp");
  assert.equal(page.headers["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.equal(page.headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(page.headers["X-Frame-Options"], "SAMEORIGIN");
  const wasm = webPlayerFile("/web-player/game.wasm.br", dir)!;
  assert.equal(wasm.headers["content-type"], "application/wasm");
  assert.equal(wasm.headers["content-encoding"], "br");
  assert.equal(webPlayerFile("/web-player/main.js", dir)!.headers["content-type"], "text/javascript");
  assert.equal(webPlayerFile("/web-player/cooked/catalog.hza", dir)!.headers["content-type"], "application/octet-stream");
  for (const bad of ["/web-player/missing.js", "/web-player/..%2Fsecret", "/web-player/cooked/%2E%2E/%2E%2E/x", "/web-player/.env", "/web-player/%E0%A4%A", "/web-player/cooked"])
    assert.equal(webPlayerFile(bad, dir), null, bad);
});

test("the web stage relay passes only bounded state and cue messages", () => {
  assert.deepEqual(JSON.parse(webStageMessage('{"t":"cue","emotion":"happy","gesture":"wave","extra":1}')!), { t: "cue", emotion: "happy", gesture: "wave" });
  assert.deepEqual(JSON.parse(webStageMessage(JSON.stringify({ t: "cue", emotion: "x".repeat(65) }))!), { t: "cue" });
  assert.deepEqual(JSON.parse(webStageMessage('{"t":"state","mouth":4,"talking":true}')!), { t: "state", width: 960, height: 720, mouth: 1, talking: true });
  for (const bad of ['{"t":"frame-ready"}', "not json", "null", "[]", JSON.stringify({ t: "cue", pad: "x".repeat(5000) })])
    assert.equal(webStageMessage(bad), null, bad);
  assert.equal(validStageId(crypto.randomUUID()), true);
  for (const bad of [null, "", "short", "../../etc", "x".repeat(65)]) assert.equal(validStageId(bad), false);
});

test("web player releases are picked by version, checked and unpacked safely", async () => {
  const release = (tag_name: string, draft = false) => ({ tag_name, draft, assets: [] });
  const releases = [release("v0.2.0-linux-x64"), release("v0.1.9-web-wasm"), release("v0.1.10-web-wasm"), release("v0.3.0-web-wasm", true)];
  assert.equal(webRelease(releases).tag_name, "v0.1.10-web-wasm");
  assert.equal(webRelease(releases, "v0.1.9-web-wasm").tag_name, "v0.1.9-web-wasm");
  assert.throws(() => webRelease(releases, "v0.3.0-web-wasm"), /no published release/);
  assert.throws(() => webRelease(releases, "v0.2.0-linux-x64"), /not a web player tag/);
  assert.throws(() => webRelease([release("v0.2.0-linux-x64")]), /No web player/);

  const sum = "a".repeat(64);
  assert.equal(listedSum(`${sum}  player.tar.gz\n`, "player.tar.gz"), sum);
  assert.throws(() => listedSum(`${sum}  other.tar.gz\n`, "player.tar.gz"), /does not list/);

  assert.equal(archivePath("top/"), null);
  assert.equal(archivePath("top/cooked/a.hza"), "cooked/a.hza");
  for (const bad of ["/etc/passwd", "top/../x", "top//x", "top/./x", "top\\x"])
    assert.throws(() => archivePath(bad), /unsafe path/, bad);

  // a GNU tar archive like release-web.sh makes, with a name past 100 characters
  const work = mkdtempSync(path.join(tmpdir(), "web-player-tar-"));
  const long = `cooked/${"deep/".repeat(25)}clip.hza`;
  mkdirSync(path.join(work, "character-player-0.1.0-web-wasm", path.dirname(long)), { recursive: true });
  writeFileSync(path.join(work, "character-player-0.1.0-web-wasm", "main.js"), "main");
  writeFileSync(path.join(work, "character-player-0.1.0-web-wasm", long), Buffer.alloc(1500, 7));
  const tarball = path.join(work, "player.tar.gz");
  execFileSync("tar", ["-C", work, "-czf", tarball, "character-player-0.1.0-web-wasm"]);
  const into = path.join(work, "out");
  await extractTarGz(tarball, into);
  assert.equal(readFileSync(path.join(into, "main.js"), "utf8"), "main");
  assert.deepEqual(readFileSync(path.join(into, long)), Buffer.alloc(1500, 7));

  // links never come out of an archive
  const linked = path.join(work, "linked");
  mkdirSync(path.join(linked, "top"), { recursive: true });
  execFileSync("ln", ["-s", "/etc/passwd", path.join(linked, "top", "passwd")]);
  execFileSync("tar", ["-C", linked, "-czf", path.join(work, "linked.tar.gz"), "top"]);
  await assert.rejects(extractTarGz(path.join(work, "linked.tar.gz"), path.join(work, "linked-out")), /isn't a file or folder/);
});

test("Studio serves an isolated web player and relays cues to it", { timeout: 20000 }, async (context) => {
  const port = 32000 + Math.floor(Math.random() * 10000);
  const host = `127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../server/index.ts"), "--production"], {
    env: { ...process.env, FRONTEND_PORT: String(port), WEB_PLAYER_DIR: fakePlayer() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Studio startup timed out.")), 9000);
    child.once("exit", () => reject(new Error("Studio exited during startup.")));
    child.stdout.on("data", (data) => {
      if (String(data).includes("Mutuals Character Studio:")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const get = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: url, headers: { Host: host, ...headers } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });

  // the page itself stays as it was; only the player's frame is isolated
  const page = await get("/");
  assert.equal(page.headers["cross-origin-embedder-policy"], undefined);
  assert.equal(page.headers["x-frame-options"], "DENY");
  const cookie = String((page.headers["set-cookie"] as string[])[0]).split(";")[0];
  const player = await get("/web-player/?HARNESS_CHARACTER=foxglove");
  assert.equal(player.status, 200);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS))
    assert.equal(player.headers[name.toLowerCase()], value, name);
  assert.equal((await get("/web-player/game.wasm.br")).headers["content-encoding"], "br");
  const bootstrap = JSON.parse((await get("/api/bootstrap?character=foxglove", { Cookie: cookie })).body);
  assert.equal(bootstrap.webPlayer, "foxglove");

  const id = crypto.randomUUID();
  const open = (role: string, headers: Record<string, string>) =>
    new WebSocket(`ws://${host}/web-stage?role=${role}&id=${id}`, { headers });
  const trusted = { Cookie: cookie, Origin: `http://${host}` };
  const refused = open("page", { Origin: `http://${host}` });
  await new Promise((resolve) => refused.once("error", resolve));

  const studio = open("page", trusted);
  await new Promise((resolve) => studio.once("open", resolve));
  studio.send(JSON.stringify({ t: "state", mouth: 0.5, talking: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = new Promise((resolve) => studio.once("message", (data) => resolve(JSON.parse(String(data)))));
  const kaigen = open("player", trusted);
  const received: unknown[] = [];
  kaigen.on("message", (data) => received.push(JSON.parse(String(data))));
  assert.deepEqual(await started, { t: "player" });
  studio.send(JSON.stringify({ t: "cue", emotion: "happy", camera: "close-up", secret: "dropped" }));
  studio.send(JSON.stringify({ t: "quit" }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(received, [
    { t: "state", width: 960, height: 720, mouth: 0.5, talking: true },
    { t: "cue", emotion: "happy", camera: "close-up" },
  ]);
  // the player leaves with the page that opened it
  const closed = new Promise((resolve) => kaigen.once("close", resolve));
  studio.close();
  await closed;
});
