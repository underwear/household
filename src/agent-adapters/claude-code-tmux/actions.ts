import type { ToolAction } from "../../core/agent-events";
import { MCP_SERVER } from "../../core/instructions";

// What a Claude Code tool call does, in one table, in neutral terms (Household says it in the chat's words): its
// kind, what it is on (a short path, the program, a pattern, a host), the agent's own words for it (Bash's and a
// subagent's `description`), and what it runs on (`summary`).

type Payload = Record<string, unknown>;

/** The agent user's home in the pet (its volume), and the dir claude works in. */
export const HOME = "/home/agent";
const WORK = `${HOME}/work`;

/**
 * Calls that are claude's own plumbing, no work to show: finding its tools, its task list and background tasks,
 * MCP resources, and every Household tool (the reply, a reaction, the history: in the chat, or no work of its
 * own). `Task`, which starts a subagent, is work.
 */
const INTERNAL = ["ToolSearch", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop", "BashOutput", "KillShell", "ListMcpResourcesTool", "ReadMcpResourceTool"];
const HOUSEHOLD_TOOL = `mcp__${MCP_SERVER}__`;

const text = (value: unknown): string => (typeof value === "string" ? value.toWellFormed().replace(/\s+/g, " ").trim() : "");

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** At most `max` characters as people count them (graphemes: an emoji, a flag, a letter with its accent is one). */
export function short(value: string, max: number): string {
  const parts = [...graphemes.segment(value)].map(({ segment }) => segment);
  return parts.length > max ? `${parts.slice(0, max - 1).join("")}…` : value;
}

/** A path, short: relative to the work dir (the home as ~), its name alone when still long. */
export function shortPath(path: string): string {
  const relative = path.startsWith(`${WORK}/`) ? path.slice(WORK.length + 1) : path.startsWith(`${HOME}/`) ? `~/${path.slice(HOME.length + 1)}` : path;
  if ([...graphemes.segment(relative)].length <= 40) return relative;
  return short(relative.split("/").filter(Boolean).at(-1) ?? relative, 40);
}

/** Shell words, quotes taken off (`'a b'` is one word); a `#` at a word's start comments out the rest of its line. */
function words(line: string): string[] {
  const found: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1);
      word = (word ?? "") + line.slice(i + 1, end < 0 ? line.length : end);
      i = end < 0 ? line.length : end;
    } else if (c === "\\" && i + 1 < line.length) word = (word ?? "") + line[++i];
    else if (/\s/.test(c)) {
      if (word !== undefined) found.push(word);
      word = undefined;
    } else if (c === "#" && word === undefined) break;
    else word = (word ?? "") + c;
  }
  if (word !== undefined) found.push(word);
  return found;
}

/** What comes before the program and is no program: wrappers (and the arguments they take), assignments. */
const WRAPPERS = ["sudo", "env", "time", "nohup", "exec", "command", "nice"];
/** Commands that set things up for the next one in a chain (`cd x && make`): the next one is the program. */
const SETUP = ["cd", "pushd", "export", "set", "source", ".", "true", ":"];

/**
 * The program a command runs («curl» of `FOO="a b" /usr/bin/curl -s …`, «npm» of `cd x && npm test` or
 * `(cd x && npm i)`): the first word of the first segment of the chain that is not set-up, past wrappers,
 * assignments and the shell's own marks. Undefined when there is none.
 */
export function program(command: string): string | undefined {
  const segments = command.split(/&&|\|\||[;|\n]/);
  for (const segment of segments) {
    const list = words(segment.replace(/^[\s({!]+/, "")).map((word) => word.replace(/^[({!]+|[)}]+$/g, "")).filter(Boolean);
    let at = 0;
    while (at < list.length) {
      const word = list[at]!;
      if (/^[A-Za-z_]\w*=/.test(word)) at += 1;
      else if (WRAPPERS.includes(word)) at += 1 + countFlags(list, at + 1);
      else if (word === "timeout") at += 1 + countFlags(list, at + 1) + 1; // its duration
      else break;
    }
    const first = list[at]?.split("/").at(-1);
    if (first && !SETUP.includes(first)) return first;
  }
  return undefined;
}

/** How many flags follow (`sudo -u root`: a flag and its value are both skipped when the value is no program). */
function countFlags(list: string[], from: number): number {
  let count = 0;
  while (list[from + count]?.startsWith("-")) count += list[from + count] === "-u" ? 2 : 1;
  return count;
}

const host = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** «create_issue» → «create issue», «NotebookEdit» → «Notebook edit». */
const humanize = (name: string) => {
  const spaced = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** A tool's row: the input field it runs on, and what it does. */
interface Row {
  on?: string;
  action: (input: Payload) => ToolAction;
}

const file = (kind: ToolAction["kind"]): Row => ({
  on: "file_path",
  action: (input) => {
    const path = text(input.file_path) || text(input.notebook_path) || text(input.path);
    return { kind, ...(path ? { target: shortPath(path) } : {}) };
  },
});
const on = (kind: ToolAction["kind"], field: string, shape: (value: string) => string = (value) => short(value, 60)): Row => ({
  on: field,
  action: (input) => ({ kind, ...(text(input[field]) ? { target: shape(text(input[field])) } : {}) }),
});
const says = (kind: ToolAction["kind"], field: string): Row => ({
  on: field,
  action: (input) => ({ kind, ...(text(input[field]) ? { says: short(text(input[field]), 120) } : {}) }),
});

const TABLE: Record<string, Row> = {
  Bash: {
    on: "command",
    action: (input) => {
      const run = program(text(input.command));
      return { kind: "run", ...(run ? { target: short(run, 40) } : {}), ...(text(input.description) ? { says: short(text(input.description), 120) } : {}) };
    },
  },
  Read: file("read"),
  Write: file("write"),
  Edit: file("edit"),
  MultiEdit: file("edit"),
  NotebookEdit: { ...file("edit"), on: "notebook_path" },
  Grep: on("search", "pattern"),
  Glob: on("search", "pattern"),
  WebSearch: on("search", "query"),
  WebFetch: on("fetch", "url", (url) => short(host(url), 60)),
  Agent: says("delegate", "description"),
  Task: says("delegate", "description"),
  AskUserQuestion: { action: () => ({ kind: "ask" }) },
  ExitPlanMode: { action: () => ({ kind: "plan" }) },
};

/**
 * What the call does (`action`), what it runs on (`summary`: its main input field, else its first text one; one
 * line, short), and whether it is plumbing (`internal`).
 */
export function actionOf(tool: string, input: Payload): { action: ToolAction; summary: string; internal: boolean } {
  const row = TABLE[tool];
  const value = row?.on ? input[row.on] : Object.values(input).find((candidate) => typeof candidate === "string");
  const summary = tool.startsWith(HOUSEHOLD_TOOL) ? tool.slice(HOUSEHOLD_TOOL.length) : short(text(value), 120);
  const internal = INTERNAL.includes(tool) || tool.startsWith(HOUSEHOLD_TOOL);
  if (row) return { action: row.action(input), summary, internal };
  // An MCP tool, mcp__<server>__<tool>: «github: create issue»; any other by its name.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return { action: { kind: "other", target: mcp ? `${mcp[1]}: ${humanize(mcp[2]!).toLowerCase()}` : humanize(tool) }, summary, internal };
}
