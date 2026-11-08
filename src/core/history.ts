import type { External } from "./channel";
import { HouseholdError } from "./errors";
import { upTo } from "./excerpt";
import { clean, cleanChannel, type HeaderChannel, type Trust } from "./header";
import type { ChatSender } from "./message";
import { tagFreeJson } from "./tags";

/**
 * The pet's `history` tool: messages of its own journal, newest first, as JSON with the header's ids and
 * shapes. Plain data, never Household's tags: a result is a record of past messages.
 */

/** How much of a message's text a result shows: grapheme clusters, and UTF-16 code units at most. */
export const HISTORY_TEXT_MAX = 1500;
export const HISTORY_TEXT_UNITS = 3000;
/** The most words one search takes. */
export const HISTORY_WORDS_MAX = 10;

/**
 * Who wrote a message: a person, as a header's `from` (`id` absent for the few records older than M4.1 whose
 * sender nothing tells), the pet itself, or another pet.
 */
export type HistoryFrom = { id?: string; name: string; trust: Trust } | { kind: "you" } | { kind: "pet"; name: string };

export interface HistoryItem {
  id: string;
  /** When Household got (or posted) it, UTC, to the second. */
  when: string;
  /** The channel it was in, as a header shows it: as it is now, with the `meta` its header showed (a person's message, its latest version). */
  channel: HeaderChannel;
  from: HistoryFrom;
  relayed?: true;
  text: string;
  /** The text is not all of the message: cut (HISTORY_TEXT_MAX), or only its excerpt is known (records before C2). */
  truncated?: true;
}

/**
 * A record as a search hands it over (of the channel searched): its time as kept (ISO, UTC), the `meta` its
 * header showed, its text already cut (`historyText`).
 */
export interface FoundRecord {
  id: string;
  /** Never Household's: notices and cards are not found. */
  sender: Exclude<ChatSender, { kind: "household" }>;
  when: string;
  relayed?: true;
  meta?: External;
  text: string;
  truncated?: true;
}

/** What a result shows of a record's text: all of it, or its start; only the excerpt when the text is not known. */
export function historyText(text: string | undefined, excerpt: string): { text: string; truncated?: true } {
  const shown = text === undefined ? { text: excerpt, truncated: true } : upTo(text, HISTORY_TEXT_MAX, HISTORY_TEXT_UNITS);
  return shown.truncated ? { text: shown.text, truncated: true } : { text: shown.text };
}

export interface HistoryResult {
  messages: HistoryItem[];
  /** There are older ones: ask again with `before` = the last id. */
  more: boolean;
}

/**
 * The words of a search: runs of letters, digits and marks (how the search index splits text, too). Anything
 * else (quotes, `*`, `-`, brackets) only separates words, so nothing the pet writes is search syntax.
 */
export function searchWords(query: string): string[] {
  const words = query.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  if (words.length === 0) throw new HouseholdError("query has no words to look for (letters or digits)");
  if (words.length > HISTORY_WORDS_MAX) throw new HouseholdError(`query has ${words.length} words, at most ${HISTORY_WORDS_MAX}: keep the telling ones`);
  return words;
}

/** A date, maybe a time after `T`, maybe a zone (none: UTC). */
const DATE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * `since` / `until` as instants (ISO, UTC, milliseconds, as records' times are kept), so a record is in range when
 * `since <= when < until`. A date is a whole UTC day (`until` 2026-11-03 includes that day); a datetime without a
 * zone is UTC; `until` a datetime includes that instant. Throws, naming the form, for anything else.
 */
export function historyRange(since?: string, until?: string): { since?: string; until?: string } {
  return {
    ...(since === undefined ? {} : { since: instant("since", since, false) }),
    ...(until === undefined ? {} : { until: instant("until", until, true) }),
  };
}

function instant(name: "since" | "until", value: string, end: boolean): string {
  const fail = () => new HouseholdError(`${name} must be an ISO date, e.g. 2026-11-03, or a datetime, e.g. 2026-11-03T18:00:00Z`);
  const [, date, time, zone = "Z"] = DATE.exec(value.trim()) ?? [];
  const day = new Date(`${date}T00:00:00Z`);
  // An impossible day (2026-02-30) is not that day once parsed, or not parsed at all.
  if (!date || Number.isNaN(day.getTime()) || !day.toISOString().startsWith(date)) throw fail();
  if (time === undefined) {
    if (end) day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString();
  }
  const at = new Date(`${date}T${time}${zone}`).getTime();
  if (Number.isNaN(at)) throw fail();
  return new Date(at + (end ? 1 : 0)).toISOString();
}

/** One found record as the pet sees it, in `channel` (as it is now; the record's `meta` is added), by `from`. */
export function historyItem(record: FoundRecord, channel: HeaderChannel, from: HistoryFrom): HistoryItem {
  return {
    id: record.id,
    when: record.when.replace(/\.\d+Z$/, "Z"),
    channel: cleanChannel({ ...channel, ...(record.meta ? { meta: record.meta } : {}) }),
    from: "kind" in from ? (from.kind === "pet" ? { kind: "pet", name: clean(from.name) } : from) : { ...(from.id ? { id: from.id } : {}), name: clean(from.name), trust: from.trust },
    ...(record.relayed ? { relayed: true as const } : {}),
    text: record.text,
    ...(record.truncated ? { truncated: true as const } : {}),
  };
}

/** The tool's result: compact JSON that never holds a tag (`tagFreeJson`). */
export const renderHistory = (result: HistoryResult) => tagFreeJson(result);
