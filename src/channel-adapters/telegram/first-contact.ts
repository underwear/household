import { BotApi, TelegramError } from "./bot-api";

/** Who wrote to a bot in a private chat. */
export interface Contact {
  id: string;
  name: string;
  username?: string;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean } };
}

/**
 * The first person who writes to the bot in a private chat from now on, so the owner need not look up their own
 * Telegram id; undefined when nobody has by `timeoutMs` or `signal` aborts. Earlier updates are skipped, and what
 * was read is confirmed to Telegram, so the daemon does not get that message later.
 */
export async function firstPrivateContact(token: string, { apiBase, timeoutMs = 180_000, signal }: { apiBase?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Contact | undefined> {
  const api = new BotApi(token, apiBase);
  const deadline = Date.now() + timeoutMs;
  const pending = await api.call<Update[]>("getUpdates", { offset: -1, timeout: 0 }, { signal });
  let offset = pending.length ? pending.at(-1)!.update_id + 1 : 0;
  while (Date.now() < deadline && !signal?.aborted) {
    const wait = Math.max(0, Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
    let updates: Update[];
    try {
      updates = await api.call<Update[]>("getUpdates", { offset, timeout: wait, allowed_updates: ["message"] }, { timeoutMs: (wait + 10) * 1000, signal });
    } catch (error) {
      if (signal?.aborted) return undefined;
      if (error instanceof TelegramError && error.code === 0) continue; // a long poll the network dropped
      throw error;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const from = update.message?.from;
      if (update.message?.chat.type !== "private" || !from || from.is_bot) continue;
      await api.call("getUpdates", { offset, timeout: 0 }).catch(() => undefined);
      const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id);
      return { id: String(from.id), name, ...(from.username ? { username: from.username } : {}) };
    }
  }
  return undefined;
}
