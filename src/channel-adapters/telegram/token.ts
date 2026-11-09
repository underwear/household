import type { FieldCheck } from "../../core/channels";
import { HouseholdError } from "../../core/errors";
import { BotApi, TelegramError } from "./bot-api";

/** A bot token as @BotFather gives it: the bot's id, a colon, the secret part. */
const TOKEN = /^(\d{1,20}):[A-Za-z0-9_-]{30,}$/;

/** Whether `value` looks like a bot token: anything else is never sent to Telegram. */
export const isBotToken = (value: string): boolean => TOKEN.test(value);

/** What Telegram says of a bot. */
export interface BotInfo {
  username?: string;
  has_topics_enabled?: boolean;
}

/** Asks Telegram who the bot of `token` is (a TelegramError never holds the token). */
export const getMe = (token: string, apiBase?: string, timeoutMs = 10_000) => new BotApi(token, apiBase).call<BotInfo>("getMe", {}, { timeoutMs });

/** 401 and 404 are Telegram's answers to a token it does not know. */
export const isRefusedToken = (error: unknown) => error instanceof TelegramError && (error.code === 401 || error.code === 404);

/** How long a kept token's @username is good for, and how long to wait after Telegram could not tell (doubling, up to an hour). */
const FRESH_MS = 10 * 60_000;
const FIRST_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const DESCRIBE_TIMEOUT_MS = 2_000;

/**
 * A bot token given in a form: its shape, then Telegram's getMe (it must know the bot, and the bot must have
 * Threaded Mode on). Whose a token is: its bot's id. What one is, its bot's @username, is told from memory at once
 * (`bot <id>` until Telegram has told) and asked of Telegram in the background (shortly; after a failure not again
 * for a while), never holding up a page.
 */
export function telegramBotToken(apiBase?: string, now = () => Date.now(), requireTopics = true): FieldCheck {
  const known = new Map<string, { shown: string | null; at: number; failures: number; asking?: boolean }>();
  const ask = (value: string) => {
    const entry = known.get(value) ?? { shown: null, at: 0, failures: 0 };
    entry.asking = true;
    known.set(value, entry);
    getMe(value, apiBase, DESCRIBE_TIMEOUT_MS).then(
      (me) => Object.assign(entry, { shown: me.username ? `@${me.username}` : null, at: now(), failures: 0, asking: false }),
      () => Object.assign(entry, { at: now(), failures: entry.failures + 1, asking: false }),
    );
  };
  return {
    async accept(raw) {
      const value = raw.trim();
      const shape = TOKEN.exec(value);
      if (!shape) throw new HouseholdError("that is not a bot token: one looks like 123456789:AAH4x… (from @BotFather)");
      let me: BotInfo;
      try {
        me = await getMe(value, apiBase);
      } catch (error) {
        throw new HouseholdError(isRefusedToken(error) ? "Telegram does not know this bot token (revoked, or mistyped?)" : `Telegram could not be asked about the token (${(error as Error).message}); try again`);
      }
      if (requireTopics && !me.has_topics_enabled) throw new HouseholdError(`@${me.username} has threads off: turn on Threaded Mode in @BotFather (Bot Settings → Threads Settings), then try again`);
      const shown = `@${me.username}`;
      known.set(value, { shown, at: now(), failures: 0 });
      return { value, identity: shape[1]!, shown };
    },
    identityOf(value) {
      return TOKEN.exec(value)?.[1];
    },
    describe(value) {
      const id = TOKEN.exec(value)?.[1];
      if (id === undefined) return null;
      const entry = known.get(value);
      const wait = entry && (entry.failures > 0 ? Math.min(FIRST_BACKOFF_MS * 2 ** (entry.failures - 1), MAX_BACKOFF_MS) : FRESH_MS);
      if (!entry?.asking && (!entry || now() - entry.at >= wait!)) ask(value);
      return entry?.shown ?? `bot ${id}`;
    },
  };
}
