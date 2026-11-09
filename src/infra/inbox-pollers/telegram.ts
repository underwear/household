import { z } from "zod";
import { InboxPollError, type PollResult, type PollSource } from "../../core/house-inboxes";
import { readJson } from "./common";

type Source = Extract<PollSource, { kind: "telegram-bot" }>;
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const updateSchema = z.looseObject({ update_id: z.number().int().nonnegative().safe() });
const webhookSchema = z.object({ url: z.string(), pending_update_count: z.number().int().nonnegative() });
const cursorSchema = z.object({ offset: z.number().int().positive().safe().optional(), skip: z.number().int().nonnegative(), lastUpdateAt: z.number().optional() });

/** Only these three read methods are reachable; no send/edit/delete/webhook configuration methods. */
export function createTelegramBotReader(transport: Transport = fetch) {
  async function call(source: Source, method: "getMe" | "getWebhookInfo" | "getUpdates", signal: AbortSignal, params: Record<string, string> = {}): Promise<unknown> {
    try {
      const url = new URL(`https://api.telegram.org/bot${source.token}/${method}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await transport(url.href, { method: "GET", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 409) throw new InboxPollError("Telegram update queue is in use by a webhook or another poller. Use a dedicated bot.");
        if (response.status === 401 || response.status === 404) throw new InboxPollError("Telegram bot token was rejected.");
        throw new InboxPollError(`Telegram returned HTTP ${response.status}`);
      }
      const parsed = z.object({ ok: z.literal(true), result: z.unknown() }).safeParse(await readJson(response));
      if (!parsed.success) throw new InboxPollError("Telegram returned an invalid or unsuccessful response.");
      return parsed.data.result;
    } catch (error) {
      if (signal.aborted) throw new InboxPollError("Poll cancelled");
      if (error instanceof InboxPollError) throw error;
      // Transport errors contain the URL, which contains the token. Never forward them.
      throw new InboxPollError("Telegram request failed. Check the bot token and connection.");
    }
  }
  async function webhook(source: Source, signal: AbortSignal) {
    const info = webhookSchema.safeParse(await call(source, "getWebhookInfo", signal));
    if (!info.success) throw new InboxPollError("Invalid Telegram webhook information.");
    if (info.data.url) throw new InboxPollError("This Telegram bot has a webhook. Use a dedicated polling bot; Household will not remove the webhook.");
    return info.data;
  }
  return {
    async test(source: Source, signal: AbortSignal): Promise<PollResult> {
      const me = z.object({ id: z.number().int().positive(), is_bot: z.literal(true) }).safeParse(await call(source, "getMe", signal));
      if (!me.success || String(me.data.id) !== source.token.split(":")[0]) throw new InboxPollError("Invalid Telegram bot identity.");
      await webhook(source, signal);
      return { items: [] };
    },
    async poll(source: Source, cursor: string | undefined, initial: "new" | "latest", signal: AbortSignal): Promise<PollResult> {
      const info = await webhook(source, signal);
      const saved = cursor ? cursorSchema.safeParse(JSON.parse(cursor)) : undefined;
      if (saved && !saved.success) throw new InboxPollError("Invalid Telegram polling cursor.");
      const state = saved?.success ? saved.data : { skip: initial === "new" ? info.pending_update_count : 0, offset: undefined, lastUpdateAt: undefined };
      // After a week without updates Telegram may choose a lower random ID.
      if (state.lastUpdateAt && Date.now() - state.lastUpdateAt >= 7 * 86400000) state.offset = undefined;
      const params: Record<string, string> = { limit: "50", timeout: "10" };
      if (state.offset !== undefined) params.offset = String(state.offset);
      // Do not change allowed_updates: preserve the bot's existing subscription settings.
      const parsed = z.array(updateSchema).max(50).safeParse(await call(source, "getUpdates", signal, params));
      if (!parsed.success) throw new InboxPollError("Invalid Telegram updates response.");
      const updates = parsed.data.sort((a, b) => a.update_id - b.update_id);
      if (updates.some((u, i) => (state.offset !== undefined && u.update_id < state.offset) || (i > 0 && u.update_id === updates[i - 1]!.update_id))) throw new InboxPollError("Telegram returned out-of-order update IDs.");
      const skip = Math.min(state.skip, updates.length);
      const items = updates.slice(skip).map(update => {
        const kind = Object.keys(update).find(key => key !== "update_id") ?? "update";
        const payload = update[kind];
        const message = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        const chat = message.chat && typeof message.chat === "object" ? message.chat as Record<string, unknown> : {};
        const title = [kind.replace(/_/g, " "), typeof chat.title === "string" ? chat.title : typeof chat.username === "string" ? `@${chat.username}` : chat.id !== undefined ? `chat ${chat.id}` : ""].filter(Boolean).join(" · ").slice(0, 300);
        const body = JSON.stringify(update, null, 2);
        const from = message.from && typeof message.from === "object" ? message.from as Record<string, unknown> : {};
        const pick = (obj: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => typeof obj[k] === "number" || typeof obj[k] === "boolean" || typeof obj[k] === "string").map(k => [k, typeof obj[k] === "string" ? obj[k].slice(0,500) : obj[k]])) as Record<string, string | number | boolean>;
        const timestamp = typeof message.date === "number" ? message.date * 1000 : NaN;
        return { id: String(update.update_id), title,
          ...(Number.isFinite(timestamp) && Math.abs(timestamp) < 8640000000000000 ? { occurredAt: new Date(timestamp).toISOString() } : {}),
          metadata: { updateId: update.update_id, type: kind, chat: pick(chat,["id","type","title","username"]), from: pick(from,["id","is_bot","username","first_name","last_name"]), ...pick(message,["message_id","message_thread_id","edit_date","id","data","business_connection_id"]) }, text: body.length > 16000 ? body.slice(0, 15960) + "\n[Update preview truncated]" : body };
      });
      if (updates.length) {
        state.offset = updates.at(-1)!.update_id + 1;
        state.lastUpdateAt = Date.now();
      }
      state.skip = updates.length ? state.skip - skip : 0;
      // Offset acknowledges only on the NEXT request, after House persists this batch and drains delivery.
      return { items, cursor: JSON.stringify(state), baselineHandled: true };
    },
  };
}
export const telegramBotReader = createTelegramBotReader();
