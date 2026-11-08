import { WebClient, LogLevel } from "@slack/web-api";
import { RateLimited, StatusGone } from "../../core/channel";

export interface SlackApi {
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Do not retain SDK errors: request objects can contain Authorization and message bodies. */
export class SlackError extends Error {
  constructor(readonly code: string) { super(`Slack: ${code}`); }
}
export function safeSlackError(error: unknown): Error {
  const e = error as { code?: string; retryAfter?: number; data?: { error?: string } };
  if (e.code === "slack_webapi_rate_limited_error") return new RateLimited((e.retryAfter ?? 5) * 1000);
  const code = e.data?.error;
  return new SlackError(code && /^[a-z_]{1,80}$/.test(code) ? code : "request_failed");
}

export class SlackWebApi implements SlackApi {
  private readonly client: WebClient;
  constructor(token: string, apiBase?: string) {
    this.client = new WebClient(token, {
      slackApiUrl: apiBase, logLevel: LogLevel.ERROR,
      logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} },
      timeout: 15_000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    });
  }
  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try { return await this.client.apiCall(method, params) as T; }
    catch (error) { throw safeSlackError(error); }
  }
}

export async function statusCall<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    if (error instanceof SlackError && ["message_not_found", "cant_update_message", "cant_delete_message", "channel_not_found", "not_in_channel", "is_archived", "invalid_blocks", "invalid_auth", "token_revoked"].includes(error.code)) throw new StatusGone(error.message);
    throw error;
  }
}
