export type SlackFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
export class SlackReadError extends Error {
  constructor(readonly reason: string, readonly retryAfter?: number) {
    super(reason === "ratelimited" ? `Slack rate limit; retry after ${retryAfter ?? 60} seconds` : reason === "response_too_large" ? "Slack response too large (over 512 KiB); ask for fewer items with a smaller limit or count" : `Slack request failed (${reason})`);
  }
}
export async function slackRead(fetcher: SlackFetch, token: string, method: string, params: Record<string, string | number | boolean> = {}, signal?: AbortSignal) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
  return slackResponse(response);
}
export async function slackWrite(fetcher: SlackFetch, token: string, method: string, params: Record<string, unknown>, signal?: AbortSignal) {
  // getUploadURLExternal accepts form data, unlike the JSON-capable write methods.
  const form = method === "files.getUploadURLExternal";
  return slackResponse(await fetcher(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" }, body: form ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) : JSON.stringify(params), redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) }));
}
export async function slackOAuth(fetcher: SlackFetch, params: Record<string, string>) {
  return slackResponse(await fetcher("https://slack.com/api/oauth.v2.access", { method: "POST", body: new URLSearchParams(params), redirect: "error", signal: AbortSignal.timeout(30_000) }));
}
async function slackResponse(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    const retry = Number(response.headers.get("retry-after"));
    throw new SlackReadError(response.status === 429 ? "ratelimited" : `http_${response.status}`, Number.isFinite(retry) && retry > 0 ? retry : 60);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SlackReadError("empty_response");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 512 * 1024) throw new SlackReadError("response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SlackReadError("invalid_response"); }
  if (!data || data.ok !== true) {
    const known = ["invalid_grant", "invalid_refresh_token", "invalid_code", "invalid_auth", "token_revoked", "token_expired", "account_inactive", "missing_scope", "not_authed", "channel_not_found", "not_in_channel", "file_not_found", "thread_not_found", "ratelimited", "already_reacted", "no_reaction", "invalid_name", "message_not_found", "cant_update_message", "cant_delete_message", "edit_window_closed", "user_not_found", "users_not_found", "usergroup_not_found", "invalid_arguments", "file_uploads_disabled", "file_too_large"];
    throw new SlackReadError(known.includes(data?.error) ? data.error : "request_failed");
  }
  return { data, scopes: (response.headers.get("x-oauth-scopes") ?? "").split(",").map(s => s.trim()).filter(Boolean) };
}
