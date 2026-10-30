import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  copyFileSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Document, parseDocument } from "yaml";
import { loadCharacter, type Character } from "../../runtime/src/manifest.ts";
import { readGlb } from "../../runtime/src/rig/glb.ts";
import { checkCharacter } from "../../runtime/src/check.ts";
import { loadExtensions } from "../../runtime/src/extensions.ts";
import { ROOT } from "./paths.ts";
import { writeExtensionFiles } from "./extensions.ts";
import { isProtectedCharacter, revision } from "./catalog.ts";

const CHARACTERS = path.join(ROOT, "characters");
export function deleteCharacter(c: Character, expectedRevision: string) {
  if (isProtectedCharacter(c))
    throw new Error(
      "Invalid deletion: FoxGlove is a built-in character and cannot be deleted.",
    );
  if (revision(c) !== expectedRevision)
    throw new Error(
      "The character changed on disk. Refresh it before deleting.",
    );
  if (
    lstatSync(c.dir).isSymbolicLink() ||
    path.dirname(realpathSync(c.dir)) !== realpathSync(CHARACTERS)
  )
    throw new Error("Invalid character directory.");
  const archive = path.resolve(ROOT, ".cache/frontend/deleted-characters");
  mkdirSync(archive, { recursive: true });
  const relative = path.relative(realpathSync(ROOT), realpathSync(archive));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Invalid character archive directory.");
  renameSync(
    c.dir,
    path.join(archive, `${c.id}-${Date.now()}-${randomUUID()}`),
  );
}
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}.`);
  return value.trim();
}
function number(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  const result = Number(value);
  if (value === "" || !Number.isFinite(result) || result < min || result > max)
    throw new Error(`Invalid ${label}.`);
  return result;
}
export function definition(form: FormData): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(String(form.get("definition")));
    if (data && typeof data === "object" && !Array.isArray(data))
      return data as Record<string, unknown>;
  } catch {}
  throw new Error("Invalid character definition.");
}
function removeDraft(dir: string) {
  if (
    existsSync(dir) &&
    path.dirname(dir) === CHARACTERS &&
    path.basename(dir).startsWith(".draft-")
  )
    rmSync(dir, { recursive: true, force: true });
}
function selectedFile(form: FormData, key: string): File | null {
  const file = form.get(key);
  return file && typeof file !== "string" && file.size ? file : null;
}
async function upload(
  form: FormData,
  key: string,
  dir: string,
  base: string,
  kind: "model" | "animation" | "portrait",
  required = false,
): Promise<string | null> {
  const file = selectedFile(form, key);
  if (!file) {
    if (required) throw new Error(`Invalid ${kind}: choose a file.`);
    return null;
  }
  const extension = path.extname(file.name).toLowerCase();
  const allowed =
    kind === "model"
      ? [".vrm"]
      : kind === "animation"
        ? [".vrma"]
        : [".png", ".jpg", ".jpeg", ".webp"];
  const max =
    (kind === "model" ? 100 : kind === "animation" ? 20 : 10) * 1024 * 1024;
  if (!allowed.includes(extension) || file.size > max)
    throw new Error(`Invalid ${kind} file or size.`);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (kind === "portrait") {
    const valid =
      extension === ".png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : extension === ".webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!valid)
      throw new Error("Invalid portrait: the file is not a supported image.");
  }
  const name = `${base}${extension}`;
  const target = path.join(dir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  if (kind !== "portrait") {
    try {
      const glb = readGlb(target);
      const extensions = glb.json.extensions ?? {};
      if (kind === "model" && !extensions.VRMC_vrm && !extensions.VRM)
        throw new Error();
      if (
        kind === "animation" &&
        (!extensions.VRMC_vrm_animation || !glb.json.animations?.length)
      )
        throw new Error();
      const json = glb.json as unknown as {
        buffers?: { uri?: string }[];
        images?: { uri?: string }[];
      };
      if (
        [...(json.buffers ?? []), ...(json.images ?? [])].some(
          (x) => x.uri && !x.uri.startsWith("data:"),
        )
      )
        throw new Error();
    } catch {
      throw new Error(
        `Invalid ${kind}: upload a self-contained ${kind === "model" ? "VRM model" : "VRM Animation"} file.`,
      );
    }
  }
  return name;
}
async function assets(
  doc: Document,
  dir: string,
  form: FormData,
  data: Record<string, unknown>,
  creating = false,
) {
  const model = await upload(form, "model", dir, "model", "model", creating);
  const portrait = await upload(form, "portrait", dir, "portrait", "portrait");
  if (portrait) doc.set("portrait", portrait);
  if (model) {
    doc.deleteIn(["rig", "profile"]);
    doc.setIn(["rig", "model"], model);
    doc.setIn(["rig", "engine"], ">=0.6.3");
  }
  if (typeof data.springs === "boolean")
    doc.setIn(["rig", "springs"], data.springs);
  const animations = data.animations ?? [];
  if (!Array.isArray(animations) || animations.length > 40)
    throw new Error("Invalid animation list.");
  if (animations.length && !doc.getIn(["rig", "model"]))
    throw new Error(
      "Invalid animations: upload a VRM model to replace the bundled profile first.",
    );
  for (let index = 0; index < animations.length; index++) {
    const row = animations[index];
    if (
      !row ||
      typeof row !== "object" ||
      !["idle", "talk", "gesture"].includes(row.kind)
    )
      throw new Error("Invalid animation assignment.");
    const key = text(row.file, "animation file");
    const name =
      row.kind === "idle" ? "idle" : text(row.name, "animation name", 64);
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name) ||
      ["constructor", "prototype", "__proto__"].includes(name)
    )
      throw new Error("Invalid animation name.");
    const file = await upload(
      form,
      key,
      dir,
      `animations/${row.kind}-${index}-${Date.now()}`,
      "animation",
      true,
    );
    if (row.kind === "idle") {
      const previous = doc.getIn(["rig", "animations", "idle"]);
      const existing =
        previous === undefined
          ? []
          : typeof previous === "string"
            ? [previous]
            : (previous as { toJSON(): unknown }).toJSON();
      doc.setIn(
        ["rig", "animations", "idle"],
        [...(Array.isArray(existing) ? existing : []), file],
      );
    } else if (row.kind === "talk")
      doc.setIn(["rig", "animations", "talk", name], file);
    else
      doc.setIn(
        ["rig", "animations", "gestures", name],
        row.hold ? { clip: file, hold: true } : file,
      );
  }
}
async function validate(dir: string) {
  const c = loadCharacter(dir);
  const report = await checkCharacter(
    c,
    await loadExtensions(c.extensions),
    {},
    false,
  );
  if (report.errors.length)
    throw new Error(`Invalid character: ${report.errors.join("; ")}`);
  return c;
}
export async function createCharacter(form: FormData): Promise<{ id: string }> {
  const data = definition(form);
  const name = text(data.name, "name");
  const generated =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "character";
  const base =
    typeof data.id === "string" && data.id.trim()
      ? text(data.id, "character ID", 64)
      : generated;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(base))
    throw new Error(
      "Invalid character ID: use lowercase letters, digits, hyphens or underscores.",
    );
  let id = base;
  if (data.id && existsSync(path.join(CHARACTERS, id)))
    throw new Error("Invalid character ID: it is already in use.");
  for (let suffix = 2; existsSync(path.join(CHARACTERS, id)); suffix++)
    id = `${base}-${suffix}`;
  const draft = mkdtempSync(path.join(CHARACTERS, ".draft-"));
  try {
    const api = text(data.api, "chat API");
    if (!["chat_completions", "responses"].includes(api))
      throw new Error("Invalid chat API.");
    const baseUrl = text(data.baseUrl, "chat endpoint", 2000);
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("Invalid chat endpoint.");
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid chat endpoint.");
    const key = text(data.keyName, "API key name");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(
        "Invalid API key name: enter an environment variable name, not a key value.",
      );
    const params: Record<string, unknown> = {
      temperature: number(data.temperature, "temperature", 0, 2),
    };
    if (data.maxTokens)
      params.max_tokens = number(
        data.maxTokens,
        "maximum reply length",
        1,
        1000000,
      );
    if (data.reasoningEffort)
      params.reasoning_effort = text(data.reasoningEffort, "reasoning effort");
    const doc = new Document({
      schema: 1,
      id,
      name,
      description: text(data.description, "description", 2000),
      author: text(data.author ?? "Local creator", "author"),
      license: text(data.license ?? "All rights reserved", "license"),
      created_at: new Date().toISOString(),
      ...(data.purpose ? { purpose: text(data.purpose, "purpose", 2000) } : {}),
      prompt: "system.md",
      models: {
        chat: {
          api,
          base_url: baseUrl,
          api_key_env: key,
          model: text(data.model, "chat model"),
          params,
        },
      },
      voice: {
        provider: "elevenlabs",
        voice_id: text(data.voiceId, "voice ID"),
        model: text(data.voiceModel, "voice model"),
        params: {
          stability: number(data.stability, "voice stability", 0, 1),
          similarity_boost: number(data.similarity, "voice similarity", 0, 1),
        },
        drop_tags: String(data.dropTags ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      },
      stt: {
        provider: "elevenlabs",
        model: text(data.sttModel, "transcription model"),
        language: text(data.language, "language"),
        keyterms: String(data.keyterms ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      },
      rig: { engine: ">=0.6.3", springs: data.springs !== false },
      extensions: [],
      env_file: "../../.env",
    });
    writeFileSync(
      path.join(draft, "system.md"),
      text(data.prompt, "personality prompt", 100000),
    );
    await assets(doc, draft, form, data, true);
    const assignments = writeExtensionFiles(draft, data.extensions ?? []);
    doc.set("extensions", assignments.extensions);
    doc.set("disabled_extensions", assignments.disabled_extensions);
    doc.set("extension_order", assignments.extension_order);
    writeFileSync(path.join(draft, "character.yaml"), String(doc));
    await validate(draft);
    renameSync(draft, path.join(CHARACTERS, id));
    return { id };
  } finally {
    removeDraft(draft);
  }
}
function copyCharacterDirectory(source: string, destination: string) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(
        "Invalid character assets: symbolic links cannot be edited through the studio.",
      );
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyCharacterDirectory(from, to);
    } else if (entry.isFile()) copyFileSync(from, to);
  }
}
export async function updateCharacterFiles(
  c: Character,
  revision: string,
  mutate: (doc: Document, dir: string) => Promise<void> | void,
): Promise<void> {
  if (path.dirname(realpathSync(c.dir)) !== realpathSync(CHARACTERS))
    throw new Error("Invalid character directory.");
  // Revision is checked again after potentially slow model preparation.
  const original = readFileSync(path.join(c.dir, "character.yaml"), "utf8");
  const { createHash } = await import("node:crypto");
  const current = () =>
    createHash("sha256")
      .update(readFileSync(path.join(c.dir, "character.yaml")))
      .update(
        readFileSync(
          path.resolve(c.dir, String(c.manifest.prompt)),
          "utf8",
        ).trim(),
      )
      .digest("hex")
      .slice(0, 16);
  if (current() !== revision)
    throw new Error("The character changed on disk. Reload before saving.");
  const draft = mkdtempSync(path.join(CHARACTERS, ".draft-"));
  try {
    copyCharacterDirectory(c.dir, draft);
    const doc = parseDocument(original);
    await mutate(doc, draft);
    writeFileSync(path.join(draft, "character.yaml"), String(doc));
    await validate(draft);
    if (current() !== revision)
      throw new Error("The character changed on disk. Reload before saving.");
    const backup = path.join(
      ROOT,
      ".cache/frontend/backups",
      `${c.id}-${Date.now()}-files`,
    );
    mkdirSync(path.dirname(backup), { recursive: true });
    renameSync(c.dir, backup);
    try {
      renameSync(draft, c.dir);
    } catch (error) {
      renameSync(backup, c.dir);
      throw error;
    }
  } finally {
    removeDraft(draft);
  }
}
export async function updateAssets(c: Character, form: FormData) {
  const data = definition(form);
  await updateCharacterFiles(c, String(data.revision), (doc, dir) =>
    assets(doc, dir, form, data),
  );
}
export async function updateExtensions(
  c: Character,
  data: Record<string, unknown>,
) {
  await updateCharacterFiles(c, String(data.revision), (doc, dir) => {
    const result = writeExtensionFiles(dir, data.extensions);
    doc.set("extensions", result.extensions);
    doc.set("disabled_extensions", result.disabled_extensions);
    doc.set("extension_order", result.extension_order);
  });
}
