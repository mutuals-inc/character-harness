// The Kaigen web player: a WebAssembly build of player/, supplied outside git
// (`npm run web-player`), shown in an iframe and driven over /web-stage.
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { WebSocket } from "ws";
import { ROOT } from "./paths.ts";

const { stageState, stageCue } = createRequire(import.meta.url)(
  "../desktop/protocol.cjs",
) as {
  stageState(value: object): object;
  stageCue(value: object): object;
};

// a relative WEB_PLAYER_DIR is from the repository root
export const WEB_PLAYER_DIR = path.resolve(
  ROOT,
  process.env.WEB_PLAYER_DIR || ".cache/web-player",
);
// the page the iframe opens; the build's own index.html is a test bootstrap
export const WEB_PLAYER_PAGE = path.join(import.meta.dirname, "web-player.html");
const REQUIRED = ["main.js", "main_worker.js", "worker.js", "cooked/catalog.hza"];

// The player threads need SharedArrayBuffer, so its documents must be
// cross-origin isolated. Document-Isolation-Policy isolates the iframe alone,
// so the Studio page and what it loads keep working as before; COOP and COEP
// isolate the player when it is opened on its own.
export const ISOLATION_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Document-Isolation-Policy": "isolate-and-require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": "frame-ancestors 'self'",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
};

// whether the web player is installed, with its wasm in either form
export function webPlayerReady(dir = WEB_PLAYER_DIR): boolean {
  if (process.env.WEB_PLAYER === "off") return false;
  return (
    REQUIRED.every((name) => existsSync(path.join(dir, name))) &&
    (existsSync(path.join(dir, "game.wasm")) ||
      existsSync(path.join(dir, "game.wasm.br")))
  );
}

// the profile to show, when the web player has it cooked in. It can't import a
// .vrm, so characters with a model rig stay on three.js
export function webPlayerProfile(
  rig: { kind: string; profile?: string },
  dir = WEB_PLAYER_DIR,
): string | null {
  if (rig.kind !== "profile" || !rig.profile) return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(rig.profile)) return null;
  if (!webPlayerReady(dir)) return null;
  return existsSync(path.join(dir, "cooked/characters", `${rig.profile}.hza`))
    ? rig.profile
    : null;
}

// the file and headers for a request under /web-player/, or null. A `.br`
// file is a brotli body the browser decodes, as the build's _headers says
export function webPlayerFile(
  pathname: string,
  dir = WEB_PLAYER_DIR,
): { file: string; headers: Record<string, string> } | null {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.replace(/^\/web-player\/?/, ""));
  } catch {
    return null;
  }
  if (!relative || relative === "index.html")
    return {
      file: WEB_PLAYER_PAGE,
      headers: { ...ISOLATION_HEADERS, "content-type": TYPES[".html"], "cache-control": "no-store" },
    };
  if (relative.includes("\0") || relative.split("/").some((part) => part.startsWith(".")))
    return null;
  const file = path.resolve(dir, relative);
  if (path.relative(dir, file).startsWith("..") || path.isAbsolute(path.relative(dir, file)))
    return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const brotli = file.endsWith(".br");
  const plain = brotli ? file.slice(0, -3) : file;
  return {
    file,
    headers: {
      ...ISOLATION_HEADERS,
      "content-type": TYPES[path.extname(plain)] ?? "application/octet-stream",
      ...(brotli ? { "content-encoding": "br" } : {}),
      "cache-control": "no-cache",
    },
  };
}

// Pairs a Studio page with the web player it opened. The page sends the same
// state and cue messages the desktop app sends the native player; only those,
// checked, reach the player. The player's frames stay in its own canvas.
const MAX_STAGES = 8;
interface Pair {
  page?: WebSocket;
  player?: WebSocket;
  state?: string;
}
const pairs = new Map<string, Pair>();

export function validStageId(id: string | null): id is string {
  return id !== null && /^[a-z0-9-]{16,64}$/i.test(id);
}

export function webStageMessage(data: string): string | null {
  if (data.length > 4096) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as { t?: unknown };
  if (message.t === "state") return JSON.stringify(stageState(message));
  if (message.t === "cue") return JSON.stringify(stageCue(message));
  return null;
}

export function joinWebStage(ws: WebSocket, id: string, role: "page" | "player") {
  let pair = pairs.get(id);
  if (!pair) {
    if (pairs.size >= MAX_STAGES || role === "player") {
      ws.close();
      return;
    }
    pair = {};
    pairs.set(id, pair);
  }
  pair[role]?.close();
  pair[role] = ws;
  ws.on("error", () => ws.close());
  ws.on("close", () => {
    if (pair[role] !== ws) return;
    delete pair[role];
    if (role === "page") {
      pair.player?.close();
      pairs.delete(id);
    }
  });
  if (role === "player") {
    // the page shows the player once it has started and connected
    if (pair.state) ws.send(pair.state);
    pair.page?.send(JSON.stringify({ t: "player" }));
    ws.on("message", () => {}); // the player sends nothing the page needs
    return;
  }
  ws.on("message", (data, binary) => {
    if (binary) return;
    const message = webStageMessage(String(data));
    if (!message) return;
    if (message.startsWith('{"t":"state"')) pair.state = message;
    if (pair.player?.readyState === 1) pair.player.send(message);
  });
}
