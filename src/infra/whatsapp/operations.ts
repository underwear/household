import { z } from "zod";

/** A chat: a JID from chats.list, or a phone number in international format (digits, an optional +). */
const chat = z.string().min(3).max(200).refine(v => /^\+?[\d\s()-]{6,24}$/.test(v) || /^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(v), "a chat JID from chats.list or a phone number like +34600111222");
const messageId = z.string().min(1).max(200).regex(/^[\w.:-]+$/);
const limit = (max: number, fallback: number) => z.number().int().min(1).max(max).default(fallback);
const time = z.iso.datetime({ offset: true });
interface Operation { description: string; schema: z.ZodType; write?: true }
export const WHATSAPP_OPERATIONS = {
  "chats.list": { description: "List chats, most recent first, with each one's last message. query filters by name or number. Follow nextBefore with before for older chats.", schema: z.strictObject({ query: z.string().max(200).optional(), limit: limit(100, 30), before: time.optional() }) },
  "messages.list": { description: "Read a chat's messages, oldest first. Edits and deletions keep everything: text is a message's last version, previous its earlier texts (oldest first, each with until, when it was replaced), edited the last edit's time, deleted when its author deleted it for everyone (no longer visible in the chat; treat as withdrawn); note says what happened in words. A message can be edited several times and then deleted. Without chat: the newest messages across all chats, newest first. before/after are ISO times; follow nextBefore for older ones.", schema: z.strictObject({ chat: chat.optional(), limit: limit(200, 50), before: time.optional(), after: time.optional() }) },
  "messages.search": { description: "Full-text search over the messages Household has seen (words, prefix match), newest first; optionally in one chat. Matches earlier versions of edited messages too, and deleted ones (see note).", schema: z.strictObject({ query: z.string().min(1).max(200), chat: chat.optional(), limit: limit(100, 30) }) },
  "contacts.search": { description: "Find people by saved name, their own WhatsApp name or part of their number.", schema: z.strictObject({ query: z.string().min(1).max(200), limit: limit(100, 20) }) },
  "media.download": { description: "Save a message's photo, video, audio, sticker or document into your inbox folder and return its path.", schema: z.strictObject({ chat, messageId }) },
  "messages.send": { description: "Send a text message as the owner. to is a chat JID or a phone number. replyTo quotes a message of that chat. Only what the people you work for asked you to send.", schema: z.strictObject({ to: chat, text: z.string().min(1).max(4000), replyTo: messageId.optional() }), write: true },
  "files.send": { description: "Send a file from your outbox folder as the owner: images and videos as media, the rest as documents. Only what the people you work for asked you to send.", schema: z.strictObject({ to: chat, path: z.string().min(1).max(1024), caption: z.string().max(1024).optional() }), write: true },
  "messages.react": { description: "React to a message with one emoji; an empty emoji removes the reaction.", schema: z.strictObject({ chat, messageId, emoji: z.string().max(16) }), write: true },
} satisfies Record<string, Operation>;
export type WhatsAppOperation = keyof typeof WHATSAPP_OPERATIONS;

export function whatsappOperation(operation: string, input: unknown): { name: WhatsAppOperation; spec: Operation; params: any } {
  if (!Object.hasOwn(WHATSAPP_OPERATIONS, operation)) throw new Error("Unknown WhatsApp operation; call household_connectors_whatsapp_operations");
  const spec: Operation = WHATSAPP_OPERATIONS[operation as WhatsAppOperation];
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid parameters: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { name: operation as WhatsAppOperation, spec, params: parsed.data };
}
export function whatsappCatalog(writable: boolean) {
  return Object.entries(WHATSAPP_OPERATIONS).filter(([, op]: [string, Operation]) => !op.write || writable).map(([name, op]) => ({ name, description: op.description, write: "write" in op, parameters: z.toJSONSchema(op.schema) }));
}
/** A phone number's digits, or undefined for a JID. */
export const phoneDigits = (value: string) => value.includes("@") ? undefined : value.replace(/\D/g, "");
