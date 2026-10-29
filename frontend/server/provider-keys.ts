import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { ROOT } from "./paths.ts";
export class ProviderKeyError extends Error {}

// Never return key values. Only edit the character's local environment file.
export function saveProviderKeys(
  file: string,
  allowed: string[],
  input: unknown,
  root = ROOT,
) {
  const directory = realpathSync(root);
  const target = path.resolve(file);
  const inside = (candidate: string) => {
    const relative = path.relative(directory, candidate);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  if (
    !inside(target) ||
    !inside(realpathSync(path.dirname(target))) ||
    !/^\.env(?:[._-][\w-]+)?$/.test(path.basename(target))
  )
    throw new ProviderKeyError(
      "Keys can only be saved to a local .env file inside this repository.",
    );
  if (
    existsSync(target) &&
    (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())
  )
    throw new ProviderKeyError(
      "The environment file must be a regular local file.",
    );
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProviderKeyError("Invalid provider keys.");
  const updates = Object.entries(input).flatMap(([name, value]) => {
    if (
      !allowed.includes(name) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      name in Object.prototype
    )
      throw new ProviderKeyError(
        "Only keys required by this character can be changed.",
      );
    if (
      typeof value !== "string" ||
      value.length > 8192 ||
      /["\\\r\n\0]/.test(value)
    )
      throw new ProviderKeyError("Enter a valid single-line provider key.");
    return value.trim() ? [[name, value.trim()] as const] : [];
  });
  if (!updates.length)
    throw new ProviderKeyError("Enter at least one new key to save.");
  let content = existsSync(target) ? readFileSync(target, "utf8") : "";
  const original = parseEnv(content);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  for (const [name, value] of updates) {
    const pattern = new RegExp(
      `(^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*)(?:"[^"]*"|'[^']*'|[^\\r\\n]*)`,
      "gm",
    );
    if (pattern.test(content))
      content = content.replace(
        pattern,
        (_match, prefix: string) => `${prefix}"${value}"`,
      );
    else
      content += `${content && !content.endsWith("\n") ? newline : ""}${name}="${value}"${newline}`;
  }
  const parsed = parseEnv(content);
  if (
    updates.some(([name, value]) => parsed[name] !== value) ||
    Object.entries(original).some(
      ([name, value]) =>
        !updates.some(([key]) => key === name) && parsed[name] !== value,
    )
  )
    throw new ProviderKeyError(
      "The environment file could not be updated safely.",
    );
  const temporary = `${target}.studio-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
