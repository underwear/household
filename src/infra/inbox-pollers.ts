import { createHash } from "node:crypto";
import { z } from "zod";
import { InboxPollError, pollResultSchema, type PollResult, type PollSource, type InboxItem } from "../core/house-inboxes";
import { runCommand } from "./process";
import mailHelper from "./inbox-mail.py" with { type: "text" };

export type Poller = (source: PollSource, cursor: string | undefined, initial: "new" | "latest", signal: AbortSignal) => Promise<PollResult>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const httpResult = z.strictObject({ version: z.literal(1), items: pollResultSchema.shape.items, nextCursor: z.string().max(4096).optional() });

/** Bounded requests, no redirect credential forwarding; response bodies and auth never enter errors. */
async function jsonGet(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) throw new InboxPollError(`Source returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new InboxPollError("Source returned an empty body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new InboxPollError("Source response exceeds 2 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new InboxPollError("Source did not return valid JSON"); }
}
const alert = z.object({
  fingerprint: z.string().max(128), startsAt: z.string().max(100), labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
  status: z.object({ state: z.string().max(100) }),
});
const monitor = z.object({ id: z.number(), name: z.string(), overall_state: z.string(), message: z.string().optional() });
type Snapshot = Record<string, { state: string; title: string; text: string }>;
const snapshotCursor = (entries: Record<string, { state: string; title: string }>, generation: number) => JSON.stringify({
  entries: Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { state: entry.state, title: entry.title.slice(0, 300) }])), generation,
});
/** A complete monitor snapshot yields transitions, including disappearance, never a repeated firing every tick. */
export function transitions(current: Snapshot, cursor?: string): PollResult {
  const old = cursor ? JSON.parse(cursor) as { entries: Snapshot; generation: number } : { entries: {}, generation: 0 };
  const generation = old.generation + 1;
  const items: InboxItem[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (old.entries[key]?.state !== value.state) items.push({ id: digest([key, value.state, generation]), title: `${value.state}: ${value.title}`.slice(0, 300), text: value.text.slice(0, 16000) });
  }
  for (const [key, value] of Object.entries(old.entries)) {
    if (!current[key]) items.push({ id: digest([key, "cleared", generation]), title: `No longer active: ${value.title}`.slice(0, 300), text: "This alert is no longer present in the source's active-alert snapshot (it may be resolved or removed)." });
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
export const pollInbox: Poller = async (source, cursor, initial, signal) => {
  try {
    if (source.kind === "imap" || source.kind === "pop3") {
      const result = await runCommand(["python3", "-c", mailHelper], { stdin: JSON.stringify({ source, cursor, initial }), timeoutMs: 60_000, signal });
      if (!result.ok) throw new InboxPollError("Mail polling failed. Check host, TLS port, app password and mailbox; stable UIDs are required.");
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
      const snapshot = Object.fromEntries(parsed.data.map(a => [a.fingerprint + ":" + a.startsAt, { state: a.status.state, title: a.labels.alertname ?? "Grafana alert", text: [a.annotations.summary, a.annotations.description, JSON.stringify(a.labels)].filter(Boolean).join("\n").slice(0, 16000) }]));
      // A first baseline must consume the whole snapshot, not backfill remaining pages later.
      if (!cursor && initial === "new") return { items: [], cursor: snapshotCursor(snapshot, 0) };
      return pollResultSchema.parse(transitions(snapshot, cursor));
    }
    url.pathname = url.pathname.replace(/\/$/, "") + "/api/v1/monitor/" + source.monitor;
    url.search = "";
    const parsed = monitor.safeParse(await jsonGet(url, source.headers, signal));
    if (!parsed.success) throw new InboxPollError("Invalid Datadog monitor response");
    const m = parsed.data;
    const snapshot = { [String(m.id)]: { state: m.overall_state, title: m.name, text: m.message ?? m.overall_state } };
    if (!cursor && initial === "new") return { items: [], cursor: snapshotCursor(snapshot, 0) };
    return transitions(snapshot, cursor);
  } catch (error) {
    if (signal.aborted) throw new InboxPollError("Poll cancelled");
    if (error instanceof InboxPollError) throw error;
    throw new InboxPollError("Poll failed. Check connection, credentials and source format.");
  }
};
