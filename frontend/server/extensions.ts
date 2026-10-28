import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import type { Character } from "../../runtime/src/manifest.ts";
import type {
  AvailableExtension,
  ExtensionSelection,
  ExtensionInfo,
} from "../src/types.ts";
import { ROOT } from "./paths.ts";

type Entry = {
  path: string;
  config_file?: string;
  config?: Record<string, unknown>;
};
function objectYaml(text: string, label: string): Record<string, unknown> {
  const doc = parseDocument(text);
  const value: unknown = doc.toJS();
  if (
    doc.errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error(`Invalid ${label}: use a YAML mapping.`);
  return value as Record<string, unknown>;
}
export function availableExtensions(): AvailableExtension[] {
  return ["extensions", "examples/extensions"].flatMap((base) => {
    const dir = path.join(ROOT, base);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          existsSync(path.join(dir, e.name, "extension.yaml")),
      )
      .map((e) => {
        const manifest = objectYaml(
          readFileSync(path.join(dir, e.name, "extension.yaml"), "utf8"),
          "extension",
        );
        const hooks = manifest.hooks;
        const defaults = path.join(dir, e.name, "defaults.yaml");
        return {
          id: `${base}/${e.name}`,
          name: String(manifest.name),
          description:
            typeof manifest.description === "string"
              ? manifest.description
              : "",
          hooks: Array.isArray(hooks)
            ? hooks.map(String)
            : Object.keys((hooks ?? {}) as object),
          service: manifest.service === true,
          defaultConfig: existsSync(defaults)
            ? readFileSync(defaults, "utf8")
            : "{}\n",
        };
      });
  });
}
function entries(c: Character): { entry: Entry; enabled: boolean }[] {
  return [
    ...((c.manifest.extensions as Entry[]) ?? []).map((entry) => ({
      entry,
      enabled: true,
    })),
    ...((c.manifest.disabled_extensions as Entry[]) ?? []).map((entry) => ({
      entry,
      enabled: false,
    })),
  ];
}
export function extensionAssignments(c: Character): ExtensionSelection[] {
  const selections = entries(c).map(({ entry, enabled }) => ({
    id: path
      .relative(ROOT, path.resolve(c.dir, entry.path))
      .split(path.sep)
      .join("/"),
    enabled,
    config: entry.config_file
      ? readFileSync(path.resolve(c.dir, entry.config_file), "utf8")
      : JSON.stringify(entry.config ?? {}, null, 2),
  }));
  const order = Array.isArray(c.manifest.extension_order)
    ? c.manifest.extension_order
    : [];
  const position = (id: string) =>
    order.includes(id) ? order.indexOf(id) : order.length;
  return selections.sort((a, b) => position(a.id) - position(b.id));
}
export function extensionInfo(c: Character): ExtensionInfo[] {
  return entries(c).map(({ entry, enabled }) => {
    const dir = path.resolve(c.dir, entry.path);
    const meta = objectYaml(
      readFileSync(path.join(dir, "extension.yaml"), "utf8"),
      "extension",
    );
    const hooks: Record<string, { blocking?: boolean; timeout_ms?: number }> =
      Array.isArray(meta.hooks)
        ? Object.fromEntries(meta.hooks.map((h) => [String(h), {}]))
        : ((meta.hooks ?? {}) as Record<
            string,
            { blocking?: boolean; timeout_ms?: number }
          >);
    const config = objectYaml(
      entry.config_file
        ? readFileSync(path.resolve(c.dir, entry.config_file), "utf8")
        : JSON.stringify(entry.config ?? {}),
      "extension configuration",
    );
    return {
      name: String(meta.name),
      handler: String(meta.handler),
      service: meta.service === true,
      enabled,
      hooks: Object.fromEntries(
        Object.entries(hooks).map(([name, opts]) => [
          name,
          {
            blocking: opts?.blocking !== false,
            timeout_ms: opts?.timeout_ms ?? 5000,
          },
        ]),
      ),
      keys: ((meta.requires_env as unknown[]) ?? []).map((key) =>
        typeof key === "string"
          ? key
          : String(
              String((key as { config: string }).config)
                .split(".")
                .reduce<unknown>(
                  (v, k) =>
                    v && typeof v === "object"
                      ? (v as Record<string, unknown>)[k]
                      : undefined,
                  config,
                ) ?? "",
            ),
      ),
    };
  });
}
export function writeExtensionFiles(
  dir: string,
  selections: unknown,
): {
  extensions: Entry[];
  disabled_extensions: Entry[];
  extension_order: string[];
} {
  if (!Array.isArray(selections) || selections.length > 50)
    throw new Error("Invalid extension selection.");
  const registry = availableExtensions();
  const result: {
    extensions: Entry[];
    disabled_extensions: Entry[];
    extension_order: string[];
  } = {
    extensions: [],
    disabled_extensions: [],
    extension_order: [],
  };
  const seen = new Set<string>();
  mkdirSync(path.join(dir, "extensions"), { recursive: true });
  selections.forEach((selection: ExtensionSelection, index) => {
    const option = registry.find((e) => e.id === selection.id);
    if (
      !option ||
      seen.has(option.name) ||
      typeof selection.enabled !== "boolean" ||
      typeof selection.config !== "string" ||
      selection.config.length > 32000
    )
      throw new Error("Invalid extension selection or configuration.");
    seen.add(option.name);
    result.extension_order.push(option.id);
    objectYaml(selection.config, `${option.name} configuration`);
    const filename = `extensions/extension-${index + 1}.yaml`;
    writeFileSync(path.join(dir, filename), selection.config);
    const entry = {
      path: path
        .relative(dir, path.join(ROOT, option.id))
        .split(path.sep)
        .join("/"),
      config_file: filename,
    };
    (selection.enabled ? result.extensions : result.disabled_extensions).push(
      entry,
    );
  });
  return result;
}
