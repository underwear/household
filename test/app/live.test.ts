import { expect, test } from "bun:test";
import { describe as say, Live, type LiveSpot, type Whereabouts } from "../../src/app/live";
import type { ToolAction, TurnProgress } from "../../src/core/agent-events";
import type { Place, PostRef } from "../../src/core/channel";
import type { DialogQuestion } from "../../src/core/dialog";
import { fakeClock } from "../helpers";
import { FakeChannel } from "./fake-channel";

const PLACE: Place = { id: "pet:sibling@c", kind: "pet-thread", title: "🤖 Sibling" };

/** Lets the channel's promises (posts, edits) settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Bun.sleep(0);
};

function setup(channel = new FakeChannel()) {
  const clock = fakeClock();
  const errors: string[] = [];
  const live = new Live({ error: (line) => errors.push(line) }, { chatGapMs: 1_000 }, clock);
  const spot = (fields: Partial<LiveSpot> = {}): LiveSpot => ({ channel, place: PLACE, ...fields });
  const start = (turn = "t1", pet = "sibling", where = spot()) => live.start("work", pet, turn, where);
  const on = (event: TurnProgress, pet = "sibling") => live.progress("work", pet, event);
  /** A call: Bash in its own words (`says`), unless an action is given. */
  const tool = (call: string, says: string, more: Partial<Extract<TurnProgress, { kind: "tool-started" }>> = {}) =>
    on({ kind: "tool-started", tool: "Bash", summary: says, action: { kind: "run", says }, turn: "t1", call, ...more });
  const done = (call: string, more: Partial<Extract<TurnProgress, { kind: "tool-finished" }>> = {}) => on({ kind: "tool-finished", tool: "Bash", turn: "t1", call, ...more });
  /** Time goes by, and what it set off settles. */
  const tick = async (ms: number) => {
    clock.tick(ms);
    await settle();
  };
  return { live, channel, clock, errors, spot, start, on, tool, done, tick };
}

const here = (channel: FakeChannel): Whereabouts => ({ channel, placed: true });

test("what a call does, in the chat's words", () => {
  const cases: [ToolAction | undefined, string][] = [
    [{ kind: "read", target: "src/JWT.php" }, "Reading src/JWT.php"],
    [{ kind: "write" }, "Creating a file"],
    [{ kind: "edit", target: "~/notes.md" }, "Editing ~/notes.md"],
    [{ kind: "run", target: "curl", says: "Downloading the archive" }, "Downloading the archive"],
    [{ kind: "run", target: "curl" }, "Running curl"],
    [{ kind: "run" }, "Running a command"],
    [{ kind: "search", target: "TODO" }, 'Searching for "TODO"'],
    [{ kind: "fetch", target: "docs.example.com" }, "Opening docs.example.com"],
    [{ kind: "delegate", says: "Find .txt files" }, "Delegating: Find .txt files"],
    [{ kind: "ask" }, "Asking"],
    [{ kind: "plan" }, "Proposing a plan"],
    [{ kind: "other", target: "github: create issue" }, "github: create issue"],
    [undefined, "SomeTool"],
  ];
  expect(cases.map(([action]) => say(action, "SomeTool"))).toEqual(cases.map(([, want]) => want));
});

test("while working: one line with the stop button, edited only when it changes; plumbing never shown; a finished turn's post goes", async () => {
  const { live, channel, start, tool, done, on, tick } = setup();
  start();
  await tick(0);
  expect(channel.statuses).toEqual([]); // nothing to show yet
  tool("c1", "Extracting all files from the archive");
  await tick(0);
  expect(channel.statuses).toEqual(["post status-1 🤖 Sibling: working Extracting all files from the archive… [Stop]"]);
  expect(live.owns("status-1" as PostRef)).toBe(live.turnOf("work", "sibling")); // a press on it is this turn's
  done("c1");
  await tick(60_000);
  expect(channel.statuses).toHaveLength(1); // the same action still the latest: nothing to edit
  on({ kind: "tool-started", tool: "Read", summary: "x", action: { kind: "read", target: "src/JWT.php" }, turn: "t1", call: "c2" });
  on({ kind: "tool-started", tool: "mcp__household__reply", summary: "Done", internal: true, turn: "t1", call: "c3" }); // plumbing
  tool("c4", "Downloading the archive...", { internal: true });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Reading src/JWT.php… [Stop]");
  tool("c5", "Downloading the archive...");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Downloading the archive… [Stop]"); // its own dots off: one ellipsis
  live.finish("work", "sibling", "t1");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("drop status-1"); // the answer is in the chat
  expect(live.owns("status-1" as PostRef)).toBeUndefined();
});

test("a turn that only answers, or finishes before its first post goes out, gets no post at all", async () => {
  const { live, channel, start, on, tick } = setup();
  start();
  on({ kind: "tool-started", tool: "mcp__household__reply", summary: "Hello!", internal: true, turn: "t1", call: "c1" });
  live.finish("work", "sibling", "t1");
  await tick(10_000);
  start("t2");
  on({ kind: "tool-started", tool: "Bash", summary: "ls", action: { kind: "run", target: "ls" }, turn: "t2", call: "c2" });
  live.finish("work", "sibling", "t2"); // before its post went out
  await tick(10_000);
  expect(channel.statuses).toEqual([]);
});

test('stopped: "Stopped at action N" (true: that line shows); one queued behind it starts with its own first event; idle after all: its post goes', async () => {
  const { live, channel, start, tool, done, on, tick } = setup();
  start();
  tool("c1", "Reading a");
  done("c1");
  tool("c2", "Waiting a hundred seconds");
  start("t2"); // queued (typed while it works)
  await tick(0);
  const turn = live.turnOf("work", "sibling")!;
  expect(live.halt(turn)).toBe(true);
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: over Stopped at action 2");
  expect(live.turnOf("work", "sibling")).toBeUndefined();
  expect(live.halt(turn)).toBe(false); // over already
  on({ kind: "tool-started", tool: "Grep", summary: "x", action: { kind: "search", target: "x" }, turn: "t2", call: "g" });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe('post status-2 🤖 Sibling: working Searching for "x"… [Stop]');
  // A stop that found the agent idle (stopped in its terminal): the turn is just over, its post goes.
  live.ended(live.turnOf("work", "sibling")!);
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("drop status-2");
  // A turn that showed nothing yet: no line will show.
  start("t3");
  expect(live.halt(live.turnOf("work", "sibling")!)).toBe(false);
});

test('waiting: "Waiting for permission: <action>" (question: "Waiting for an answer", plan: "Waiting for approval"), each dialog on its own call', async () => {
  const { live, channel, start, tool, done, tick } = setup();
  const permission = (input: string): DialogQuestion => ({ kind: "permission", tool: "Bash", detail: "x", input });
  start();
  tool("c1", "Remove a", { input: "fa" });
  tool("c2", "Remove b", { input: "fb" }); // in parallel
  await tick(0);
  live.dialogOpened("work", "sibling", "permission", "fa");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Waiting for permission: Remove a [Stop]");
  live.dialogOpened("work", "sibling", "permission", "fb");
  live.dialogOpened("work", "sibling", "permission", "fb"); // the same one, told twice
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Waiting for permission: Remove b [Stop]");
  live.decided("work", "sibling", permission("fb"));
  live.dialogClosed("work", "sibling"); // one call ending closes no other's dialog
  done("c2");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Waiting for permission: Remove a [Stop]");
  done("c1");
  tool("c3", "Asks", { tool: "AskUserQuestion", action: { kind: "ask" }, input: "fq" });
  live.dialogOpened("work", "sibling", "question", "fq");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Waiting for an answer: Asking [Stop]");
  live.decided("work", "sibling", { kind: "questions", questions: [], input: "fq" });
  tool("c4", "Plans", { tool: "ExitPlanMode", action: { kind: "plan" }, input: "fp" });
  live.dialogOpened("work", "sibling", "plan", "fp");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Waiting for approval: Proposing a plan [Stop]");
  live.decided("work", "sibling", { kind: "plan", plan: "", input: "fp" });
  // A dialog about no call (seen only on screen): what it waits for alone; it goes with the next close.
  live.dialogOpened("work", "sibling", "unknown");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Waiting for an answer [Stop]");
  live.dialogClosed("work", "sibling");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Proposing a plan… [Stop]");
});

test(`the agent's own prompt continues the turn going on; a typed one waits behind it, and one that never finished is "Interrupted"; a failed one "Interrupted · error"`, async () => {
  const { live, channel, start, on, tick } = setup();
  const step = (turn: string, call: string, says: string) => on({ kind: "tool-started", tool: "Bash", summary: says, action: { kind: "run", says }, turn, call });
  start("a");
  step("a", "c1", "make");
  await tick(0);
  live.continued("work", "sibling", "a2"); // a background task's news
  step("a2", "c2", "reads the log");
  start("b"); // queued as soon as typed
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working reads the log… [Stop]");
  live.finish("work", "sibling", "a2");
  step("b", "c3", "read b");
  await tick(1_000);
  await tick(1_000);
  expect(channel.statuses).toContain("drop status-1");
  expect(channel.statuses).toContain("post status-2 🤖 Sibling: working read b… [Stop]");
  // No Stop for b (Escape in the terminal): c's first event says b is over.
  start("c");
  step("c", "c4", "grep");
  for (let i = 0; i < 4; i++) await tick(1_000);
  expect(channel.statuses).toContain("edit status-2: over Interrupted");
  live.lost("work", "sibling", "failed", "c");
  for (let i = 0; i < 3; i++) await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-3: over Interrupted · error");
});

test("failures: a 429 holds the chat as long as asked, others 3 s; a post that can never change is given up; a delete that fails is tried once more, then the post loses its button", async () => {
  const { live, channel, errors, start, tool, tick } = setup();
  start();
  tool("c1", "one");
  await tick(0);
  channel.statusFailures = [10_000, "no answer in time"];
  tool("c2", "two");
  await tick(1_000);
  expect(errors).toEqual(["bot work/sibling: live message not updated: rate limited for 10 s"]);
  await tick(9_000);
  expect(errors).toHaveLength(1); // held for the 10 s asked
  await tick(1_000);
  expect(errors).toHaveLength(2); // then a passing failure: 3 s more
  await tick(2_000);
  expect(channel.statuses).toHaveLength(1);
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working two… [Stop]");
  channel.statusFailures = ["gone: Bad Request: message to delete not found", "500 Internal Server Error"];
  live.finish("work", "sibling", "t1");
  await tick(1_000);
  await tick(3_000);
  expect(errors.slice(-2)).toEqual([
    "bot work/sibling: live message not removed: Bad Request: message to delete not found",
    "bot work/sibling: live message not removed: 500 Internal Server Error; left without its button",
  ]);
  expect(channel.statuses.at(-1)).toBe("edit status-1: over Done");
  // A working post that can never change again: given up, its turn goes on showing nothing.
  await tick(3_000); // the chat's wait after the failed delete
  start("t2");
  live.progress("work", "sibling", { kind: "tool-started", tool: "Bash", summary: "x", action: { kind: "run", says: "x" }, turn: "t2", call: "x" });
  await tick(1_000);
  channel.statusFailures = ["gone: Bad Request: message to edit not found"];
  live.progress("work", "sibling", { kind: "tool-started", tool: "Bash", summary: "y", action: { kind: "run", says: "y" }, turn: "t2", call: "y" });
  await tick(1_000);
  expect(errors.at(-1)).toBe("bot work/sibling: live message not updated: Bad Request: message to edit not found; given up");
  const shown = channel.statuses.length;
  live.progress("work", "sibling", { kind: "tool-started", tool: "Bash", summary: "z", action: { kind: "run", says: "z" }, turn: "t2", call: "z" });
  await tick(5_000);
  expect(channel.statuses).toHaveLength(shown);
  expect(live.halt(live.turnOf("work", "sibling")!)).toBe(false); // no line will show
});

test("one chat's posts go a gap apart, whatever pet they are of", async () => {
  const { live, channel, spot, tool, on, tick } = setup();
  live.start("work", "sibling", "t1", spot());
  live.start("work", "chair", "u1", spot({ place: { ...PLACE, id: "pet:chair@c", title: "🤖 Chair" } }));
  tool("c1", "one");
  on({ kind: "tool-started", tool: "Bash", summary: "two", action: { kind: "run", says: "two" }, turn: "u1", call: "d1" }, "chair");
  await tick(0);
  expect(channel.statuses).toEqual(["post status-1 🤖 Sibling: working one… [Stop]"]);
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("post status-2 🤖 Chair: working two… [Stop]");
});

test("reloads: a reopened channel ends the turn through the new one, a pet gone from its place ends it, a channel not open lets it go", async () => {
  const { live, channel, start, tool, on, tick } = setup();
  start();
  tool("c1", "one");
  await tick(0);
  const reopened = new FakeChannel();
  reopened.statusPrefix = "reopened";
  live.sync(() => here(reopened));
  await tick(1_000);
  expect(channel.statuses).toHaveLength(1); // never through the stopped one
  expect(reopened.statuses).toEqual(["edit status-1: over Interrupted"]);
  start("t2", "sibling", { channel: reopened, place: PLACE });
  on({ kind: "tool-started", tool: "Bash", summary: "two", action: { kind: "run", says: "two" }, turn: "t2", call: "c2" });
  await tick(1_000);
  live.sync(() => ({ channel: reopened, placed: false })); // the pet left the channel
  await tick(1_000);
  expect(reopened.statuses.at(-1)).toBe("edit reopened-1: over Interrupted");
  start("t3", "sibling", { channel: reopened, place: PLACE });
  on({ kind: "tool-started", tool: "Bash", summary: "three", action: { kind: "run", says: "three" }, turn: "t3", call: "c3" });
  await tick(1_000);
  live.sync(() => ({ placed: true })); // its channel cannot open now
  live.finish("work", "sibling", "t3");
  await tick(10_000);
  expect(reopened.statuses.at(-1)).toBe("post reopened-2 🤖 Sibling: working three… [Stop]"); // let go: left as it is
});

for (const end of ["finish", "halt", "lost", "stop", "reload"] as const) {
  test(`typing starts before tools, refreshes while thinking, and stops on ${end}`, async () => {
    const pulses: AbortSignal[] = [];
    const channel = Object.assign(new FakeChannel(), { typing: async (_place: Place, signal: AbortSignal) => { pulses.push(signal); } });
    const { live, start, tick } = setup(channel);
    start();
    await tick(0);
    expect(pulses).toHaveLength(1);
    await tick(4_000);
    expect(pulses).toHaveLength(2);
    if (end === "finish") live.finish("work", "sibling");
    if (end === "halt") live.halt(live.turnOf("work", "sibling")!);
    if (end === "lost") live.lost("work", "sibling", "failed");
    if (end === "stop") live.stop();
    if (end === "reload") live.sync(() => ({ placed: false }));
    expect(pulses[0]!.aborted).toBe(true);
    await tick(20_000);
    expect(pulses).toHaveLength(2);
  });
}

test("queued turns start typing only when promoted; CLI turns never type", async () => {
  const pulses: AbortSignal[] = [];
  const channel = Object.assign(new FakeChannel(), { typing: async (_place: Place, signal: AbortSignal) => { pulses.push(signal); } });
  const { live, start, tick } = setup(channel);
  live.start("work", "cli", "cli", undefined);
  start("t1");
  start("t2");
  await tick(0);
  expect(pulses).toHaveLength(1);
  live.finish("work", "sibling", "t1");
  expect(pulses[0]!.aborted).toBe(true);
  expect(pulses).toHaveLength(2);
  live.stop();
});

test("typing respects rate limits and an in-flight request cannot restart after finish", async () => {
  const { RateLimited } = await import("../../src/core/channel");
  let calls = 0;
  let release!: () => void;
  const channel = Object.assign(new FakeChannel(), { typing: async () => {
    calls++;
    if (calls === 1) throw new RateLimited(10_000);
    await new Promise<void>((resolve) => { release = resolve; });
  } });
  const { live, start, tick } = setup(channel);
  start();
  await tick(0);
  await tick(9_999);
  expect(calls).toBe(1);
  await tick(1);
  expect(calls).toBe(2);
  live.finish("work", "sibling");
  release();
  await tick(0);
  await tick(20_000);
  expect(calls).toBe(2);
});

test("native review edits the original command status through pending, approved and completion; repeated and late starts do not spam", async () => {
  const { live, channel, start, tool, done, on, tick } = setup();
  start();
  tool("command", "Run build");
  await tick(0);
  const review = { kind: "tool-review", review: "r1", call: "command", turn: "t1" } as const;
  on({ ...review, status: "inProgress" });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Run build…\n\nReview: in progress ⏳ [Stop]");
  on({ ...review, status: "approved" });
  done("command");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-1: working Run build…\n\nReview: approved ✅ [Stop]");
  const length = channel.statuses.length;
  on({ ...review, status: "approved" });
  on({ ...review, status: "inProgress" });
  await tick(1_000);
  expect(channel.statuses).toHaveLength(length);
  expect(channel.calls).toEqual([]);
  expect(live.turnOf("work", "sibling")?.count).toBe(1);
  live.finish("work", "sibling", "t1");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("drop status-1");
});

test("review preceding a command is buffered by exact id; missing and stale targets never approve another command", async () => {
  const { channel, start, tool, on, tick } = setup();
  start();
  on({ kind: "tool-review", review: "early", call: "command", turn: "t1", status: "approved" });
  await tick(0);
  expect(channel.statuses).toEqual([]);
  tool("other", "Unrelated action");
  on({ kind: "tool-review", review: "missing", turn: "t1", status: "approved" });
  on({ kind: "tool-review", review: "stale", call: "other", turn: "old-turn", status: "approved" });
  await tick(0);
  expect(channel.statuses.at(-1)).toBe("post status-1 🤖 Sibling: working Unrelated action… [Stop]");
  tool("command", "Reviewed action");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toContain("Reviewed action…\n\nReview: approved ✅");
  expect(channel.statuses.filter(line => line.startsWith("post"))).toHaveLength(1);
  expect(channel.calls).toEqual([]);
});

test("several reviews of one command cannot hide a denial; unmatched rejection stays explicitly scoped inline", async () => {
  const { channel, start, tool, on, tick } = setup();
  start();
  tool("command", "Run script");
  on({ kind: "tool-review", review: "exec1", call: "command", turn: "t1", status: "denied" });
  on({ kind: "tool-review", review: "exec2", call: "command", turn: "t1", status: "approved" });
  await tick(0);
  expect(channel.statuses.at(-1)).toContain("Run script…\n\nReview: denied ⛔");
  expect(channel.statuses.at(-1)).not.toContain("approved");
  tool("unrelated", "Read docs");
  on({ kind: "tool-review", review: "network", turn: "t1", status: "timedOut", scope: "network access" });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toContain("Read docs…\n\nReview (action): denied ⛔");
  expect(channel.statuses.at(-1)).toContain("Review (network access): no answer ⚠️");
  expect(channel.calls).toEqual([]);
});

test("late review completion can annotate a finished last command, while another pending exec review prevents an approval badge", async () => {
  const { channel, start, tool, done, on, tick } = setup();
  start();
  tool("command", "Execute command");
  await tick(0);
  done("command");
  on({ kind: "tool-review", review: "exec1", call: "command", turn: "t1", status: "approved" });
  on({ kind: "tool-review", review: "exec2", call: "command", turn: "t1", status: "inProgress" });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toContain("Review: in progress");
  expect(channel.statuses.at(-1)).not.toContain("approved");
  on({ kind: "tool-review", review: "exec2", call: "command", turn: "t1", status: "approved" });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toContain("Review: approved ✅");
  on({ kind: "tool-review", review: "stdin", call: "command", turn: "t1", status: "approved", scope: "terminal input" });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toContain("Review (terminal input): approved");
  expect(channel.calls).toEqual([]);
});


test("outward messages retire a segment, preserve typing, waits and total Stop count, and ignore late old events", async () => {
  const signals: AbortSignal[] = [];
  const channel = Object.assign(new FakeChannel(), { typing: async (_place: Place, signal: AbortSignal) => { signals.push(signal); } });
  const { live, start, spot, tool, done, on, tick } = setup(channel);
  start();
  tool("old", "Old command", { input: "permission" });
  live.dialogOpened("work", "sibling", "permission", "permission");
  on({ kind: "tool-review", review: "unscoped", status: "inProgress", turn: "t1" });
  await tick(0);
  const turn = live.turnOf("work", "sibling")!;
  live.replied(turn, spot());
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("drop status-1");
  expect(live.turnOf("work", "sibling")).toBe(turn);
  expect(signals[0]!.aborted).toBe(false);
  expect(turn.waits).toHaveLength(1);
  done("old");
  on({ kind: "tool-review", review: "late", call: "old", status: "denied", turn: "t1" });
  on({ kind: "tool-review", review: "unscoped", status: "denied", turn: "t1" });
  await tick(4_000);
  expect(channel.statuses).toHaveLength(2);
  tool("old", "Late duplicate old command");
  tool("new", "New command");
  await tick(0);
  expect(channel.statuses.at(-1)).toBe("post status-2 🤖 Sibling: working New command… [Stop]");
  expect(live.owns("status-1" as PostRef)).toBeUndefined();
  expect(live.owns("status-2" as PostRef)).toBe(turn);
  live.halt(turn);
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("edit status-2: over Stopped at action 2");
});

test("a reply during initial status posting serializes retirement before the next post, including a rate limit", async () => {
  const channel = new FakeChannel();
  const original = channel.postStatus.bind(channel);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  channel.postStatus = async (place, view) => { await hold; return original(place, view); };
  const { live, start, spot, tool, on, tick } = setup(channel);
  start();
  tool("old", "First");
  await tick(0);
  const turn = live.turnOf("work", "sibling")!;
  live.replied(turn, spot());
  tool("new", "Second");
  on({ kind: "tool-review", review: "new-review", call: "new", status: "approved", turn: "t1" });
  release();
  await tick(0);
  channel.statusFailures = [2_000];
  await tick(1_000);
  expect(channel.statuses).toHaveLength(1);
  await tick(2_000);
  expect(channel.statuses.at(-1)).toBe("drop status-1");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toContain("post status-2 🤖 Sibling: working Second…\n\nReview: approved");
});

test("different places, channels, and an old captured turn cannot rotate the active status", async () => {
  const { live, channel, start, spot, tool, tick } = setup();
  start();
  tool("old", "First");
  await tick(0);
  const turn = live.turnOf("work", "sibling")!;
  live.replied(turn, spot({ channel: new FakeChannel() }));
  live.replied(turn, spot({ place: { ...PLACE, id: "other" } }));
  await tick(1_000);
  expect(channel.statuses).toHaveLength(1);
  live.finish("work", "sibling");
  start("t2");
  tool("new", "New turn", { turn: "t2" });
  live.replied(turn, spot());
  await tick(1_000);
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("post status-2 🤖 Sibling: working New turn… [Stop]");
});


test("a new unscoped negative review after an outward message stays visible as a generic decision", async () => {
  const { live, channel, start, spot, tool, on, tick } = setup();
  start();
  tool("old", "Old command");
  await tick(0);
  live.replied(live.turnOf("work", "sibling"), spot());
  await tick(1_000);
  on({ kind: "tool-review", review: "new-denial", status: "denied", scope: "network access", turn: "t1" });
  await tick(1_000);
  expect(channel.statuses.at(-1)).toBe("post status-2 🤖 Sibling: working Review (network access): denied ⛔ [Stop]");
  tool("new", "Next command");
  await tick(1_000);
  expect(channel.statuses.at(-1)).toContain("Next command…\n\nReview (network access): denied");
});

for (const ending of ["finish", "halt"] as const) {
  test(`an outward message during an edit still retires that post when ${ending} races with it`, async () => {
    const { live, channel, start, spot, tool, tick } = setup();
    start();
    tool("one", "First");
    await tick(0);
    const hold = Promise.withResolvers<void>();
    channel.editHold = hold.promise;
    tool("two", "Second");
    await tick(1_000);
    const turn = live.turnOf("work", "sibling")!;
    live.replied(turn, spot());
    if (ending === "finish") live.finish("work", "sibling");
    else expect(live.halt(turn)).toBe(false); // retiring post cannot retain the stopped line
    hold.resolve();
    await tick(0);
    await tick(1_000);
    expect(channel.statuses.at(-1)).toBe("drop status-1");
    expect(channel.statuses.filter(line => line.startsWith("post"))).toHaveLength(1);
    expect(live.turnOf("work", "sibling")).toBeUndefined();
    expect(live.owns("status-1" as PostRef)).toBeUndefined();
  });
}
