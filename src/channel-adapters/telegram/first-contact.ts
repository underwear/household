import { BotApi, TelegramError } from "./bot-api";

/** Who wrote to a bot in a private chat. */
export interface Contact {
  id: string;
  name: string;
  username?: string;
}

/** A group the bot is in, and what keeps it from being a channel with a topic per bot (none: it is ready). */
export interface FoundGroup {
  id: string;
  title: string;
  problems: string[];
}

type Chat = { id: number; type: string; title?: string };
interface Update {
  update_id: number;
  /** `migrate_to_chat_id` / `migrate_from_chat_id`: a group turned into a supergroup (turning on Topics does), which has a new id. */
  message?: { chat: Chat; from?: { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean }; migrate_to_chat_id?: number; migrate_from_chat_id?: number };
  my_chat_member?: { chat: Chat; new_chat_member?: { status?: string } };
}

/**
 * What a group still needs to be a channel with a topic per bot: Topics on (which makes it a supergroup), and the
 * bot an administrator that may manage topics and delete messages (as the channel checks when it opens).
 */
export async function groupProblems(api: BotApi, chat: string | number): Promise<FoundGroup> {
  const info = await api.call<{ id: number; type: string; title?: string; is_forum?: boolean }>("getChat", { chat_id: chat });
  const me = await api.call<{ id: number }>("getMe", {});
  const member = await api.call<{ status: string; can_manage_topics?: boolean; can_delete_messages?: boolean }>("getChatMember", { chat_id: chat, user_id: me.id });
  const problems: string[] = [];
  if (info.type !== "supergroup" || !info.is_forum) problems.push("turn on Topics in the group's settings");
  if (member.status !== "administrator") problems.push("make the bot an administrator of the group, with Manage topics and Delete messages");
  else {
    if (!member.can_manage_topics) problems.push("give the bot the Manage topics right");
    if (!member.can_delete_messages) problems.push("give the bot the Delete messages right");
  }
  const id = String(info.id ?? chat);
  return { id, title: info.title ?? id, problems };
}

const contactOf = (from: NonNullable<NonNullable<Update["message"]>["from"]>): Contact => ({
  id: String(from.id),
  name: [from.first_name, from.last_name].filter(Boolean).join(" ") || String(from.id),
  ...(from.username ? { username: from.username } : {}),
});

/**
 * Watches a new bot while it is set up: the first person who writes to it in a private chat from now on (its owner,
 * who need not look up their Telegram id), and, with `group`, the group it is in, found from the bot being added
 * or promoted there or a message in it, then checked (`groupProblems`) and said again whenever it changes there.
 * Updates that came before are skipped for the owner, not for the group: the bot is usually added before the
 * watch starts. A group that became a supergroup (turning on Topics does) is followed to its new id, and once a
 * supergroup is found, a plain group seen later does not take its place. Resolves "done" once it has the owner and, with `group`, a group with no problems; "timeout" at
 * `timeoutMs` or when `signal` aborts. What was read is confirmed to Telegram, so the daemon does not get it later.
 */
export async function watchSetup(token: string, { apiBase, timeoutMs = 180_000, signal, group = false, onContact, onGroup }: {
  apiBase?: string; timeoutMs?: number; signal?: AbortSignal; group?: boolean;
  onContact: (contact: Contact) => void; onGroup?: (found: FoundGroup) => void;
}): Promise<"done" | "timeout"> {
  const api = new BotApi(token, apiBase);
  const deadline = Date.now() + timeoutMs;
  let contact: Contact | undefined;
  let found: FoundGroup | undefined;
  let foundSuper = false;
  /** Groups that became supergroups: their old ids, never a channel's chat. */
  const moved = new Set<number>();
  const ready = () => !!contact && (!group || (!!found && found.problems.length === 0));
  const seeGroup = async (chat: Chat) => {
    if (!group || (chat.type !== "group" && chat.type !== "supergroup")) return;
    if (moved.has(chat.id) || (chat.type === "group" && foundSuper)) return;
    try {
      found = await groupProblems(api, chat.id);
    } catch {
      return; // the bot is not in it (any more), or Telegram did not answer: the next update says again
    }
    foundSuper = chat.type === "supergroup";
    onGroup?.(found);
  };
  /** The group an update is about: a migrated group's new supergroup, else its chat. */
  const seeUpdate = async (update: Update) => {
    const message = update.message;
    if (message?.migrate_from_chat_id) moved.add(message.migrate_from_chat_id);
    if (message?.migrate_to_chat_id) {
      moved.add(message.chat.id);
      return seeGroup({ id: message.migrate_to_chat_id, type: "supergroup", ...(message.chat.title ? { title: message.chat.title } : {}) });
    }
    const chat = update.my_chat_member?.chat ?? message?.chat;
    if (chat) await seeGroup(chat);
  };
  const pending = await api.call<Update[]>("getUpdates", { offset: 0, timeout: 0, allowed_updates: ["message", "my_chat_member"] }, { signal });
  for (const update of pending) await seeUpdate(update);
  let offset = pending.length ? pending.at(-1)!.update_id + 1 : 0;
  // After a long poll the network dropped, a pause that doubles up to 30 s: no busy loop while Telegram is unreachable.
  let pauseMs = 1000;
  while (Date.now() < deadline && !signal?.aborted) {
    const wait = Math.max(0, Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
    let updates: Update[];
    try {
      updates = await api.call<Update[]>("getUpdates", { offset, timeout: wait, allowed_updates: ["message", "my_chat_member"] }, { timeoutMs: (wait + 10) * 1000, signal });
    } catch (error) {
      if (signal?.aborted) return "timeout";
      if (!(error instanceof TelegramError && error.code === 0)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pauseMs, Math.max(0, deadline - Date.now()))));
      pauseMs = Math.min(pauseMs * 2, 30_000);
      continue;
    }
    pauseMs = 1000;
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!contact && message?.chat.type === "private" && message.from && !message.from.is_bot) {
        contact = contactOf(message.from);
        onContact(contact);
      }
      await seeUpdate(update);
    }
    if (updates.length) await api.call("getUpdates", { offset, timeout: 0 }).catch(() => undefined);
    if (ready()) return "done";
  }
  return "timeout";
}

/** `groupProblems` for bot `token`. */
export const checkGroup = (token: string, chat: string, apiBase?: string) => groupProblems(new BotApi(token, apiBase), chat);
