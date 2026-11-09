import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { api, type HarnessView, type WorkspaceView } from "./api";
import { BotDetailPage } from "./components/bot-detail";
import { TerminalDialog } from "./components/terminal";
import { pollTerminal } from "./components/terminal-poll";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("terminal polling never overlaps and cancels pending and in-flight work", async () => {
  let complete!: (value: { text: string }) => void;
  let signal!: AbortSignal;
  let requests = 0;
  let scheduled: (() => void) | undefined;
  let canceled = false;
  const updates: string[] = [];
  const stop = pollTerminal((value) => {
    signal = value;
    requests++;
    return new Promise((resolve) => { complete = resolve; });
  }, (text) => updates.push(text), () => {}, (callback) => {
    scheduled = callback;
    return () => { canceled = true; };
  });
  expect(requests).toBe(1);
  expect(scheduled).toBeUndefined();
  complete({ text: "first" });
  await flush();
  expect(updates).toEqual(["first"]);
  scheduled!();
  expect(requests).toBe(2);
  stop();
  expect(signal.aborted).toBe(true);
  expect(canceled).toBe(true);
  complete({ text: "late" });
  await flush();
  expect(updates).toEqual(["first"]);
});

test("terminal polling retains the previous snapshot on failures and recovers", async () => {
  let next!: () => void;
  let count = 0;
  let text: string | undefined;
  let error: string | undefined;
  const stop = pollTerminal(async () => {
    if (++count === 2) throw new Error("VM unavailable");
    return { text: `screen ${count}` };
  }, (value) => { text = value; error = undefined; }, (value) => { error = value; }, (callback) => {
    next = callback;
    return () => {};
  });
  await flush();
  next();
  await flush();
  expect(text).toBe("screen 1");
  expect(error).toBe("VM unavailable");
  next();
  await flush();
  expect(text).toBe("screen 3");
  expect(error).toBeUndefined();
  stop();
});

test("terminal API encodes bot paths and forwards cancellation", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = (async (path, options) => {
      expect(path).toBe("/api/houses/my%20workspace/pets/my%2Fbot/terminal");
      expect(options?.signal).toBe(controller.signal);
      expect(options?.method).toBe("GET");
      expect(options?.body).toBeUndefined();
      return Response.json({ text: "<script>untrusted</script>" });
    }) as typeof fetch;
    expect(await api.terminal("my workspace", "my/bot", controller.signal)).toEqual({ text: "<script>untrusted</script>" });
  } finally { globalThis.fetch = original; }
});

test("Console is available only for an explicit terminal capability", () => {
  const pet = { name: "bot", title: "Bot", ownTitle: null, display: "Bot", emoji: "🤖", ownEmoji: null, aliases: [], agent: "harness", model: "model", settings: {}, mode: null, key: null, problem: null, state: "running" as const };
  const house: WorkspaceView = { name: "home", pets: [pet], owners: [], allow: [], channels: [] };
  const agent: HarnessView = { name: "harness", models: ["model"], defaultModel: "model", providers: [], modes: [], defaultMode: null, settings: [] };
  const render = (agents: HarnessView[]) => renderToStaticMarkup(<BotDetailPage house={house} pet={pet} agents={agents} keys={[]} capacity={{ host: { cpus: 4, memoryMiB: 8192 }, houses: [house] }} refresh={async () => {}} notify={() => {}} />);
  expect(render([agent])).not.toContain(">Console</button>");
  expect(render([{ ...agent, terminal: false }])).not.toContain(">Console</button>");
  expect(render([{ ...agent, terminal: true }])).toContain(">Console</button>");
  expect(render([{ ...agent, name: "another", terminal: true }])).not.toContain(">Console</button>");
  const modal = renderToStaticMarkup(<TerminalDialog house="home" pet="bot" title="<script>" onClose={() => {}} />);
  expect(modal).toContain("Read-only");
  expect(modal).toContain("updates every 2 s");
  expect(modal).toContain("&lt;script&gt;");
  expect(modal).not.toContain("<script>");
  expect(modal).not.toContain("<input");
  expect(modal).not.toContain("<textarea");
});

test("the Console sizes its text so the whole 160 × 48 tmux screen fits its box", async () => {
  const { fitFont } = await import("./components/terminal");
  expect(fitFont({ width: 1536, height: 720 }, 0.6)).toBe(12); // width and height allow 16 and 12: the smaller
  expect(fitFont({ width: 960, height: 2000 }, 0.6)).toBe(10); // a narrow box: width decides
  expect(fitFont({ width: 300, height: 200 }, 0.6)).toBe(7); // never unreadable; it scrolls instead
  expect(fitFont({ width: 4000, height: 4000 }, 0.6)).toBe(14);
});
