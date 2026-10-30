// Puts the Kaigen web player where Studio serves it (.cache/web-player/, or
// WEB_PLAYER_DIR), from a GitHub release or from your own build:
//
//   npm run web-player -- download [vX.Y.Z-web-wasm]   the newest release, or that one
//   npm run web-player -- copy [folder]                a `hz/hzbuild wasm publish` build
//
// The player is a licensed Kaigen build, so it isn't in git; player/release-web.sh
// makes the release files.
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { ROOT } from "../server/paths.ts";
import { WEB_PLAYER_DIR, webPlayerReady } from "../server/web-player.ts";

const REPOSITORY = process.env.GITHUB_REPOSITORY ?? "mutuals-inc/character-harness";
const TAG = /^v(\d+)\.(\d+)\.(\d+)-web-wasm$/;

interface Release {
  tag_name: string;
  draft: boolean;
  assets: { name: string; browser_download_url: string }[];
}

// the release to install: `tag`, or the highest published web-wasm version
export function webRelease(releases: Release[], tag?: string): Release {
  if (tag !== undefined && !TAG.test(tag))
    throw new Error(`${tag} is not a web player tag (vX.Y.Z-web-wasm).`);
  let best: { release: Release; version: number[] } | null = null;
  for (const release of releases) {
    const match = TAG.exec(release.tag_name);
    if (release.draft || !match || (tag && release.tag_name !== tag)) continue;
    const version = match.slice(1, 4).map(Number);
    const difference = best && version.map((n, i) => n - best!.version[i]).find((n) => n !== 0);
    if (!best || (difference ?? 0) > 0) best = { release, version };
  }
  if (!best)
    throw new Error(tag ? `There is no published release ${tag}.` : "No web player has been published yet. Build one and use `copy`.");
  return best.release;
}

// the SHA-256 that a SHA256SUMS file lists for `name`
export function listedSum(sums: string, name: string): string {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  throw new Error(`SHA256SUMS does not list ${name}.`);
}

// a path inside the archive's one top folder, without that folder; null for the folder itself
export function archivePath(name: string): string | null {
  const parts = name.replace(/\/+$/, "").split("/");
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error(`The archive has an unsafe path: ${name}`);
  return parts.length > 1 ? parts.slice(1).join("/") : null;
}

// Unpacks a .tar.gz with one top folder into `into`, streaming. Only files and
// folders are taken; a link or any other entry stops it.
export async function extractTarGz(file: string, into: string) {
  const chunks = createReadStream(file).pipe(createGunzip())[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function read(size: number): Promise<Buffer> {
    while (pending.length < size) {
      const next = await chunks.next();
      if (next.done) throw new Error("The archive is truncated.");
      pending = Buffer.concat([pending, next.value as Buffer]);
    }
    const out = pending.subarray(0, size);
    pending = pending.subarray(size);
    return out;
  }
  const field = (header: Buffer, start: number, length: number) =>
    header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  let longName: string | null = null;
  let top: string | null = null;
  for (;;) {
    const header = Buffer.from(await read(512));
    if (header.every((byte) => byte === 0)) return;
    const sum = Number.parseInt(field(header, 148, 8).trim(), 8);
    header.fill(0x20, 148, 156);
    if (header.reduce((total, byte) => total + byte, 0) !== sum)
      throw new Error("The archive is damaged.");
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
    const prefix = field(header, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    const padded = Math.ceil(size / 512) * 512;
    if (type === "L" || type === "x" || type === "g") {
      const data = (await read(padded)).subarray(0, size).toString("utf8");
      if (type === "L") longName = data.replace(/\0.*$/s, "");
      if (type === "x") longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data)?.[1] ?? null;
      continue;
    }
    const topFolder = name.split("/")[0];
    if ((top ??= topFolder) !== topFolder)
      throw new Error("The archive should hold one folder.");
    const relative = archivePath(name);
    const target = relative ? path.join(into, relative) : into;
    if (type === "5") {
      mkdirSync(target, { recursive: true });
      await read(padded);
    } else if (type === "0" || type === "\0") {
      if (!relative) throw new Error("The archive should hold one folder.");
      mkdirSync(path.dirname(target), { recursive: true });
      const fd = openSync(target, "w");
      try {
        for (let left = size; left > 0; ) {
          const piece = await read(Math.min(left, 1 << 20));
          writeSync(fd, piece);
          left -= piece.length;
        }
      } finally {
        closeSync(fd);
      }
      await read(padded - size);
    } else throw new Error(`The archive has an entry that isn't a file or folder: ${name}`);
  }
}

// moves a finished folder into place, so Studio never sees half a player
function replace(next: string, target: string) {
  if (!webPlayerReady(next))
    throw new Error("That isn't a web player build: main.js, main_worker.js, worker.js, game.wasm(.br) or cooked/catalog.hza is missing.");
  const old = `${target}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, old);
  renameSync(next, target);
  rmSync(old, { recursive: true, force: true });
}

async function download(tag: string | undefined, target: string) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const releases: Release[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`Cannot list releases: HTTP ${response.status}`);
    const batch = (await response.json()) as Release[];
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const release = webRelease(releases, tag);
  const version = TAG.exec(release.tag_name)!.slice(1, 4).join(".");
  const name = `character-player-${version}-web-wasm.tar.gz`;
  const asset = (file: string) => {
    const found = release.assets.find((entry) => entry.name === file);
    if (!found) throw new Error(`${release.tag_name} has no ${file}.`);
    return found.browser_download_url;
  };
  const sumsResponse = await fetch(asset("SHA256SUMS-web-wasm"));
  if (!sumsResponse.ok) throw new Error(`Cannot download SHA256SUMS-web-wasm: HTTP ${sumsResponse.status}`);
  const expected = listedSum(await sumsResponse.text(), name);

  const work = `${target}.download`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    console.log(`Downloading ${name} from ${release.tag_name}…`);
    const response = await fetch(asset(name));
    if (!response.ok || !response.body) throw new Error(`Cannot download ${name}: HTTP ${response.status}`);
    const tarball = path.join(work, name);
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tarball),
    );
    if (hash.digest("hex") !== expected)
      throw new Error(`${name} does not match SHA256SUMS-web-wasm; nothing was installed.`);
    const next = path.join(work, "player");
    await extractTarGz(tarball, next);
    writeFileSync(path.join(next, "web-player.json"), `${JSON.stringify({ release: release.tag_name, sha256: expected }, null, 2)}\n`);
    replace(next, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`Installed the web player from ${release.tag_name}.`);
}

function copy(from: string | undefined, target: string) {
  let source = from && path.resolve(from);
  if (!source) {
    const publish = path.join(ROOT, "player/out/wasm/publish");
    const found = existsSync(publish)
      ? readdirSync(publish, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) =>
            readdirSync(path.join(publish, entry.name), { withFileTypes: true })
              .filter((inner) => inner.isDirectory())
              .map((inner) => path.join(publish, entry.name, inner.name)),
          )
      : [];
    if (found.length !== 1)
      throw new Error("Build the player first (from player/: hz/hzbuild wasm publish), or name the build folder.");
    source = found[0];
  }
  const next = `${target}.new`;
  rmSync(next, { recursive: true, force: true });
  // the engine's test page, static-host headers, native-only files and the
  // player's cache of imported models aren't needed
  const skip = new Set(["index.html", "_headers", path.join("cooked", "vrm"), path.join("cooked", "cook_deps")]);
  cpSync(source, next, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      const relative = path.relative(source, file);
      return !skip.has(relative) && !relative.endsWith(".zst");
    },
  });
  writeFileSync(path.join(next, "web-player.json"), `${JSON.stringify({ build: "local" }, null, 2)}\n`);
  try {
    replace(next, target);
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
  console.log("Installed the web player from your build.");
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  mkdirSync(path.dirname(WEB_PLAYER_DIR), { recursive: true });
  if (command === "download") await download(argument, WEB_PLAYER_DIR);
  else if (command === "copy") copy(argument, WEB_PLAYER_DIR);
  else {
    console.error("usage: npm run web-player -- download [vX.Y.Z-web-wasm] | copy [build folder]");
    process.exit(1);
  }
  console.log(`Studio serves it from ${path.relative(ROOT, WEB_PLAYER_DIR) || WEB_PLAYER_DIR}; reload Studio to use it.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
