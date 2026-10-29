import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function sameSecret(
  actual: string | undefined,
  expected: string,
): boolean {
  const a = Buffer.from(actual ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function trustedHost(req: IncomingMessage, port: number): boolean {
  return (
    req.headers.host === `127.0.0.1:${port}` ||
    req.headers.host === `localhost:${port}`
  );
}

export function sameOrigin(req: IncomingMessage): boolean {
  return req.headers.origin === `http://${req.headers.host}`;
}

export function authenticated(req: IncomingMessage, secret: string): boolean {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("mutuals_studio="));
  return sameSecret(cookie?.slice("mutuals_studio=".length), secret);
}

export async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new Error("The request is too large.");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export async function readFormData(req: IncomingMessage): Promise<FormData> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.startsWith("multipart/form-data;"))
    throw new Error("Invalid upload request.");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 160 * 1024 * 1024)
      throw new Error(
        "The request is too large. Upload at most 160 MB at a time.",
      );
    chunks.push(chunk);
  }
  return new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Uint8Array(Buffer.concat(chunks)),
  }).formData();
}
