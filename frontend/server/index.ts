import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import { loadExtensions } from "../../runtime/src/extensions.ts";
import { requiredKeys } from "../../runtime/src/manifest.ts";
import { runSession } from "../../runtime/src/session.ts";
import { HOOKS } from "../../runtime/src/state.ts";
import {
  characterById,
  describeCharacter,
  environment,
  listCharacters,
  modelFile,
  portraitFile,
  ROOT,
  saveCharacter,
} from "./catalog.ts";
import {
  createCharacter,
  updateAssets,
  updateExtensions,
  deleteCharacter,
} from "./character-files.ts";
import { importExtension } from "./extension-import.ts";
import { availableExtensions } from "./extensions.ts";
import { saveProviderKeys, ProviderKeyError } from "./provider-keys.ts";
import {
  readFormData,
  authenticated,
  readJson,
  sameOrigin,
  trustedHost,
} from "./security.ts";
import { eventsAfter, instrument } from "./telemetry.ts";
import {
  joinWebStage,
  validStageId,
  webPlayerFile,
  webPlayerProfile,
} from "./web-player.ts";

const directory = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.FRONTEND_PORT ?? 4173);
const secret = randomBytes(32).toString("hex");
const production = process.argv.includes("--production");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid FRONTEND_PORT.");
let active = false;

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function file(
  res: ServerResponse,
  filename: string,
  headers: Record<string, string> = {},
) {
  if (!existsSync(filename)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ttf": "font/ttf",
    ".glb": "model/gltf-binary",
    ".vrm": "model/gltf-binary",
  };
  res.writeHead(200, {
    "content-type": types[path.extname(filename)] ?? "application/octet-stream",
    ...headers,
  });
  createReadStream(filename)
    .on("error", () => res.destroy())
    .pipe(res);
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!authenticated(req, secret))
    return json(res, { error: "Open the studio first." }, 401);
  if (req.method !== "GET" && !sameOrigin(req))
    return json(res, { error: "Origin refused." }, 403);
  if (url.pathname === "/api/events" && req.method === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0);
    return json(res, eventsAfter(Number.isFinite(after) ? after : 0));
  }
  if (url.pathname === "/api/bootstrap" && req.method === "GET") {
    const characters = listCharacters();
    const c = characterById(
      url.searchParams.get("character") ?? characters[0]?.id ?? "",
    );
    return json(res, {
      characters: characters.map(
        ({ directory, chatPreset, voicePreset, ...entry }) => entry,
      ),
      chatPresets: [
        ...new Map(
          characters.map(({ chatPreset }) => [
            JSON.stringify(chatPreset),
            chatPreset,
          ]),
        ).values(),
      ],
      voicePresets: [...characters]
        .sort(
          (a, b) => Number(b.id === "foxglove") - Number(a.id === "foxglove"),
        )
        .map(({ voicePreset }) => voicePreset)
        .filter(
          (preset, index, all) =>
            all.findIndex((other) => other.voiceId === preset.voiceId) ===
            index,
        ),
      availableExtensions: availableExtensions(),
      character: await describeCharacter(c),
      hooks: HOOKS,
      webPlayer: webPlayerProfile(c.rig),
    });
  }
  if (url.pathname === "/api/extensions/import" && req.method === "POST") {
    if (active)
      return json(
        res,
        { error: "End the session before installing extensions." },
        409,
      );
    const data = await readFormData(req);
    const file = data.get("package");
    if (!(file instanceof File) || data.get("trusted") !== "on")
      return json(
        res,
        { error: "Choose a trusted extension ZIP package." },
        400,
      );
    try {
      const id = importExtension(new Uint8Array(await file.arrayBuffer()));
      return json(res, { id, availableExtensions: availableExtensions() }, 201);
    } catch (error) {
      return json(
        res,
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid extension package.",
        },
        400,
      );
    }
  }
  if (url.pathname === "/api/characters" && req.method === "POST") {
    return json(res, await createCharacter(await readFormData(req)), 201);
  }
  if (url.pathname === "/api/provider-keys" && req.method === "POST") {
    const data = await readJson(req);
    if (active)
      return json(
        res,
        { error: "End the session before changing provider keys." },
        409,
      );
    const c = characterById(String(data.id));
    saveProviderKeys(c.env_file, requiredKeys(c), data.keys);
    return json(res, await describeCharacter(c));
  }
  if (url.pathname === "/api/character-delete" && req.method === "POST") {
    const data = await readJson(req);
    if (active)
      return json(
        res,
        { error: "End the session before deleting a character." },
        409,
      );
    const c = characterById(String(data.id));
    deleteCharacter(c, String(data.revision));
    return json(res, { id: c.id });
  }
  if (url.pathname === "/api/character" && req.method === "GET") {
    return json(
      res,
      await describeCharacter(
        characterById(url.searchParams.get("character") ?? ""),
      ),
    );
  }
  if (
    (url.pathname === "/api/character-assets" ||
      url.pathname === "/api/character-extensions") &&
    req.method === "POST"
  ) {
    if (active)
      return json(
        res,
        { error: "End the session before saving character settings." },
        409,
      );
    let id: string;
    if (url.pathname === "/api/character-assets") {
      const form = await readFormData(req);
      id = String(form.get("character"));
      await updateAssets(characterById(id), form);
    } else {
      const data = await readJson(req);
      id = String(data.id);
      await updateExtensions(characterById(id), data);
    }
    return json(res, await describeCharacter(characterById(id)));
  }
  if (url.pathname === "/api/portrait" && req.method === "GET") {
    const portrait = portraitFile(
      characterById(url.searchParams.get("character") ?? ""),
    );
    if (!portrait) return json(res, { error: "Not found." }, 404);
    return file(res, portrait);
  }
  if (url.pathname === "/api/native-stage" && req.method === "GET") {
    const c = characterById(url.searchParams.get("character") ?? "");
    const { prepareModel } = await import("../../runtime/src/rig/prepare.ts");
    return json(res, {character: c.rig.kind === "profile" ? c.rig.profile : path.relative(path.join(ROOT,"player"),prepareModel(c.id, c.rig).file).split(path.sep).join("/")});
  }
  if (url.pathname === "/api/model" && req.method === "GET") {
    const c = characterById(url.searchParams.get("character") ?? "");
    if (c.rig.kind === "model") {
      const { prepareModel } = await import("../../runtime/src/rig/prepare.ts");
      return file(res, prepareModel(c.id, c.rig).file);
    }
    return file(res, modelFile(c));
  }
  if (url.pathname === "/api/character" && req.method === "POST") {
    if (active)
      return json(
        res,
        { error: "End the session before saving character settings." },
        409,
      );
    const body = await readJson(req);
    return json(res, await saveCharacter(characterById(String(body.id)), body));
  }
  return json(res, { error: "Not found." }, 404);
}

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (!trustedHost(req, port))
    return json(res, { error: "Host refused." }, 403);
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/")
    res.setHeader(
      "Set-Cookie",
      `mutuals_studio=${secret}; HttpOnly; SameSite=Strict; Path=/`,
    );
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname === "/web-player") {
      res.writeHead(308, { location: `/web-player/${url.search}` });
      return res.end();
    }
    if (url.pathname.startsWith("/web-player/")) {
      const found = webPlayerFile(url.pathname);
      if (!found) return json(res, { error: "Not found." }, 404);
      res.removeHeader("X-Frame-Options");
      return file(res, found.file, found.headers);
    }
    if (!production)
      return vite!.middlewares(req, res, () => {
        res.writeHead(404);
        res.end("Not found");
      });
    const relative =
      decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const target = path.resolve(directory, "dist", relative);
    if (
      path.relative(path.join(directory, "dist"), target).startsWith("..") ||
      path.isAbsolute(path.relative(path.join(directory, "dist"), target))
    )
      return json(res, { error: "Invalid path." }, 403);
    file(res, target);
  } catch (error) {
    // Provider and extension exceptions may include credentials. Keep only known local errors public.
    const message = error instanceof Error ? error.message : "";
    const safe =
      error instanceof ProviderKeyError ||
      /^(Invalid |Character not found|The character changed|End the session|A setting|The request|Expected a JSON|This profile)/.test(
        message,
      );
    json(
      res,
      {
        error: safe
          ? message
          : "Could not load or save the character. Run npm run check from the harness for details.",
      },
      400,
    );
  }
});

const vite = production
  ? null
  : await createViteServer({
      root: directory,
      configFile: path.join(directory, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
const sessions = new WebSocketServer({
  noServer: true,
  maxPayload: 4 * 1024 * 1024,
});

const webStages = new WebSocketServer({ noServer: true, maxPayload: 8192 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/web-stage") {
    const id = url.searchParams.get("id");
    const role = url.searchParams.get("role");
    if (
      !trustedHost(req, port) ||
      !sameOrigin(req) ||
      !authenticated(req, secret) ||
      !validStageId(id) ||
      (role !== "page" && role !== "player")
    ) {
      socket.destroy();
      return;
    }
    webStages.handleUpgrade(req, socket, head, (ws) => joinWebStage(ws, id, role));
    return;
  }
  if (url.pathname !== "/studio-session") return; // Vite owns its own HMR upgrade.
  if (
    !trustedHost(req, port) ||
    !sameOrigin(req) ||
    !authenticated(req, secret)
  ) {
    socket.destroy();
    return;
  }
  sessions.handleUpgrade(req, socket, head, async (ws) => {
    if (active) {
      ws.send(
        JSON.stringify({
          t: "error",
          text: "Another studio session is already running.",
        }),
      );
      ws.close();
      return;
    }
    active = true;
    ws.once("close", () => {
      active = false;
    });
    try {
      const c = characterById(url.searchParams.get("character") ?? "");
      const env = environment(c);
      const missing = requiredKeys(c).filter((key) => !env[key]);
      if (missing.length)
        throw new Error(
          `Missing keys: ${missing.join(", ")}. Add them to .env.`,
        );
      for (const key of requiredKeys(c)) process.env[key] = env[key];
      const extensions = await loadExtensions(c.extensions);
      if (ws.readyState !== 1) return;
      runSession(ws, c, instrument(extensions, ws));
    } catch (error) {
      const message =
        error instanceof Error && error.message.startsWith("Missing keys:")
          ? error.message
          : "The session could not start. Check the character configuration.";
      ws.send(JSON.stringify({ t: "error", text: message }));
      ws.close();
    }
  });
});

server.listen(port, "127.0.0.1", () =>
  console.log(
    `Mutuals Character Studio: http://127.0.0.1:${port}\nLocal frontend · no native player is launched · harness: ${ROOT}`,
  ),
);
async function shutdown() {
  for (const ws of sessions.clients) ws.close();
  for (const ws of webStages.clients) ws.close();
  await vite?.close();
  server.close();
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
