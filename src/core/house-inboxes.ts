import { z } from "zod";

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
  initial: z.enum(["new", "latest"]).default("new"),
  source: pollSourceSchema,
});
export const houseInboxesSchema = z.array(houseInboxSchema).max(30).refine(v => new Set(v.map(i => i.name)).size === v.length, "Inbox names must be unique");
export type HouseInbox = z.infer<typeof houseInboxSchema>;
export type PollSource = HouseInbox["source"];
export const inboxItemSchema = z.strictObject({
  id: z.string().min(1).max(512),
  title: z.string().max(300),
  text: z.string().max(16000),
  url: endpoint.optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export const pollResultSchema = z.strictObject({
  items: z.array(inboxItemSchema).max(50),
  cursor: z.string().max(250000).optional(),
});
export type PollResult = z.infer<typeof pollResultSchema>;
export interface InboxState {
  fingerprint: string;
  initialized: boolean;
  cursor?: string;
  seen: string[];
  pending: { item: InboxItem; channel: string; pets: string[]; posted?: boolean; delivered: string[] }[];
  recent: { id: string; title: string; at: string; status: "queued" | "delivered" }[];
  lastCheck?: string;
  lastSuccess?: string;
  nextCheck: number;
  error?: string;
  failures: number;
}
export interface InboxView {
  inbox: HouseInbox;
  status: Omit<InboxState, "cursor" | "seen" | "pending" | "fingerprint"> & { pendingCount: number; running: boolean };
}

/** A fixed, credential-free poller diagnostic safe to show in the owner UI. */
export class InboxPollError extends Error {}
