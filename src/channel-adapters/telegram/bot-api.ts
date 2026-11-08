/** A failed Bot API call. `code` 0: no answer at all (network, timeout). Never carries the token. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    description: string,
    /** Seconds Telegram asks to wait (429). */
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${code ? `${code} ` : ""}${description}`);
  }
}

interface Answer<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Thin Bot API client (JSON or multipart POST). The token is in every URL, so no URL, and no error that may hold one, leaves. */
export class BotApi {
  constructor(
    private readonly token: string,
    private readonly base = "https://api.telegram.org",
  ) {}

  async call<T>(method: string, params: object, { timeoutMs = 30_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        ...(params instanceof FormData ? {} : { headers: { "content-type": "application/json" } }),
        body: params instanceof FormData ? params : JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      const name = (error as Error).name;
      throw new TelegramError(method, 0, name === "TimeoutError" || name === "AbortError" ? "no answer in time" : "unreachable");
    }
    const answer = (await response.json().catch(() => ({ ok: false }))) as Answer<T>;
    if (answer.ok) return answer.result as T;
    const code = answer.error_code ?? response.status;
    throw new TelegramError(method, code, answer.description ?? "unreadable answer", answer.parameters?.retry_after);
  }

  /** A file Telegram keeps for the bot (`getFile`'s `file_path`), read to its end; over `max` bytes, refused (413). */
  async file(path: string, max: number, signal: AbortSignal): Promise<Uint8Array> {
    const failed = () => new TelegramError("file", 0, signal.aborted ? "no answer in time" : "unreachable");
    let response: Response;
    try {
      response = await fetch(`${this.base}/file/bot${this.token}/${encodeURI(path)}`, { signal });
    } catch {
      throw failed();
    }
    const tooBig = () => new TelegramError("file", 413, `over ${max} bytes`);
    if (!response.ok) throw new TelegramError("file", response.status, "refused");
    if (Number(response.headers.get("content-length") ?? 0) > max) throw tooBig();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > max) throw tooBig();
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw failed();
    }
    return Buffer.concat(chunks);
  }
}
