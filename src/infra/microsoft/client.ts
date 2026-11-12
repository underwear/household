/** Public client metadata is distributable; user credentials are never bundled. */
export function microsoftClient() {
  return { id: process.env.HOUSEHOLD_MICROSOFT_CLIENT_ID ?? "db38d3fa-318d-4940-910f-56e7cf1506be" };
}
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
export type MicrosoftFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export class MicrosoftHttpError extends Error {
  constructor(readonly status: number, readonly reason?: string, readonly retryAfter?: string) { super(`Microsoft request failed (${status})`); }
}
export async function microsoftText(response: Response, max = 256 * 1024): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("Microsoft response too large; request fewer results");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
export async function microsoftJson(fetcher: MicrosoftFetch, url: string | URL, init: RequestInit = {}) {
  const response = await fetcher(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
  const raw = await microsoftText(response);
  if (!response.ok) {
    let reason: string | undefined;
    try { const e = JSON.parse(raw).error; if (typeof e === "string") reason = e; } catch {}
    const retry = response.headers.get("retry-after");
    throw new MicrosoftHttpError(response.status, reason, retry && /^\d{1,8}$/.test(retry) ? retry : undefined);
  }
  return raw.trim() ? JSON.parse(raw) : { done: true };
}
