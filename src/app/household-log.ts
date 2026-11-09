import { formatCursor, parseCursor } from "../core/log-cursor";
import { describeAgent, escapeControls, EVENT_LOG_ROTATION, type HouseholdEvent } from "../infra/event-log";
import { readBackward, readForward, type FileLine } from "../infra/log-files";

/** Where a line of the Household log comes from: the daemon itself, a pet's agent, or the egress proxy. */
export type LogKind = "daemon" | "agent" | "network";
export const LOG_KINDS: readonly LogKind[] = ["daemon", "agent", "network"];

/** One event of events.jsonl as people read it: when, from where, how bad, whose, what. */
export interface LogEvent {
  at: string;
  kind: LogKind;
  level: "info" | "warn" | "error";
  house?: string;
  pet?: string;
  text: string;
}

/** Which lines to show; every field narrows. `query`: words the line's text holds, any case. */
export interface LogFilter {
  house?: string;
  pet?: string;
  kinds?: readonly LogKind[];
  /** Warnings and errors only. */
  problems?: boolean;
  query?: string;
}

/** An event as read from the log, with where it is there (its file and offset): an id no other line has. */
export interface LogLine extends LogEvent {
  id: string;
}

/** A page of the log: its lines, oldest first, and where the next read goes on from (a cursor). */
export interface LogPage {
  lines: LogLine[];
  cursor: string;
  /** A first read that stopped looking before it found `limit` lines: the time of the oldest line it looked at. */
  searchedFrom?: string;
  /** A follow-up read's lines that fit but were left out for `limit`, older than its own. */
  skipped?: number;
}

/**
 * How the log is read: `window` bytes at a time (a follow-up read takes one window at most), the first read looking
 * back across rotated files until it has its lines or has read `budget` bytes (some 200 ms of parsing).
 */
export interface LogScan {
  window: number;
  budget: number;
  keep: number;
}
const SCAN: LogScan = { window: 8 * 1024 * 1024, budget: 64 * 1024 * 1024, keep: EVENT_LOG_ROTATION.keep };

// Daemon messages name a pet as «house/pet» after «pet», a house as «house work» or «house 'work'».
const PET_IN_MESSAGE = /\b(?:bot|pet) '?([a-z][\w-]*)\/([a-z][\w-]*)/;
const HOUSE_IN_MESSAGE = /\b(?:workspace|house) '?([a-z][\w-]*)/;

/** An event as a log line; undefined for a record that is no event. */
export function logLine(event: HouseholdEvent): LogEvent | undefined {
  if (event.type === "daemon") {
    const pet = PET_IN_MESSAGE.exec(event.message);
    const house = pet?.[1] ?? HOUSE_IN_MESSAGE.exec(event.message)?.[1];
    return { at: event.ts, kind: "daemon", level: event.level === "error" ? "error" : "info", ...(house ? { house } : {}), ...(pet ? { pet: pet[2] } : {}), text: escapeControls(event.message) };
  }
  if (event.type === "agent") {
    const failed = event.event.kind === "turn-failed" || (event.event.kind === "tool-finished" && event.event.failed === true);
    return { at: event.ts, kind: "agent", level: failed ? "warn" : "info", house: event.house, pet: event.pet, text: escapeControls(describeAgent(event.event)) };
  }
  if (event.type === "proxy") {
    const whose = { ...(event.subject ? { house: event.subject.name } : {}), ...(event.pet ? { pet: event.pet } : {}) };
    const why = event.reason ? ` — ${event.reason}` : "";
    if (event.kind === "request") {
      const level = event.status >= 500 ? "error" : event.status >= 400 ? "warn" : "info";
      return { at: event.ts, kind: "network", level, ...whose, text: escapeControls(`${event.method} ${event.target} → ${event.status}${event.swapped ? " · key filled in" : ""}${why}`) };
    }
    const level = event.verdict === "ALLOW" ? "info" : event.verdict === "DENY" ? "warn" : "error";
    return { at: event.ts, kind: "network", level, ...whose, text: escapeControls(`${event.verdict.toLowerCase()} ${event.target}${event.intercepted ? " (intercepted)" : ""}${why}`) };
  }
  return undefined;
}

export function matches(line: LogEvent, filter: LogFilter): boolean {
  if (filter.house && line.house !== filter.house) return false;
  if (filter.pet && line.pet !== filter.pet) return false;
  if (filter.kinds && !filter.kinds.includes(line.kind)) return false;
  if (filter.problems && line.level === "info") return false;
  if (filter.query && !line.text.toLowerCase().includes(filter.query.toLowerCase())) return false;
  return true;
}

/** The lines that fit the filter; `seen` gets the time of the first event read, fitting or not. */
function parse(lines: FileLine[], filter: LogFilter, seen?: (at: string) => void): LogLine[] {
  const fit: LogLine[] = [];
  for (const raw of lines) {
    try {
      const line = logLine(JSON.parse(raw.text) as HouseholdEvent);
      if (!line) continue;
      if (seen) {
        seen(line.at);
        seen = undefined;
      }
      if (matches(line, filter)) fit.push({ id: formatCursor({ log: raw.file, at: raw.at }), ...line });
    } catch {
      // A half-written or foreign line: not an event.
    }
  }
  return fit;
}

/** The last `count` of `lines`; none for 0. */
const last = <T>(lines: T[], count: number): T[] => (count > 0 ? lines.slice(-count) : []);

/**
 * Reads the Household log (events.jsonl and its rotated files). Without `after`: the last `limit` lines that fit
 * the filter, looking back as far as the scan's budget allows. With `after` (a page's cursor): what was appended
 * since, up to `limit` (the newest), and the cursor after it; it goes on through a rotation, and a log replaced
 * meanwhile is read from its start.
 */
export function readLog(path: string, { after, limit, filter = {} }: { after?: string; limit: number; filter?: LogFilter }, scan = SCAN): LogPage {
  const count = Math.max(0, Math.floor(limit));
  if (after === undefined) {
    let found: LogLine[] = [];
    let oldest: string | undefined;
    const { end, complete } = readBackward(path, scan, (lines) => {
      if (count === 0) return true;
      found = [...parse(lines, filter, (at) => (oldest = at)), ...found];
      return found.length >= count;
    });
    const short = !complete && found.length < count && oldest !== undefined;
    return { lines: last(found, count), cursor: formatCursor(end), ...(short ? { searchedFrom: oldest } : {}) };
  }
  const { lines, next } = readForward(path, scan, parseCursor(after));
  const fit = parse(lines, filter);
  const skipped = Math.max(0, fit.length - count);
  return { lines: last(fit, count), cursor: formatCursor(next), ...(skipped ? { skipped } : {}) };
}

/** «12:04:31», or «2026-11-06 12:04:31» with its date. */
export function formatLogTime(at: string, date: boolean): string {
  const time = new Date(at);
  return date ? `${time.toLocaleDateString("en-CA")} ${time.toLocaleTimeString("en-GB")}` : time.toLocaleTimeString("en-GB");
}

/** «12:04:31  network  work/sibling  allow chatgpt.com:443»: a log line for a terminal. */
export function formatLogLine(line: LogEvent, date = false): string {
  const time = formatLogTime(line.at, date);
  const whose = line.house ? `${line.house}${line.pet ? `/${line.pet}` : ""}` : "-";
  const mark = line.level === "error" ? "ERROR " : line.level === "warn" ? "WARN  " : "";
  return `${time}  ${(line.kind === "agent" ? "harness" : line.kind).padEnd(7)}  ${whose.padEnd(18)}  ${mark}${line.text}`;
}
