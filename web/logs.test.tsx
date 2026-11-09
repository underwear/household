import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LogLine } from "./api";
import { followLog } from "./components/log-follow";
import { appendPage, lastText, logEntry, LogsDialog, BotLogs, logTime } from "./components/logs";
import { workspacePath, botPath, routeOf } from "./router";


test("logs exist only at bot level; old broad log pages lead back to the bots", () => {
  expect(routeOf("/logs")).toEqual({ page: "redirect", to: "/" });
  expect(routeOf("/workspaces/work/logs")).toEqual({ page: "redirect", to: workspacePath("work", "bots") });
  expect(routeOf("/workspaces/work/bots/owl/logs")).toEqual({ page: "redirect", to: botPath("work", "owl") });
});

test("a bot's logs: a panel over its page, what Household logged about it or a log inside its VM", () => {
  const panel = renderToStaticMarkup(<LogsDialog house="work" pet={{ name: "owl" }} title="Owl" onClose={() => {}} />);
  expect(panel).toContain('aria-label="Owl logs"');
  expect(panel).toContain(">Close</button>");
  const html = renderToStaticMarkup(<BotLogs house="work" pet={{ name: "owl" }} />);
  for (const source of ["Activity", "Setup", "On start", "Docker", "Kernel"]) expect(html).toContain(`>${source}</button>`);
  expect(html).not.toContain('aria-label="Workspace"'); // its workspace and bot are given
  expect(html).not.toContain('aria-label="Bot"');
  expect(html).not.toContain('aria-label="What"');
  expect(html).not.toContain("Problems only");
  expect(html).toContain('aria-label="Log source"');
  expect(html).toContain('aria-label="Search the log"');
  expect(html).toContain('aria-label="Bot activity"');
});

test("a log line's time: the time today, the day too before today", () => {
  const now = new Date(2026, 10, 6, 18, 0);
  expect(logTime(new Date(2026, 10, 6, 17, 26, 12).toISOString(), now)).toBe("17:26:12");
  expect(logTime(new Date(2026, 10, 5, 9, 1, 2).toISOString(), now)).toBe("5 Nov 09:01:02");
});

const flush = async () => { for (let n = 0; n < 4; n++) await Promise.resolve(); };

test("a log follow reads its first page, then after each cursor; stopped, a late answer from before is dropped", async () => {
  const asked: (string | undefined)[] = [];
  const answers: ((page: { cursor: string }) => void)[] = [];
  const signals: AbortSignal[] = [];
  let tick: (() => void) | undefined;
  let scheduled = 0;
  const pages: [string, boolean][] = [];
  const follow = followLog<{ cursor: string }>((after, signal) => {
    asked.push(after);
    signals.push(signal);
    return new Promise((resolve) => answers.push(resolve));
  }, (page, first) => pages.push([page.cursor, first]), () => {}, { schedule: (callback) => { scheduled++; tick = callback; return () => {}; } });
  answers[0]!({ cursor: "f:10" });
  await flush();
  tick!();
  expect(asked).toEqual([undefined, "f:10"]);
  follow.stop(); // the filter changed while that read was in flight
  expect(signals[1]!.aborted).toBe(true);
  answers[1]!({ cursor: "f:99" });
  await flush();
  expect(pages).toEqual([["f:10", true]]); // the stale page never lands
  expect(scheduled).toBe(1); // nor reads on
});

test("a paused follow reads nothing more until Live again; one request at a time", async () => {
  let reads = 0;
  let tick: (() => void) | undefined;
  const follow = followLog(async () => ({ cursor: `f:${++reads}` }), () => {}, () => {}, { live: false, schedule: (callback) => { tick = callback; return () => { tick = undefined; }; } });
  await flush();
  expect(reads).toBe(1); // the first page comes paused too
  expect(tick).toBeUndefined();
  follow.setLive(true);
  tick!();
  await flush();
  expect(reads).toBe(2);
  follow.setLive(false);
  expect(tick).toBeUndefined();
  follow.stop();
});

test("rows keep their lines (and keys) as new ones push the oldest out; a page that left lines out marks the gap", () => {
  const line = (n: number): LogLine => ({ id: `f:${n * 10}`, at: "2026-11-06T16:22:31.000Z", kind: "daemon", level: "info", text: `line ${n}` });
  const rows = [line(1), line(2), line(3)];
  const next = appendPage(rows, { lines: [line(4)], cursor: "f:50" }, 3);
  expect(next.map((row) => row.id)).toEqual(["f:20", "f:30", "f:40"]);
  expect(next[0]).toBe(rows[1]!); // the same object: its memoized row does not render again
  expect(appendPage(rows, { lines: [], cursor: "f:40" })).toBe(rows);
  expect(appendPage(rows, { lines: [line(9)], cursor: "f:100", skipped: 5 }).slice(-2)).toEqual([{ id: "gap-f:90", skipped: 5 }, line(9)]);
});

test("a VM log keeps its last text from a line's start", () => {
  expect(lastText("one\ntwo\nthree\n", 9)).toBe("three\n");
  expect(lastText("short\n", 9)).toBe("short\n");
});

test("a log line reads as what it is: a word for it, its text without the prefix or the context, and how loud", () => {
  const agent = (text: string) => logEntry({ kind: "agent", text });
  expect(agent("answer: Done")).toEqual({ label: "Answer", text: "Done", tone: "loud" });
  expect(agent("tool mcp__household__reply: Done")).toEqual({ label: "Tool", text: "reply: Done", tone: "plain" });
  expect(agent("tool Bash done (49 ms)")).toEqual({ label: "Tool", text: "Bash done (49 ms)", tone: "quiet" });
  expect(agent('prompt accepted: <household-clock> {"now":1} </household-clock> <household-memory> {"k":"v"} </household-memory> hi')).toEqual({ label: "Message", text: "hi", tone: "loud" });
  expect(agent('prompt accepted: <household-clock> {"now":1} </household-clock> <household-memory> {"k":"v…').text).toBe("Household context only");
  expect(agent('prompt accepted: <household-internal> {"text":"From \\"owl\\": hi"} </household-internal>')).toEqual({ label: "Internal", text: 'From "owl": hi', tone: "plain" });
  expect(logEntry({ kind: "daemon", text: "bot work/owl: message delivered (0 left)" }).text).toBe("message delivered (0 left)");
  expect(logEntry({ kind: "network", text: "allow api.anthropic.com:443" }).tone).toBe("quiet");
});

test("a bot's activity leaves its network requests out until asked for", () => {
  const html = renderToStaticMarkup(<BotLogs house="work" pet={{ name: "owl" }} />);
  expect(html).toContain('aria-pressed="false" title="Show its network requests too"');
});
