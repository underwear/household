import { attachmentsBlock, type Attachment } from "./attachment";
import type { Choices, ReplyMode, External, MessageRef, PostRef, SenderRef } from "./channel";
import { renderHeader, type Header, type NewMessage } from "./header";
import { BATCH_TAG, block, CONTENT_TAG, MESSAGE_TAG, INTERNAL_TAG, tagFreeJson } from "./tags";

/**
 * received: queued for the pet. delivered: handed to its agent. answered: the pet replied or its turn ended.
 * failed: it may never be answered (typed but not submitted, or cut off by a restart); the person is told.
 * rejected: the security system refused it (it carries a Household tag, `household-…`); never given to the pet.
 */
export type MessageStatus = "received" | "dispatching" | "delivered" | "answered" | "failed" | "rejected";

/** cli: `house pet send`. chat: the house's person, through its channel. */
export type MessageOrigin = "cli" | "chat" | "cron" | "internal" | "inbox";

/** Who wrote a message of the chat: a person (as the channel names them), a pet, or Household itself (a notice, a card). */
export type ChatSender = { kind: "person"; ref: SenderRef; name: string } | { kind: "pet"; name: string } | { kind: "household" };

/** A person's message's facts from its channel, as the channel split them: `shown` to the pet (`meta`), all `kept`. */
export interface ChannelFacts {
  shown?: External;
  kept?: External;
}

/**
 * A message of a house's chat as Household remembers it, so a pet can name it (`id`: `m1`, `m2`, … in its
 * channel, Household's, never the channel's) and learn what a reaction is on. `ref`: its first piece in the
 * channel. `place`: the key of where it was written (internal key; the header exposes its public place address).
 * `pet`: whose conversation it is, the one pet it was for (the person's message: the pet it was routed to; a
 * post: the pet's own, or the pet a notice is about); who may see it is the journals it is in (`ChatRecords`),
 * not this. `excerpt`: what headers show of it, how it begins and ends (`headAndTail`; older records: how it
 * begins). `text`: all of it, its latest version (some records before C2 have none). `relayed`: content the
 * sender passed on. `facts`: a person's message's channel facts, of its latest version (none for posts and
 * records whose queue kept no header). `resolved`: its choices are made.
 */
export interface ChatRecord {
  id: string;
  ref: MessageRef | PostRef;
  place: string;
  pet: string;
  sender: ChatSender;
  excerpt: string;
  text?: string;
  relayed?: true;
  facts?: ChannelFacts;
  resolved?: true;
  /** Durable editing contract, only for pet text replies sent by this version. */
  outgoing?: { format: ReplyMode; parts: number; buttons?: Choices };
}

/** A message to a pet from its person. */
export interface Message {
  id: number;
  text: string;
  status: MessageStatus;
  origin: MessageOrigin;
  /** The channel's id of the person's message (of this version of it), so repeats and the "seen" mark find it. */
  ref?: MessageRef;
  /** For an edit the pet gets as a new message: the ref of the message it changes. */
  edits?: MessageRef;
  /**
   * Set for messages from a channel (`house pet send` has none): kept with the message, so a redelivery after a
   * restart has the same header.
   */
  header?: Header;
  /**
   * The key of the place it was written in (a pet's thread, a channel's inbox): its public address is in the header; it says
   * where the pet was asked and bounds a batch. None where it is not known (a reaction on a message Household has
   * no record of) and for `house pet send`.
   */
  place?: string;
  /** All of the channel's facts about it (`InboundMessage.kept`): kept for debugging, never shown. */
  facts?: External;
  /** The files it came with; `text` is their caption. Delivery fetches them before the pet gets the message. */
  attachments?: Attachment[];
}

export type MessageDraft = Pick<Message, "text" | "origin" | "ref" | "edits" | "header" | "place" | "facts" | "attachments">;

/** A relayed body is quoted line by line, a second mark that it is content to look at, far from its header too. */
const quoted = (text: string) => text.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/).map((line) => `> ${line}`).join("\n");

export type NewChatMessage = Message & { header: Header & { event: NewMessage } };

/** A new message from the chat (not an edit, a press, a reaction or one from `house pet send`): one that may go in a batch. */
export const batchable = (message: Message): message is NewChatMessage => message.header?.event.kind === "message";

/**
 * Whether `next` may go to the pet together with `first`, as one prompt: both new messages from the chat, from
 * the same sender, in the same place (a place id is unique in the house: it names its channel too). Anything
 * else is a batch's boundary.
 */
export function joins(first: Message, next: Message): boolean {
  if (!batchable(first) || !batchable(next)) return false;
  return first.origin === next.origin && first.header.from.id === next.header.from.id && first.place === next.place;
}

/**
 * One message of the chat as its block: `household-message` (with its id, when it has one), its header, its
 * body in `household-content`, quoted when relayed (a button press and a reaction have none; files without a
 * caption neither), and its files in `household-attachments`.
 */
function messageBlock({ text, header, attachments = [] }: Message & { header: Header }): string {
  const { event } = header;
  const said = event.kind === "message" || event.kind === "edit";
  const content = said && (text !== "" || attachments.length === 0) ? [block(CONTENT_TAG, [event.relayed ? quoted(text) : text])] : [];
  const files = said && attachments.length > 0 ? [attachmentsBlock(attachments)] : [];
  return block(MESSAGE_TAG, [renderHeader(header), ...content, ...files], said ? { id: event.id } : {});
}

/**
 * What the pet's agent gets. A message from the chat: its `household-message` block. A message from `house pet
 * send` goes as it is. Several messages (that `joins` the first) go as one `household-batch`: their blocks in
 * order, each with its own header.
 */
export function promptText(first: Message, ...more: Message[]): string {
  if (first.origin === "internal") return block(INTERNAL_TAG, [tagFreeJson({ text: first.text })]);
  if (more.length === 0) return first.header ? messageBlock({ ...first, header: first.header }) : first.text;
  const batch = [first, ...more];
  if (!batch.every(batchable)) throw new Error("only new messages from the chat go in a batch");
  return block(BATCH_TAG, batch.map(messageBlock), { count: batch.length });
}
