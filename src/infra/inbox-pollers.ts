import { z } from "zod";
import { telegramBotReader } from "./inbox-pollers/telegram";
import { digest, jsonGet } from "./inbox-pollers/common";
import { pollFeed, pollHealth, pollJsonWatch } from "./inbox-pollers/watchers";
import { InboxPollError, pollResultSchema, type PollResult, type PollSource, type InboxItem } from "../core/house-inboxes";
import { runCommand } from "./process";
import mailHelper from "./inbox-mail.py" with { type: "text" };

export type Poller = ((source: PollSource, cursor: string | undefined, initial: "new" | "latest", signal: AbortSignal) => Promise<PollResult>) & { test?: Poller };

const mailErrors: Record<string, string> = {
  mail: "Mail polling failed. Check server, port, connection security, credentials and folder; stable UIDs are required.",
  certificate: "Mail TLS certificate could not be verified. For Proton Bridge, export its TLS certificate and add it under Trusted certificate. Check the server name and certificate expiry too.",
  "certificate-config": "The trusted mail certificate could not be loaded. Use a PEM certificate exported by your mail server, without its private key.",
  starttls: "The mail server did not accept STARTTLS. Check its connection mode and port. No credentials were sent.",
  authentication: "Mail login was rejected. Check the username and app password. For Proton Bridge, use the password shown in Bridge, not your Proton account password.",
  tls: "Mail TLS negotiation failed. Check that connection security (TLS or STARTTLS) matches the server port.",
  connection: "Could not connect to the mail server. Check host and port. For Proton Bridge, keep Bridge running on the same computer as Household.",
  timeout: "The mail server timed out. Check host, port and connection security (TLS or STARTTLS).",
};

const httpResult = z.strictObject({ version: z.literal(1), items: pollResultSchema.shape.items, nextCursor: z.string().max(4096).optional() });

const alert = z.object({
  fingerprint: z.string().max(128), startsAt: z.string().max(100), labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
  status: z.object({ state: z.string().max(100) }),
});
const monitor = z.object({ id: z.number(), name: z.string(), overall_state: z.string(), message: z.string().optional() });
type Snapshot = Record<string, { state: string; title: string; text: string; metadata?: InboxItem["metadata"] }>;
const snapshotCursor = (entries: Record<string, { state: string; title: string }>, generation: number) => JSON.stringify({
  entries: Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { state: entry.state, title: entry.title.slice(0, 300) }])), generation,
});
/** A complete monitor snapshot yields transitions, including disappearance, never a repeated firing every tick. */
export function transitions(current: Snapshot, cursor?: string): PollResult {
  const old = cursor ? JSON.parse(cursor) as { entries: Snapshot; generation: number } : { entries: {}, generation: 0 };
  const generation = old.generation + 1;
  const items: InboxItem[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (old.entries[key]?.state !== value.state) items.push({ id: digest([key, value.state, generation]), title: `${value.state}: ${value.title}`.slice(0, 300), text: value.text.slice(0, 16000), metadata: { ...value.metadata, state: value.state, previousState: old.entries[key]?.state ?? null } });
  }
  for (const [key, value] of Object.entries(old.entries)) {
    if (!current[key]) items.push({ id: digest([key, "cleared", generation]), title: `No longer active: ${value.title}`.slice(0, 300), metadata: { fingerprint: key, state: "absent", previousState: value.state }, text: "This alert is no longer present in the source's active-alert snapshot (it may be resolved or removed)." });
  }
  // Keep the old entries for changes beyond this batch, so they are emitted on the next poll.
  if (items.length > 50) {
    const merged = { ...old.entries };
    let count = 0;
    for (const [key, value] of Object.entries(current)) if (old.entries[key]?.state !== value.state && count++ < 50) merged[key] = value;
    for (const key of Object.keys(old.entries)) if (!current[key] && count++ < 50) delete merged[key];
    return { items: items.slice(0, 50), cursor: snapshotCursor(merged, generation) };
  }
  return { items, cursor: snapshotCursor(current, generation) };
}
const pollLegacy = async (source: Exclude<PollSource, { kind: "rss" | "health" | "json-watch" | "telegram-bot" }>, cursor: string | undefined, initial: "new" | "latest", signal: AbortSignal): Promise<PollResult> => {
  try {
    if (source.kind === "imap" || source.kind === "pop3") {
      const result = await runCommand(["python3", "-c", mailHelper], { stdin: JSON.stringify({ source, cursor, initial }), timeoutMs: 60_000, signal });
      if (!result.ok) {
        let code = "mail";
        try { code = z.object({ error: z.enum(["mail", "certificate", "certificate-config", "starttls", "authentication", "tls", "connection", "timeout"]) }).parse(JSON.parse(result.stdout)).error; } catch {}
        throw new InboxPollError(mailErrors[code]!);
      }
      return pollResultSchema.parse(JSON.parse(result.stdout));
    }
    const url = new URL(source.url);
    if (source.kind === "http") {
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      url.searchParams.set("limit", "50");
      const parsed = httpResult.safeParse(await jsonGet(url, source.headers, signal));
      if (!parsed.success) throw new InboxPollError("Invalid inbox response: expected version: 1, items (up to 50), and optional nextCursor. See the HTTP poller contract.");
      return { items: parsed.data.items, cursor: parsed.data.nextCursor ?? cursor };
    }
    if (source.kind === "grafana") {
      url.pathname = url.pathname.replace(/\/$/, "") + "/api/alertmanager/grafana/api/v2/alerts";
      url.search = "";
      const parsed = z.array(alert).max(1000).safeParse(await jsonGet(url, source.headers, signal));
      if (!parsed.success) throw new InboxPollError("Invalid Grafana alert snapshot (maximum 1,000 alerts)");
      const snapshot = Object.fromEntries(parsed.data.map(a => [a.fingerprint + ":" + a.startsAt, { metadata: { fingerprint: a.fingerprint, startsAt: a.startsAt, labels: Object.fromEntries(Object.entries(a.labels).slice(0,30).map(([k,v]) => [k.slice(0,100),v.slice(0,200)])) }, state: a.status.state, title: a.labels.alertname ?? "Grafana alert", text: [a.annotations.summary, a.annotations.description, JSON.stringify(a.labels)].filter(Boolean).join("\n").slice(0, 16000) }]));
      // A first baseline must consume the whole snapshot, not backfill remaining pages later.
      if (!cursor && initial === "new") return { items: [], cursor: snapshotCursor(snapshot, 0) };
      return pollResultSchema.parse(transitions(snapshot, cursor));
    }
    url.pathname = url.pathname.replace(/\/$/, "") + "/api/v1/monitor/" + source.monitor;
    url.search = "";
    const parsed = monitor.safeParse(await jsonGet(url, source.headers, signal));
    if (!parsed.success) throw new InboxPollError("Invalid Datadog monitor response");
    const m = parsed.data;
    const snapshot = { [String(m.id)]: { metadata: { monitorId: m.id }, state: m.overall_state, title: m.name, text: m.message ?? m.overall_state } };
    if (!cursor && initial === "new") return { items: [], cursor: snapshotCursor(snapshot, 0) };
    return transitions(snapshot, cursor);
  } catch (error) {
    if (signal.aborted) throw new InboxPollError("Poll cancelled");
    if (error instanceof InboxPollError) throw error;
    throw new InboxPollError("Poll failed. Check connection, credentials and source format.");
  }
};

/** Exhaustive registry: adding a source kind requires a handler at compile time. */
type Registry = { [K in PollSource["kind"]]: (source: Extract<PollSource, { kind: K }>, cursor: string | undefined, initial: "new" | "latest", signal: AbortSignal) => Promise<PollResult> };
const registry: Registry = {
  "telegram-bot": telegramBotReader.poll,
  rss: pollFeed, health: pollHealth, "json-watch": pollJsonWatch,
  http: pollLegacy, grafana: pollLegacy, datadog: pollLegacy, imap: pollLegacy, pop3: pollLegacy,
};
export const pollInbox: Poller = async (source, cursor, initial, signal) => {
  try {
    // The discriminant selects the matching handler; the cast bridges TS's union-of-functions limitation.
    return pollResultSchema.parse(await (registry[source.kind] as Poller)(source, cursor, initial, signal));
  } catch (error) {
    if (signal.aborted) throw new InboxPollError("Poll cancelled");
    if (error instanceof InboxPollError) throw error;
    throw new InboxPollError("Poll failed. Check connection, credentials and source format.");
  }
};

// Connection probes may differ from polling: Telegram must not acknowledge or compete for updates.
pollInbox.test = async (source, cursor, initial, signal) => source.kind === "telegram-bot"
  ? telegramBotReader.test(source, signal)
  : pollInbox(source, cursor, initial, signal);
