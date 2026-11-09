/** Desktop OAuth client metadata is distributable, unlike each user's refresh token. Release builds inject
 * the desktop client secret; source builds can supply the same credentials through environment variables. */
declare const HOUSEHOLD_BUNDLED_GOOGLE_SECRET: string;
export function googleClient() {
  return {
    id: process.env.HOUSEHOLD_GOOGLE_CLIENT_ID ?? "913496549497-rgjn9recv3nbfvjal37qelau62kuap2h.apps.googleusercontent.com",
    secret: process.env.HOUSEHOLD_GOOGLE_CLIENT_SECRET ?? (typeof HOUSEHOLD_BUNDLED_GOOGLE_SECRET === "string" ? HOUSEHOLD_BUNDLED_GOOGLE_SECRET : ""),
  };
}
export class GoogleHttpError extends Error {
  constructor(readonly status: number, readonly reason?: string) { super(`Google request failed (${status})${reason === "invalid_grant" ? ": reconnect this account" : ""}`); }
}
export type GoogleFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export const MAX_GOOGLE_BYTES = 256 * 1024;
export async function boundedText(response: Response, max = MAX_GOOGLE_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > max) throw new Error("Google response too large; narrow the search or request fewer results");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
export async function googleJson(fetcher: GoogleFetch, url: string | URL, init: RequestInit = {}) {
  const response = await fetcher(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
  const text = await boundedText(response);
  if (!response.ok) {
    let reason: string | undefined;
    try { if (JSON.parse(text).error === "invalid_grant") reason = "invalid_grant"; } catch {}
    throw new GoogleHttpError(response.status, reason);
  }
  return JSON.parse(text);
}
