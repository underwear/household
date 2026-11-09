import { createHash } from "node:crypto";
import { InboxPollError } from "../../core/house-inboxes";

/** Bounded requests, no redirect credential forwarding; response bodies and auth never enter errors. */
export async function jsonGet(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) { await response.body?.cancel(); throw new InboxPollError(`Source returned HTTP ${response.status}`); }
  return readJson(response);
}
export async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new InboxPollError("Source returned an empty body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new InboxPollError("Source response exceeds 2 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export async function readJson(response: Response): Promise<unknown> {
  const text = await readText(response);
  try { return JSON.parse(text); }
  catch { throw new InboxPollError("Source did not return valid JSON"); }
}

/** Canonical JSON: key ordering is irrelevant, array ordering is significant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
