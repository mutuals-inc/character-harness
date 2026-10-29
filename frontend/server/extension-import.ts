import {
  mkdirSync,
  existsSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { parseDocument } from "yaml";
import { HOOKS } from "../../runtime/src/state.ts";
import { ROOT } from "./paths.ts";
import { availableExtensions } from "./extensions.ts";

function mapping(text: string): Record<string, unknown> {
  const doc = parseDocument(text);
  const value = doc.toJS({ maxAliasCount: 30 });
  if (
    doc.errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error("Use a valid YAML mapping.");
  return value;
}
function safeName(name: string) {
  if (
    !name ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          /[:\x00-\x1f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Unsafe package path.");
}
export function importExtension(bytes: Uint8Array, root = ROOT): string {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw new Error("Choose a ZIP package under 20 MB.");
  let total = 0,
    count = 0;
  const files = unzipSync(bytes, {
    filter(file) {
      safeName(file.name.replace(/\/$/, ""));
      total += file.originalSize;
      if (++count > 200 || total > 50 * 1024 * 1024)
        throw new Error("Package is too large (200 files / 50 MB maximum).");
      return !file.name.endsWith("/");
    },
  });
  const names = Object.keys(files);
  const manifests = names.filter((name) => /(^|\/)extension.yaml$/.test(name));
  if (manifests.length !== 1)
    throw new Error(
      "Include exactly one extension.yaml at the root or inside one folder.",
    );
  const prefix = manifests[0].slice(0, -"extension.yaml".length);
  if (
    prefix.split("/").filter(Boolean).length > 1 ||
    names.some((name) => !name.startsWith(prefix))
  )
    throw new Error("Keep all package files beside extension.yaml.");
  const entries = Object.entries(files).map(
    ([name, data]) => [name.slice(prefix.length), data] as const,
  );
  if (
    entries.some(([name]) =>
      name
        .split("/")
        .some(
          (part) =>
            [".git", "node_modules"].includes(part.toLowerCase()) ||
            part.toLowerCase().startsWith(".env"),
        ),
    )
  )
    throw new Error(
      "Remove environment files, .git and node_modules from the package.",
    );
  const meta = mapping(strFromU8(files[manifests[0]]));
  if (
    typeof meta.name !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(meta.name)
  )
    throw new Error(
      "Extension name must use lowercase letters, numbers, hyphens or underscores.",
    );
  if (meta.service !== undefined && typeof meta.service !== "boolean")
    throw new Error("service must be true or false.");
  const hooks = meta.hooks ?? (meta.service === true ? [] : undefined);
  if (!hooks || typeof hooks !== "object")
    throw new Error("Include lifecycle hooks.");
  const hookNames = Array.isArray(hooks) ? hooks : Object.keys(hooks);
  if (
    (!hookNames.length && meta.service !== true) ||
    hookNames.some((name) => !HOOKS.includes(name))
  )
    throw new Error("Unknown or missing lifecycle hook.");
  if (!Array.isArray(hooks))
    for (const value of Object.values(hooks)) {
      const opts = value ?? {};
      if (
        typeof opts !== "object" ||
        Array.isArray(opts) ||
        (opts.blocking !== undefined && typeof opts.blocking !== "boolean") ||
        (opts.timeout_ms !== undefined &&
          (typeof opts.timeout_ms !== "number" ||
            !Number.isFinite(opts.timeout_ms) ||
            opts.timeout_ms <= 0 ||
            opts.blocking === false))
      )
        throw new Error("Invalid hook options.");
    }
  if (typeof meta.handler !== "string") throw new Error("Include a handler.");
  if (/^https?:\/\//.test(meta.handler)) {
    if (meta.service === true)
      throw new Error("A service needs a local module handler.");
    const url = new URL(meta.handler);
    if (url.username || url.password)
      throw new Error("Keep credentials in .env.");
  } else {
    meta.handler = meta.handler.replace(/^\.\//, "");
    safeName(meta.handler as string);
    if (!entries.some(([name]) => name === meta.handler))
      throw new Error("The handler file is missing.");
  }
  if (
    meta.requires_env !== undefined &&
    (!Array.isArray(meta.requires_env) ||
      meta.requires_env.some(
        (item) =>
          typeof item !== "string" &&
          (!item || typeof item.config !== "string"),
      ))
  )
    throw new Error("Invalid requires_env.");
  const defaults = entries.find(([name]) => name === "defaults.yaml");
  if (defaults) mapping(strFromU8(defaults[1]));
  const destination = path.join(root, "extensions", meta.name);
  if (
    existsSync(destination) ||
    (root === ROOT &&
      availableExtensions().some((ext) => ext.name === meta.name))
  )
    throw new Error(
      "An extension with this name is already installed. Use a different name for a new version.",
    );
  const staging = path.join(
    root,
    ".cache",
    "frontend",
    "extension-imports",
    randomUUID(),
  );
  mkdirSync(staging, { recursive: true });
  try {
    const seen = new Set<string>();
    for (const [name, data] of entries) {
      const key = name.toLowerCase();
      if (seen.has(key)) throw new Error("Duplicate package filename.");
      seen.add(key);
      const target = path.join(staging, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return `extensions/${meta.name}`;
}
