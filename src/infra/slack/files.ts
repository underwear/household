import { SlackReadError, slackRead, slackWrite, type SlackFetch } from "./client";
import { inboxFileName, type FileRef } from "../../core/attachment";

export const SLACK_FILE_MAX_BYTES = 50 * 1024 * 1024;
const authenticatedHosts = new Set(["files.slack.com", "files-origin.slack.com"]);
const downloadHosts = new Set([...authenticatedHosts, "downloads.slack-edge.com"]);

/** URLs come only from Slack, but each hop still needs validation before credentials or bytes leave the host. */
function fileURL(value: unknown, upload = false): URL {
  let url: URL;
  try { if (typeof value !== "string") throw new Error(); url = new URL(value); }
  catch { throw new SlackReadError("invalid_file_url"); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !(upload ? authenticatedHosts : downloadHosts).has(url.hostname)) throw new SlackReadError("invalid_file_url");
  return url;
}
async function checkStatus(response: Response) {
  if (response.ok) return;
  await response.body?.cancel();
  const retry = Number(response.headers.get("retry-after"));
  throw new SlackReadError(response.status === 429 ? "ratelimited" : `http_${response.status}`, Number.isFinite(retry) && retry > 0 ? retry : 60);
}
async function fileBytes(response: Response, signal: AbortSignal) {
  await checkStatus(response);
  if (Number(response.headers.get("content-length")) > SLACK_FILE_MAX_BYTES) {
    await response.body?.cancel();
    throw new SlackReadError("file_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SlackReadError("empty_response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > SLACK_FILE_MAX_BYTES) throw new SlackReadError("file_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function slackDownload(fetcher: SlackFetch, token: string, file: string, signal: AbortSignal) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const { data } = await slackRead(fetcher, token, "files.info", { file }, signal);
  signal.throwIfAborted();
  if (data.file?.size > SLACK_FILE_MAX_BYTES) throw new SlackReadError("file_too_large");
  let url = fileURL(data.file?.url_private_download ?? data.file?.url_private);
  for (let hops = 0; ; hops++) {
    signal.throwIfAborted();
    const response = await fetcher(url, { headers: authenticatedHosts.has(url.hostname) ? { authorization: `Bearer ${token}` } : {}, redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (hops >= 5) throw new SlackReadError("too_many_redirects");
      const location = response.headers.get("location");
      if (!location) throw new SlackReadError("invalid_file_url");
      try { url = fileURL(new URL(location, url).href); }
      catch { throw new SlackReadError("invalid_file_url"); }
      continue;
    }
    const bytes = await fileBytes(response, signal);
    const contentType = typeof data.file?.mimetype === "string" ? data.file.mimetype : response.headers.get("content-type") ?? "application/octet-stream";
    const filename = inboxFileName(file, { kind: "document", file: file as FileRef, name: typeof data.file?.name === "string" ? data.file.name : file, mime: contentType });
    return { bytes, filename, contentType };
  }
}
export interface SlackUploadParams { filename: string; title?: string; channel_id?: string; thread_ts?: string; initial_comment?: string; alt_txt?: string }
export async function slackUpload(fetcher: SlackFetch, token: string, params: SlackUploadParams, bytes: Uint8Array, signal: AbortSignal) {
  if (!bytes.length || bytes.length > SLACK_FILE_MAX_BYTES) throw new SlackReadError("invalid_file_size");
  signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  const { data } = await slackWrite(fetcher, token, "files.getUploadURLExternal", { filename: params.filename, length: bytes.length, alt_txt: params.alt_txt }, signal);
  signal.throwIfAborted();
  const url = fileURL(data.upload_url, true);
  if (typeof data.file_id !== "string" || !/^F[A-Z0-9]+$/.test(data.file_id)) throw new SlackReadError("invalid_response");
  // The upload URL itself is authorized. Never attach the OAuth token or follow a POST redirect.
  const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Blob([bytes as BlobPart]), redirect: "error", signal });
  await checkStatus(response);
  await response.body?.cancel();
  signal.throwIfAborted();
  return slackWrite(fetcher, token, "files.completeUploadExternal", { files: [{ id: data.file_id, title: params.title ?? params.filename }], channel_id: params.channel_id, thread_ts: params.thread_ts, initial_comment: params.initial_comment }, signal);
}
