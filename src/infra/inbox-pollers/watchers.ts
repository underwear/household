import { XMLParser, XMLValidator } from "fast-xml-parser";
import { InboxPollError, type InboxItem, type PollResult, type PollSource } from "../../core/house-inboxes";
import { canonical, digest, jsonGet, readText } from "./common";

type Source<K extends PollSource["kind"]> = Extract<PollSource, { kind: K }>;
type Initial = "new" | "latest";

/** RFC 6901, own properties only. Missing is distinct from an explicit JSON null. */
function select(value: unknown, pointer: string): { present: boolean; value?: unknown } {
  let node = value;
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/").map(t => t.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, token)) return { present: false };
    if (Array.isArray(node) && !/^(0|[1-9][0-9]*)$/.test(token)) return { present: false };
    node = (node as Record<string, unknown>)[token];
  }
  return { present: true, value: node };
}
export async function pollJsonWatch(source: Source<"json-watch">, cursor: string | undefined, initial: Initial, signal: AbortSignal): Promise<PollResult> {
  const body = await jsonGet(new URL(source.url), source.headers, signal);
  const values = source.pointers.length ? source.pointers.map(path => ({ path, ...select(body, path) })) : [{ path: "", present: true, value: body }];
  const hashes = values.map(value => digest(value));
  const old = cursor ? JSON.parse(cursor) as { hashes: string[]; generation: number } : undefined;
  const changed = values.filter((_, i) => hashes[i] !== old?.hashes[i]);
  if (old && !changed.length) return { items: [], cursor };
  const generation = (old?.generation ?? 0) + 1;
  const next = JSON.stringify({ hashes, generation });
  if (!old && initial === "new") return { items: [], cursor: next };
  const text = source.pointers.length ? changed.map(v => `${v.path || "/ (root)"}: ${v.present ? canonical(v.value) : "[missing]"}`).join("\n") : canonical(body);
  return { cursor: next, items: [{ id: digest([hashes, generation]), title: old ? "JSON changed" : "Current JSON snapshot", metadata: { mode: source.pointers.length ? "fields" : "whole", changedPaths: changed.map(v => v.path), generation }, text: text.length > 16000 ? text.slice(0, 15960) + "\n[Preview truncated]" : text }] };
}

export async function pollHealth(source: Source<"health">, cursor: string | undefined, initial: Initial, signal: AbortSignal): Promise<PollResult> {
  let httpStatus: number | null = null;
  let healthy = false, detail = "Request failed or timed out";
  const start = Date.now();
  try {
    const response = await fetch(source.url, { headers: source.headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(source.timeoutMs)]) });
    httpStatus = response.status;
    healthy = response.status === source.expectedStatus;
    detail = `HTTP ${response.status}; expected ${source.expectedStatus}; ${Date.now() - start} ms`;
    await response.body?.cancel();
  } catch { if (signal.aborted) throw new InboxPollError("Poll cancelled"); }
  const old = cursor ? JSON.parse(cursor) as { state: "up" | "down"; failures: number; generation: number } : undefined;
  const failures = healthy ? 0 : Math.min(source.failures, (old?.failures ?? 0) + 1);
  // Default baseline is up: a site already down on setup must still alert after the threshold.
  const state = healthy ? "up" : failures >= source.failures ? "down" : old?.state ?? "up";
  const changed = state !== (old?.state ?? "up");
  const emit = changed || (!old && initial === "latest" && healthy);
  const generation = (old?.generation ?? 0) + (emit ? 1 : 0);
  return { baselineHandled: true, cursor: JSON.stringify({ state, failures, generation }), items: emit ? [{
    id: digest([state, generation]), title: state === "down" ? "Endpoint is down" : old?.state === "down" ? "Endpoint recovered" : "Endpoint is healthy",
    metadata: { state, httpStatus, expectedStatus: source.expectedStatus, latencyMs: Date.now() - start, timeoutMs: source.timeoutMs, consecutiveFailures: failures, reason: httpStatus === null ? "network_or_timeout" : healthy ? "expected_status" : "unexpected_status" },
    text: `${detail}\n${state === "down" ? `${failures} consecutive failed checks.` : "Health check passed."}`,
  }] : [] };
}

const list = (value: unknown): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const textOf = (value: any): string => typeof value === "string" || typeof value === "number" ? String(value) : value && typeof value === "object" ? Object.entries(value).filter(([k]) => !k.startsWith("@_")).map(([, v]) => list(v).map(textOf).join(" ")).join(" ") : "";
const plain = (value: any) => textOf(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
export async function pollFeed(source: Source<"rss">, cursor: string | undefined, initial: Initial, signal: AbortSignal): Promise<PollResult> {
  const response = await fetch(source.url, { headers: source.headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  if (!response.ok) { await response.body?.cancel(); throw new InboxPollError(`Source returned HTTP ${response.status}`); }
  const xml = await readText(response);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new InboxPollError("Expected valid RSS or Atom XML without a DTD");
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false }).parse(xml);
  const atom = !!parsed.feed;
  if (!atom && !parsed.rss?.channel && !parsed.RDF) throw new InboxPollError("Expected an RSS or Atom feed");
  const entries = list(atom ? parsed.feed.entry : parsed.rss?.channel?.item ?? parsed.RDF?.item);
  if (entries.length > 5000) throw new InboxPollError("Feed exceeds 5,000 entries");
  const previous = cursor ? JSON.parse(cursor) as { seen: string[] } : { seen: [] };
  const seen = new Set(previous.seen);
  const items: InboxItem[] = [];
  for (const entry of entries) {
    const title = plain(entry.title).slice(0, 300) || "Feed entry";
    const body = plain(entry.summary ?? entry.description ?? entry.encoded ?? entry.content).slice(0, 16000);
    const rawLink = atom ? list(entry.link).find(l => !l["@_rel"] || l["@_rel"] === "alternate")?.["@_href"] : textOf(entry.link);
    let url: string | undefined;
    try { const u = new URL(rawLink, source.url); if (rawLink && ["http:", "https:"].includes(u.protocol) && !u.username && !u.password) { u.hash = ""; if (u.href.length <= 2048) url = u.href; } } catch {}
    const id = digest(textOf(entry.id ?? entry.guid) || url || [title, body, textOf(entry.published ?? entry.pubDate)]);
    if (seen.has(id)) continue;
    if (cursor || initial === "latest") {
      if (items.length === 50) continue; // Leave overflow unseen for subsequent polls.
      const date = Date.parse(textOf(entry.published ?? entry.pubDate ?? entry.updated));
      items.push({ id, title, text: body, metadata: { feedUrl: source.url, entryId: textOf(entry.id ?? entry.guid).slice(0,512), author: plain(entry.author ?? entry.creator).slice(0,500), categories: list(entry.category).slice(0,20).map(c => (typeof c === "object" && c ? c["@_term"] ?? plain(c) : plain(c)).slice(0,100)), format: atom ? "atom" : "rss" }, ...(url ? { url } : {}), ...(Number.isFinite(date) ? { occurredAt: new Date(date).toISOString() } : {}) });
    }
    seen.add(id);
  }
  return { items, cursor: JSON.stringify({ seen: [...seen].slice(-5000) }) };
}
