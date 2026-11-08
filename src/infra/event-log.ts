import type { AgentEvent } from "../core/agent-events";
import { describeSubject } from "../core/egress";
import { RotatingLog, type Rotation } from "./log-files";
import type { ProxyLogEntry } from "./proxy-server";

export type HouseholdEvent =
  | { ts: string; type: "daemon"; level: "info" | "error"; message: string }
  | ({ type: "proxy" } & ProxyLogEntry)
  | { ts: string; type: "agent"; house: string; pet: string; event: AgentEvent };

/** events.jsonl rotates past 32 MiB and keeps three old files (events.jsonl.1 newest): 128 MiB of history at most. */
export const EVENT_LOG_ROTATION: Rotation = { maxBytes: 32 * 1024 * 1024, keep: 3 };

/** The unified event log: one JSONL file for machines, one human line per event for the terminal. */
export class EventLog {
  private readonly file: RotatingLog;

  constructor(
    path: string,
    private readonly print: (line: string) => void,
    rotation = EVENT_LOG_ROTATION,
  ) {
    this.file = new RotatingLog(path, rotation);
  }

  append(event: HouseholdEvent): void {
    this.file.append(`${JSON.stringify(event)}\n`);
    this.print(formatEvent(event));
  }

  info(message: string): void {
    this.append({ ts: new Date().toISOString(), type: "daemon", level: "info", message });
  }

  error(message: string): void {
    this.append({ ts: new Date().toISOString(), type: "daemon", level: "error", message });
  }

  agent(house: string, pet: string, event: AgentEvent): void {
    this.append({ ts: new Date().toISOString(), type: "agent", house, pet, event });
  }
}

export function formatEvent(event: HouseholdEvent): string {
  // Proxy fields come straight from a container: never let them drive the terminal or fake a log line.
  return escapeControls(`${new Date(event.ts).toLocaleTimeString("en-GB")} ${describe(event)}`);
}

function describe(event: HouseholdEvent): string {
  if (event.type === "daemon") return `${event.level === "error" ? "ERROR " : ""}${event.message}`;
  if (event.type === "agent") return `PET   ${event.house}/${event.pet} ${describeAgent(event.event)}`;
  const who = event.subject ? describeSubject(event.subject) : "unknown";
  const why = event.reason ? ` (${event.reason})` : "";
  if (event.kind === "request") {
    const swapped = event.swapped ? " credential filled in" : "";
    return `HTTP  ${who} ${event.source} ${event.method} ${event.target} → ${event.status}${swapped}${why}`;
  }
  const intercepted = event.intercepted ? " (intercepted)" : "";
  return `${event.verdict.padEnd(5)} ${who} ${event.source} ${event.method} ${event.target}${intercepted}${why}`;
}

/** Agent text on one line, cut short: the JSONL keeps it whole. */
const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
};

export function describeAgent(event: AgentEvent): string {
  switch (event.kind) {
    case "session-started":
      return `session ${event.continues ? "goes on" : "started"}${event.model ? ` (${oneLine(event.model)})` : ""}`;
    case "prompt-accepted":
      return `prompt accepted: ${oneLine(event.text)}`;
    case "tool-started":
      return `tool ${oneLine(event.tool)}: ${oneLine(event.summary)}`;
    case "tool-finished":
      return `tool ${oneLine(event.tool)} ${event.failed ? "failed" : "done"}${event.ms === undefined ? "" : ` (${event.ms} ms)`}`;
    case "tool-review":
      return `auto reviewer: ${event.status}${event.call ? ` (${oneLine(event.call)})` : ""}`;
    case "dialog-opened":
      return `dialog open (${event.dialog}): ${oneLine(event.summary)}`;
    case "dialog-closed":
      return "dialog closed";
    case "notification":
      return `notification: ${oneLine(event.text)}`;
    case "turn-finished":
      return `answer: ${oneLine(event.text)}`;
    case "turn-failed":
      return `turn failed: ${oneLine(event.error)}`;
  }
}

/** Replaces C0/C1 controls (newline, ESC, …) and format characters (bidi overrides, zero-width) with escapes. */
export function escapeControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, (c) => {
    const code = c.codePointAt(0)!;
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
  });
}
