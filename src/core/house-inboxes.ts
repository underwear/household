import { z } from "zod";
import type { House } from "./household";

/** Poller credentials belong to the host config, never to a pet's environment. */
const endpoint = z.string().trim().max(2048).refine(value => {
  try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.hash; } catch { return false; }
}, "Use an HTTP(S) URL without embedded credentials or fragment");
const headers = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().max(8192).refine(v => !/[\r\n]/.test(v))).refine(h => Object.keys(h).length <= 20 && !Object.keys(h).some(k => /^(host|content-length|connection|transfer-encoding)$/i.test(k)), "Up to 20 request headers; transport headers cannot be overridden");
const mail = {
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(320).refine(v => !/[\r\n\0]/.test(v)),
  password: z.string().min(1).max(8192).refine(v => !/[\r\n\0]/.test(v)),
};
export const pollSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("telegram-bot"), token: z.string().trim().max(256).regex(/^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/) }),
  z.strictObject({ kind: z.literal("rss"), url: endpoint, headers: headers.default({}) }),
  z.strictObject({ kind: z.literal("health"), url: endpoint, headers: headers.default({}), timeoutMs: z.number().int().min(100).max(60000).default(10000), failures: z.number().int().min(1).max(10).default(3), expectedStatus: z.number().int().min(200).max(599).default(200) }),
  z.strictObject({ kind: z.literal("json-watch"), url: endpoint, headers: headers.default({}), pointers: z.array(z.string().max(512).regex(/^(?:\/(?:[^~]|~[01])*)*$/)).max(30).refine(v => new Set(v).size === v.length).default([]) }),
  z.strictObject({ kind: z.literal("http"), url: endpoint, headers: headers.default({}) }),
  z.strictObject({ kind: z.literal("grafana"), url: endpoint, headers: headers.default({}) }),
  z.strictObject({ kind: z.literal("datadog"), url: endpoint, headers: headers.default({}), monitor: z.string().regex(/^[0-9]+$/) }),
  z.strictObject({ kind: z.literal("imap"), ...mail, mailbox: z.string().min(1).max(200).refine(v => !/[\r\n\0]/.test(v)).default("INBOX") }),
  z.strictObject({ kind: z.literal("pop3"), ...mail }),
]);
export const houseInboxSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  title: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(60).max(86400).default(300),
  channel: z.string().min(1).max(256),
  pets: z.array(z.string().min(1)).max(50).refine(v => new Set(v).size === v.length),
  /** Subscribers that only collect events in their inbox history: never woken by this inbox. */
  quiet: z.array(z.string().min(1)).max(50).refine(v => new Set(v).size === v.length).default([]),
  delivery: z.enum(["announce", "silent"]).default("announce"),
  initial: z.enum(["new", "latest"]).default("new"),
  source: pollSourceSchema,
}).refine(v => v.delivery !== "silent" || v.pets.length > 0, "Silent delivery needs at least one subscribed pet")
  .refine(v => v.quiet.every(pet => v.pets.includes(pet)), "Quiet pets must be subscribed");
/** A pet's own switches for one inbox (its page's Inboxes tab). */
export const inboxSubscriberSchema = z.strictObject({ subscribed: z.boolean(), quiet: z.boolean() });
export const houseInboxesSchema = z.array(houseInboxSchema).max(30).refine(v => new Set(v.map(i => i.name)).size === v.length, "Inbox names must be unique");
export type HouseInbox = z.infer<typeof houseInboxSchema>;
export type PollSource = HouseInbox["source"];
export const inboxMetadataSchema = z.record(z.string(), z.json()).refine(value => {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) { const [node, depth] = stack.pop()!; if (depth > 8) return false; if (node && typeof node === "object") for (const child of Object.values(node)) stack.push([child, depth + 1]); }
  return new TextEncoder().encode(JSON.stringify(value)).length <= 16384;
}, "Metadata must be a JSON object up to 16 KiB and 8 levels deep");
export const inboxItemSchema = z.strictObject({
  id: z.string().min(1).max(512),
  title: z.string().max(300),
  text: z.string().max(16000),
  url: endpoint.optional(),
  metadata: inboxMetadataSchema.optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const pollResultSchema = z.strictObject({
  items: z.array(inboxItemSchema).max(50),
  cursor: z.string().max(1_000_000).optional(),
  baselineHandled: z.boolean().optional(),
});
export type PollResult = z.infer<typeof pollResultSchema>;
export interface InboxState {
  fingerprint: string;
  initialized: boolean;
  cursor?: string;
  seen: string[];
  pending: { item: InboxItem; channel: string; pets: string[]; delivery?: "announce" | "silent"; receivedAt?: string; posted?: boolean; delivered: string[] }[];
  recent: { id: string; title: string; at: string; status: "queued" | "delivered" }[];
  lastCheck?: string;
  lastSuccess?: string;
  nextCheck: number;
  error?: string;
  failures: number;
  problemSince?: string;
  incident?: string;
  notifications?: InboxState["pending"];
}
export interface InboxView {
  inbox: HouseInbox;
  status: Omit<InboxState, "cursor" | "seen" | "pending" | "fingerprint" | "notifications"> & { pendingCount: number; running: boolean };
}

/** A fixed, credential-free poller diagnostic safe to show in the owner UI. */
export class InboxPollError extends Error {}

/** Bot API has one update queue per bot, including across houses and rotated tokens. */
export function telegramInboxProblems(houses: House[]): string[] {
  const used = new Set(houses.flatMap(h => h.channels.filter(c => (c.kind === "telegram-private" || c.kind === "telegram-dm" || c.kind === "telegram-group")).map(c => c.token.split(":")[0])));
  const problems: string[] = [];
  for (const house of houses) for (const inbox of house.inboxes ?? []) {
    if (inbox.source.kind !== "telegram-bot") continue;
    const id = inbox.source.token.split(":")[0]!;
    if (used.has(id)) problems.push(`Inbox '${house.name}/${inbox.name}': Telegram bot is already used by a channel or another inbox. Use a dedicated bot.`);
    used.add(id);
  }
  return problems;
}

export const inboxHistoryQuery = z.strictObject({
  inbox: z.string().min(1).max(48).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  time: z.enum(["received", "occurred"]).default("received"),
  before: z.number().int().positive().safe().optional(),
  limit: z.number().int().min(1).max(50).default(10),
  query: z.string().trim().min(1).max(200).optional(),
}).refine(v => !v.since || !v.until || Date.parse(v.since) < Date.parse(v.until), "since must be before until");
