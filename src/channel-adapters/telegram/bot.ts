import { BotApi, type TelegramError } from "./bot-api";
import type { Update } from "./updates";

/** What must survive restarts: the position in the update stream and each place's thread. */
export interface TelegramState {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface TelegramBotOptions {
  /** For log lines, e.g. `house work`. */
  name: string;
  token: string;
  state: TelegramState;
  log: { info(message: string): void; error(message: string): void };
  /** Bot API base URL (a fake one in tests). */
  apiBase?: string;
  /** First wait after a failed poll; it doubles up to a minute. */
  retryMs?: number;
  /** How long one getUpdates waits for updates. */
  pollSeconds?: number;
}

/** One chat's side of the bot (a channel): it takes the updates of its chat. */
export interface BotChat {
  take(update: Update): Promise<void>;
}

const MAX_RETRY_MS = 60_000;

/** Waits `ms`, or less if `signal` aborts. */
export const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** The chat an update is in; undefined for one that names none (a press on a message too old to be shown). */
function chatOf(update: Update): number | undefined {
  return (update.message ?? update.edited_message)?.chat.id ?? update.callback_query?.message?.chat.id ?? update.message_reaction?.chat.id ?? update.widget_query?.chat?.id;
}

/**
 * A bot and its one poller (two would take each other's updates), shared by the channels it serves: each update
 * goes to the channel of its chat. An update of any other chat (someone else's private chat with the bot, a group
 * it was added to) is ignored, one log line per chat per run; a press there is still answered, so its button stops
 * spinning. Updates come by long polling, from a persisted offset, while a channel listens; nothing that goes
 * wrong stops it.
 */
export class TelegramBot {
  readonly api: BotApi;
  /** The bot's public id (the token's part before `:`). */
  readonly id: string;
  private readonly chats = new Map<number, BotChat>();
  private readonly listening = new Set<BotChat>();
  /** Chats that are no channel of this bot, already logged. */
  private readonly strangers = new Set<number>();
  private run?: { abort: AbortController; polling: Promise<void> };

  constructor(readonly options: TelegramBotOptions) {
    this.api = new BotApi(options.token, options.apiBase);
    this.id = options.token.split(":")[0]!;
  }

  private name?: Promise<string | undefined>;

  /** The bot's @username (getMe, asked once; asked again after a failure); undefined when Telegram does not say. */
  username(): Promise<string | undefined> {
    this.name ??= this.api.call<{ username?: string }>("getMe", {}).then(
      (me) => me.username,
      () => {
        this.name = undefined;
        return undefined;
      },
    );
    return this.name;
  }

  /** The channel of `chat`; one chat has one (the one it replaces has left first). */
  add(chat: number, channel: BotChat): void {
    if (this.chats.has(chat)) throw new Error(`chat ${chat} is a channel of this bot already`);
    this.chats.set(chat, channel);
  }

  /** The channel takes its updates from now on; the first one starts polling. */
  listen(channel: BotChat): void {
    this.listening.add(channel);
    if (this.run && !this.run.abort.signal.aborted) return;
    const abort = new AbortController();
    const run = { abort, polling: Promise.resolve() };
    run.polling = this.poll(abort.signal).finally(() => {
      if (this.run === run) this.run = undefined;
    });
    this.run = run;
  }

  /** The channel takes no more, and is no channel of its chat any more; when none listens, polling stops (resolves once it has). */
  async leave(channel: BotChat): Promise<void> {
    this.listening.delete(channel);
    for (const [chat, taker] of this.chats) if (taker === channel) this.chats.delete(chat);
    const run = this.run;
    if (!run || this.listening.size > 0) return;
    run.abort.abort();
    await run.polling;
  }

  /**
   * Long polling until stopped. Any failure (Telegram, the network, the state store, the log) waits 1 s … a
   * minute (429: what Telegram asks) and polls again from the saved offset; one log line per kind of failure.
   */
  private async poll(signal: AbortSignal): Promise<void> {
    const { state, log, name, retryMs = 1_000, pollSeconds = 25 } = this.options;
    const offset = `telegram.${this.id}.offset`;
    let wait = retryMs;
    let failure: string | undefined;
    while (!signal.aborted) {
      try {
        const params = { offset: Number(state.get(offset) ?? 0), timeout: pollSeconds, allowed_updates: ["message", "edited_message", "callback_query", "message_reaction", "widget_query"] };
        const updates = await this.api.call<Update[]>("getUpdates", params, { timeoutMs: (pollSeconds + 10) * 1000, signal });
        if (failure) log.info(`telegram ${name}: polling again`);
        failure = undefined;
        wait = retryMs;
        for (const update of updates) {
          if (signal.aborted) return; // a stopped bot confirms nothing more
          await this.dispatch(update);
          // After handling: a crash in between replays the update, and the receiver drops repeats by ref.
          state.set(offset, String(update.update_id + 1));
        }
      } catch (error) {
        if (signal.aborted) return;
        const { message, code, retryAfter } = error as TelegramError;
        try {
          // 409: another getUpdates on this bot (a second poller, a curl).
          if (message !== failure) log.error(`telegram ${name}: polling failed (${message})${code === 409 ? ", another client polls this bot" : ""}; retrying`);
        } catch {} // the log itself failing must not stop polling either
        failure = message;
        await pause(retryAfter ? retryAfter * 1000 : wait, signal);
        wait = Math.min(wait * 2, MAX_RETRY_MS);
      }
    }
  }

  /** The update to the channel of its chat; one of another chat is passed over. */
  private async dispatch(update: Update): Promise<void> {
    const chat = chatOf(update);
    const channel = chat === undefined ? undefined : this.chats.get(chat);
    if (channel && this.listening.has(channel)) return channel.take(update);
    const { log, name } = this.options;
    if (update.widget_query) {
      await this.api.call("answerWidgetQuery", { widget_query_id: update.widget_query.id, data: '{"received":false}' }, { timeoutMs: 5000 })
        .catch(error => log.error(`telegram ${name}: widget query was not answered: ${(error as Error).message}`));
    }
    if (update.callback_query) {
      await this.api
        .call("answerCallbackQuery", { callback_query_id: update.callback_query.id })
        .catch((error) => log.error(`telegram ${name}: a press was not answered: ${(error as Error).message}`));
    }
    if (chat === undefined) return log.info(`telegram ${name}: update ${update.update_id} skipped (it names no chat)`);
    if (this.strangers.has(chat)) return;
    this.strangers.add(chat);
    log.info(`telegram ${name}: chat ${chat} is no channel of this house: its updates are ignored`);
  }
}
