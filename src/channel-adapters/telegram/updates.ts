import type { Attachment, AttachmentKind, FileRef } from "../../core/attachment";
import type { External, InboundMessage, MessageRef, PostRef, SenderRef } from "../../core/channel";
import { pressedIndex, type InlineKeyboard } from "./keyboard";

/** The parts of a Bot API Update that Household reads. */
export interface Update {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: CallbackQuery;
  widget_query?: { id: string; from: CallbackQuery["from"]; chat?: { id: number }; message_id?: number; type: { type: string }; data: string };
  message_reaction?: MessageReaction;
}

/** One reaction: a standard emoji, or one Household names by its type (`custom_emoji`, `paid`, …). */
type Reaction = { type: string; emoji?: string };

/** A user's reactions on a message changed. It names the chat and the message, not the thread. */
export interface MessageReaction {
  chat: { id: number };
  message_id: number;
  user?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  date: number;
  old_reaction: Reaction[];
  new_reaction: Reaction[];
}

/** A press on an inline button. `message` is the bot's message with the button (only its chat and id when too old). */
export interface CallbackQuery {
  id: string;
  from: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  message?: TelegramMessage & { reply_markup?: InlineKeyboard };
  data?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  message_thread_id?: number;
  is_topic_message?: boolean;
  edit_date?: number;
  text?: string;
  forward_origin?: ForwardOrigin;
  /** The message this one answers; in a thread, without a reply of its own, the thread's first (service) message. */
  reply_to_message?: TelegramMessage;
  forum_topic_created?: { name?: string };
  forum_topic_edited?: { name?: string };
  caption?: string;
  /** The same for every message of an album (each of its files comes as a message of its own). */
  media_group_id?: string;
  photo?: (TelegramFile & { width: number; height: number })[];
  document?: TelegramFile;
  voice?: TelegramFile;
  audio?: TelegramFile & { performer?: string; title?: string };
  video?: TelegramFile;
  video_note?: TelegramFile;
  animation?: TelegramFile;
  sticker?: TelegramFile & { emoji?: string; is_animated?: boolean; is_video?: boolean };
  location?: { latitude: number; longitude: number };
  venue?: { location: { latitude: number; longitude: number }; title: string; address: string };
  contact?: { phone_number: string; first_name: string; last_name?: string };
  [field: string]: unknown;
}

/** What Telegram says of a file (its fields as each kind of file has them). */
interface TelegramFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
}

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

type ForwardOrigin =
  | { type: "user"; date: number; sender_user: TelegramUser }
  | { type: "hidden_user"; date: number; sender_user_name: string }
  | { type: "chat"; date: number; sender_chat: { id: number; title?: string; username?: string } }
  | { type: "channel"; date: number; chat: { id: number; title?: string; username?: string }; message_id: number };

/** Content the person may send that Household cannot take yet; anything else without text, file or place is a service message. */
const UNSUPPORTED = ["poll", "dice", "game", "story"];

/**
 * The fields with a file, in Household's kinds. An animation comes with a `document` too (for old clients): the
 * first found is the one.
 */
const FILES: [field: "voice" | "audio" | "video_note" | "video" | "animation" | "sticker" | "document", kind: AttachmentKind][] = [
  ["voice", "voice"],
  ["audio", "audio"],
  ["video_note", "video-note"],
  ["video", "video"],
  ["animation", "animation"],
  ["sticker", "sticker"],
  ["document", "document"],
];

/** Keys with a value only, for an attachment. */
const given = <T extends object>(fields: T) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

/**
 * The file a message came with, if any (a Telegram message has one at most). A photo comes in several sizes: the
 * largest is taken (a JPEG, as Telegram makes them). A MIME type Telegram leaves out but always uses is filled in,
 * so the file gets its extension: a round video's, a sticker's (by its kind).
 */
function attachmentOf(message: TelegramMessage): Attachment | undefined {
  const sizes = message.photo ?? [];
  const photo = sizes.length > 0 ? sizes.reduce((best, size) => (size.width * size.height > best.width * best.height ? size : best)) : undefined;
  if (photo) return given<Attachment>({ kind: "photo", file: photo.file_id as FileRef, mime: "image/jpeg", size: photo.file_size });
  const found = FILES.find(([field]) => message[field]);
  if (!found) return undefined;
  const [field, kind] = found;
  const file = message[field]!;
  const { sticker, audio } = message;
  const stickerMime = sticker && (sticker.is_animated ? "application/x-tgsticker" : sticker.is_video ? "video/webm" : "image/webp");
  const named = file.file_name ?? (audio ? [audio.performer, audio.title].filter(Boolean).join(" — ") : undefined);
  return given<Attachment>({
    kind,
    file: file.file_id as FileRef,
    name: named || undefined,
    mime: file.mime_type ?? (field === "video_note" ? "video/mp4" : stickerMime),
    size: file.file_size,
    duration: file.duration,
    emoji: sticker?.emoji,
  });
}

/** A place or a contact, which have no file, as text: what they say, in one line. */
function placeOrContact({ location, venue, contact }: TelegramMessage): string | undefined {
  const at = (point: { latitude: number; longitude: number }) => `${point.latitude}, ${point.longitude}`;
  if (venue) return `venue: ${venue.title}, ${venue.address} (${at(venue.location)})`;
  if (location) return `location: ${at(location)}`;
  if (contact) return `contact: ${fullName(contact)}, ${contact.phone_number}`;
  return undefined;
}

const fullName = (user: { first_name?: string; last_name?: string }) => [user.first_name, user.last_name].filter(Boolean).join(" ");

/** Keys with a value only. */
const known = (fields: Record<string, string | number | undefined>): External =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as External;

/**
 * What of a message's facts is context for the pet (`external`, shown as `channel.meta`): the sender's username,
 * and who a forward is from (name, username, when). Telegram's numbers (message, thread, user and chat ids, an
 * edit's date) only help debugging: they are `kept`, with everything else.
 */
function shown({ username, forward }: External): External {
  const from = forward && typeof forward === "object" && !Array.isArray(forward) ? forward : undefined;
  const who = from && known({ name: from.name as string | undefined, username: from.username as string | undefined, date: from.date as number | undefined });
  return { ...(username === undefined ? {} : { username }), ...(who ? { forward: who } : {}) };
}

/** A message's facts: all of them kept, the context among them shown. */
const facts = (kept: External) => ({ external: shown(kept), kept });

/** Who a forwarded message is from, with Telegram's ids for it: `forward` in the message's facts. */
function forwardOf(forward: ForwardOrigin): External {
  switch (forward.type) {
    case "user": {
      const { id, username } = forward.sender_user;
      return known({ name: fullName(forward.sender_user), user: id, username, date: forward.date });
    }
    case "hidden_user":
      return { name: forward.sender_user_name, date: forward.date };
    case "chat": {
      const { id, title, username } = forward.sender_chat;
      return known({ name: title ?? "a chat", chat: id, username, date: forward.date });
    }
    case "channel": {
      const { id, title, username } = forward.chat;
      return known({ name: title ?? "a channel", chat: id, username, message: forward.message_id, date: forward.date });
    }
  }
}

export interface ChatContext {
  /** The chat's Telegram id: only its updates are this channel's. */
  chat: number;
  /** Prefix of refs: message ids are only unique within one chat. */
  prefix: string;
  /** The place whose thread this is, if any. */
  placeOf: (thread: number) => string | undefined;
}

/**
 * Refs are `<chat>.<message id>`; one version of an edited message adds `.<edit date>`. A post's ref is the
 * same shape for the bot's message; a press is `<chat>.press.<callback id>`, a reaction change
 * `<chat>.reaction.<message id>.<date>.<update id>`; a sender's is
 * `telegram.user.<user id>`. Only this adapter reads them.
 */
export const messageRef = (chat: string, id: number, editDate?: number) => `${chat}.${id}${editDate ? `.${editDate}` : ""}` as MessageRef;
export const postRef = (chat: string, id: number) => `${chat}.${id}` as PostRef;
const pressRef = (chat: string, callback: string) => `${chat}.press.${callback}` as MessageRef;
const reactionRef = (chat: string, { message_id, date }: MessageReaction, update: number) => `${chat}.reaction.${message_id}.${date}.${update}` as MessageRef;
/** A Telegram user as a sender: by their id, as Telegram sends it or as the config writes it (digits, never rounded). */
export const senderRef = (user: number | string) => `telegram.user.${user}` as SenderRef;

/** The message id in a ref of this chat; undefined for a ref of another chat (the config changed since). */
export function messageIdOf(chat: string, ref: MessageRef | PostRef): number | undefined {
  if (!ref.startsWith(`${chat}.`)) return undefined;
  const id = Number(ref.slice(chat.length + 1).split(".")[0]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** What an update says, or why it is passed over (`answer`: what a press that is passed over is answered with). */
export type Parsed = { message: InboundMessage } | { skipped: string; answer?: string };

/** The answer to a press on a button that is not (any more) on the message pressed, or never was. */
export const INACTIVE = "This button is no longer active";

/** Where a message was written: its thread, and the place of that thread (none: General or no place's thread). */
function whereOf(message: TelegramMessage, placeOf: ChatContext["placeOf"]): { thread?: number; place?: string } {
  const thread = message.is_topic_message ? message.message_thread_id : undefined;
  const place = thread === undefined ? undefined : placeOf(thread);
  return { ...(thread === undefined ? {} : { thread }), ...(place === undefined ? {} : { place }) };
}

/**
 * A person's press on a button of a message of the bot. Its label is read from that message's own keyboard, so
 * it needs no memory of what was posted (a restart forgets nothing): a press whose data is not a button of that
 * keyboard (gone already, or forged) is passed over, and answered so.
 */
function choiceOf(callback: CallbackQuery, { chat: id, prefix: chat, placeOf }: ChatContext): Parsed {
  const { from, message } = callback;
  if (message?.chat.id !== id) return { skipped: `a press in another chat` };
  const index = pressedIndex(callback.data ?? "");
  if (index === undefined) return { skipped: "a press on a button Household did not make", answer: INACTIVE };
  const label = message.reply_markup?.inline_keyboard.flat().find((button) => "callback_data" in button && button.callback_data === callback.data)?.text;
  if (label === undefined) return { skipped: "a press on a button the message does not have (any more)", answer: INACTIVE };
  const { thread, place } = whereOf(message, placeOf);
  return {
    message: {
      kind: "choice",
      ref: pressRef(chat, callback.id),
      ...(place === undefined ? {} : { place }),
      from: { ref: senderRef(from.id), name: fullName(from) || from.username || String(from.id) },
      ...facts(known({ thread, user: from.id, username: from.username })),
      answersTo: postRef(chat, message.message_id),
      index,
      label,
    },
  };
}

const reactionName = (reaction: Reaction) => (reaction.type === "emoji" && reaction.emoji ? reaction.emoji : reaction.type.replace(/_/g, " "));
const reactionKey = (reaction: Reaction) => JSON.stringify(reaction);

/** A person's reactions on a message changed: what was added and removed, by name. */
function reactionOf(updateId: number, reacted: MessageReaction, { chat: id, prefix: chat }: ChatContext): Parsed {
  const { user } = reacted;
  if (reacted.chat.id !== id) return { skipped: "a reaction in another chat" };
  if (!user || user.is_bot) return { skipped: `a reaction from ${user ? "a bot" : "a chat"}, not a person` };
  const before = new Set(reacted.old_reaction.map(reactionKey));
  const after = new Set(reacted.new_reaction.map(reactionKey));
  const added = reacted.new_reaction.filter((reaction) => !before.has(reactionKey(reaction))).map(reactionName);
  const removed = reacted.old_reaction.filter((reaction) => !after.has(reactionKey(reaction))).map(reactionName);
  if (added.length === 0 && removed.length === 0) return { skipped: "a reaction that changed nothing" };
  return {
    message: {
      kind: "reaction",
      ref: reactionRef(chat, reacted, updateId),
      from: { ref: senderRef(user.id), name: fullName(user) || user.username || String(user.id) },
      ...facts(known({ message: reacted.message_id, user: user.id, username: user.username })),
      on: postRef(chat, reacted.message_id),
      added,
      removed,
    },
  };
}

/** The message a message quotes: none for the first message of its thread, which every one in it seems to answer. */
function quotedOf(message: TelegramMessage): number | undefined {
  const quoted = message.reply_to_message;
  if (!quoted || quoted.forum_topic_created || quoted.message_id === message.message_thread_id) return undefined;
  return quoted.message_id;
}

/**
 * An update of this chat as an inbound message, or why it is not one. Anyone who writes in it counts (Household
 * decides how far it trusts them); the bot's own service messages (a thread created, …) and Telegram's `/start`
 * are skipped. A message in a thread is for the place of that thread; in General, or in a thread that is no
 * place's, it is for the inbox. Everything Telegram says about it that may help goes into its facts (`kept`; who
 * a forward is from: `forward`; an album's id: `album`), the context among them into `external` (`shown`); a
 * forward is `relayed`; a reply names what it quotes (`replyTo`). A file comes with its caption as the text
 * (`attachments`); a place or a contact as text.
 */
export function inboundMessage(update: Update, context: ChatContext): Parsed {
  if (update.callback_query) return choiceOf(update.callback_query, context);
  if (update.message_reaction) return reactionOf(update.update_id, update.message_reaction, context);
  const { chat: id, prefix: chat, placeOf } = context;
  const edited = update.edited_message;
  const message = edited ?? update.message;
  if (!message) return { skipped: "not a message" };
  if (message.chat.id !== id) return { skipped: `from chat ${message.chat.id}, not this channel's` };
  const { from } = message;
  if (!from || from.is_bot) return { skipped: "not from a person" };
  const { thread, place } = whereOf(message, placeOf);
  const base = {
    ref: messageRef(chat, message.message_id, edited && (message.edit_date ?? 1)),
    ...(place === undefined ? {} : { place }),
    from: { ref: senderRef(from.id), name: fullName(from) || from.username || String(from.id) },
    // A private chat's id is its user's: said once.
    ...facts({
      ...known({
        message: message.message_id,
        chat: message.chat.id === from.id ? undefined : message.chat.id,
        thread,
        user: from.id,
        username: from.username,
        edited: edited && message.edit_date,
        album: message.media_group_id,
      }),
      ...(message.forward_origin ? { forward: forwardOf(message.forward_origin) } : {}),
    }),
  };
  if (message.text?.trim() === "/start") return { skipped: "/start" };
  const attachment = attachmentOf(message);
  // A file's caption is its message's text.
  const text = message.text ?? (attachment ? (message.caption ?? "") : placeOrContact(message));
  if (text !== undefined) {
    const quoted = quotedOf(message);
    return {
      message: {
        ...base,
        kind: "text",
        text,
        ...(edited ? { edits: messageRef(chat, message.message_id) } : {}),
        ...(message.forward_origin ? { relayed: true as const } : {}),
        ...(quoted === undefined ? {} : { replyTo: postRef(chat, quoted) }),
        ...(attachment ? { attachments: [attachment] } : {}),
      },
    };
  }
  const what = UNSUPPORTED.find((field) => field in message);
  return what ? { message: { ...base, kind: "unsupported", what } } : { skipped: "a service message" };
}
