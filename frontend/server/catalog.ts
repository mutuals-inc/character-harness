import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { parseDocument } from "yaml";
import {
  loadCharacter,
  requiredKeys,
  type Character,
} from "../../runtime/src/manifest.ts";
import { checkCharacter, bodyOf } from "../../runtime/src/check.ts";
import { loadExtensions } from "../../runtime/src/extensions.ts";
import type { CharacterInfo } from "../src/types.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
const ASSETS = path.join(ROOT, "player/assets");
const CHARACTERS = path.join(ROOT, "characters");
const initialEnvironment = { ...process.env };

export function listCharacters() {
  return readdirSync(CHARACTERS, { withFileTypes: true })
    .filter(
      (x) =>
        x.isDirectory() &&
        existsSync(path.join(CHARACTERS, x.name, "character.yaml")),
    )
    .map((x) => {
      const c = loadCharacter(path.join(CHARACTERS, x.name));
      return { id: c.id, name: c.name, directory: x.name };
    });
}

export function characterById(id: string): Character {
  const entry = listCharacters().find((c) => c.id === id);
  if (!entry) throw new Error("Character not found.");
  return loadCharacter(path.join(CHARACTERS, entry.directory));
}

export function environment(c: Character): NodeJS.ProcessEnv {
  const values = existsSync(c.env_file)
    ? parseEnv(readFileSync(c.env_file, "utf8"))
    : {};
  return { ...initialEnvironment, ...values };
}

function asset(file: string): string {
  const resolved = path.resolve(ASSETS, file);
  if (
    path.relative(ASSETS, resolved).startsWith("..") ||
    path.isAbsolute(path.relative(ASSETS, resolved))
  )
    throw new Error("Invalid profile asset.");
  return resolved;
}

function profile(c: Character) {
  return c.rig.kind === "profile"
    ? readFileSync(asset(`characters/${c.rig.profile}.hzt`), "utf8")
    : "";
}

function profileReference(text: string, key: string): string {
  return new RegExp(`^${key} "([^"]+)"`, "m").exec(text)?.[1] ?? "";
}

function hiddenJoints(c: Character): string[] {
  if (c.rig.kind !== "profile") return [];
  const ref = profileReference(profile(c), "rig").replace(/\.hza$/, ".hzt");
  if (!ref) return [];
  const line =
    /^hidden \d+ (.*)$/m.exec(readFileSync(asset(ref), "utf8"))?.[1] ?? "";
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function modelFile(c: Character): string {
  if (c.rig.kind === "model") return c.rig.model;
  const cooked = profileReference(profile(c), "model");
  const source = asset(
    path.join(
      path.dirname(path.dirname(cooked)),
      `${path.basename(cooked, ".hza")}.glb`,
    ),
  );
  if (!existsSync(source))
    throw new Error("This profile has no browser-readable model source.");
  return source;
}

function expressions(c: Character): CharacterInfo["expressions"] {
  if (c.rig.kind !== "profile") return {};
  const ref = profileReference(profile(c), "expressions").replace(
    /\.hza$/,
    ".hzt",
  );
  if (!ref) return {};
  const text = readFileSync(asset(ref), "utf8");
  return Object.fromEntries(
    [
      ...text.matchAll(
        /^  name "([^"]+)"\r?\n([\s\S]*?)(?=^  name |$(?![\s\S]))/gm,
      ),
    ].map((m) => [
      m[1],
      Object.fromEntries(
        [...m[2].matchAll(/target "([^"]+)"\s+value ([\d.eE+-]+)/g)].map(
          (t) => [t[1], Number(t[2])],
        ),
      ),
    ]),
  );
}

export function revision(c: Character): string {
  return createHash("sha256")
    .update(readFileSync(path.join(c.dir, "character.yaml")))
    .update(c.prompt)
    .digest("hex")
    .slice(0, 16);
}

export async function describeCharacter(c: Character): Promise<CharacterInfo> {
  const extensions = await loadExtensions(c.extensions);
  const env = environment(c);
  const report = await checkCharacter(c, extensions, env, false);
  const body = bodyOf(c, report);
  return {
    id: c.id,
    name: c.name,
    description: String(c.manifest.description),
    author: String(c.manifest.author),
    revision: revision(c),
    prompt: c.prompt,
    model: c.chat.model,
    api: c.chat.api,
    baseUrl: c.chat.base_url,
    temperature: c.chat.params.temperature ?? 0.8,
    voice: {
      provider: c.voice.provider,
      model: c.voice.model,
      voice_id: c.voice.voice_id,
      stability: Number(c.voice.params.stability ?? 0.5),
      similarity: Number(c.voice.params.similarity_boost ?? 0.75),
    },
    stt: {
      model: c.stt.model,
      language: c.stt.language ?? "",
      keyterms: c.stt.keyterms,
    },
    extensions: c.extensions.map((e) => ({
      name: e.name,
      handler: e.handler,
      hooks: Object.fromEntries(e.hooks),
      keys: e.requires_env,
    })),
    keys: requiredKeys(c).map((name) => ({ name, ready: Boolean(env[name]) })),
    body: {
      emotions: body.emotions ?? [],
      gestures: body.gestures ?? [],
      cameras: body.cameras ?? [],
      registers: body.registers ?? [],
    },
    expressions: expressions(c),
    hiddenJoints: hiddenJoints(c),
    rig: c.rig.kind === "profile" ? c.rig.profile : path.basename(c.rig.model),
    errors: report.errors,
    warnings: report.warnings,
  };
}

function textField(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}.`);
  return value.trim();
}

function numberField(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("A setting is out of range.");
  return value;
}

// Only known character fields are writable; handler paths, key names and URLs stay in the manifest.
export async function saveCharacter(
  c: Character,
  edits: Record<string, unknown>,
): Promise<CharacterInfo> {
  if (edits.revision !== revision(c))
    throw new Error("The character changed on disk. Reload before saving.");
  const file = path.join(c.dir, "character.yaml");
  const before = readFileSync(file, "utf8");
  const doc = parseDocument(before);
  const fields: [string, string[]][] = [
    ["name", ["name"]],
    ["description", ["description"]],
    ["model", ["models", "chat", "model"]],
    ["voiceId", ["voice", "voice_id"]],
    ["voiceModel", ["voice", "model"]],
    ["sttModel", ["stt", "model"]],
    ["language", ["stt", "language"]],
  ];
  for (const [key, at] of fields)
    if (edits[key] !== undefined)
      doc.setIn(
        at,
        textField(edits[key], key, key === "description" ? 2000 : 200),
      );
  if (edits.temperature !== undefined)
    doc.setIn(
      ["models", "chat", "params", "temperature"],
      numberField(edits.temperature, 0, 2),
    );
  if (edits.stability !== undefined)
    doc.setIn(
      ["voice", "params", "stability"],
      numberField(edits.stability, 0, 1),
    );
  if (edits.similarity !== undefined)
    doc.setIn(
      ["voice", "params", "similarity_boost"],
      numberField(edits.similarity, 0, 1),
    );
  if (edits.keyterms !== undefined) {
    if (!Array.isArray(edits.keyterms) || edits.keyterms.length > 100)
      throw new Error("Invalid keyterms.");
    doc.setIn(
      ["stt", "keyterms"],
      edits.keyterms.map((t) => textField(t, "keyterm")),
    );
  }
  const promptFile = path.resolve(c.dir, String(c.manifest.prompt));
  const originalPrompt = readFileSync(promptFile, "utf8");
  const prompt =
    edits.prompt === undefined
      ? originalPrompt
      : textField(edits.prompt, "prompt", 100000);
  const backups = path.join(
    ROOT,
    ".cache/frontend/backups",
    `${c.id}-${Date.now()}`,
  );
  mkdirSync(backups, { recursive: true });
  writeFileSync(path.join(backups, "character.yaml"), before);
  writeFileSync(path.join(backups, "prompt.txt"), originalPrompt);
  const temporary = `${file}.studio.tmp`;
  try {
    writeFileSync(temporary, String(doc));
    renameSync(temporary, file);
    writeFileSync(promptFile, prompt);
    const updated = loadCharacter(c.dir);
    const description = await describeCharacter(updated);
    if (description.errors.length)
      throw new Error(description.errors.join("; "));
    return description;
  } catch (error) {
    writeFileSync(file, before);
    writeFileSync(promptFile, originalPrompt);
    throw error;
  }
}
