import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentAdapter, SendResult } from "../../src/core/agent";
import type { AgentEvent } from "../../src/core/agent-events";
import type { MessageRef } from "../../src/core/channel";
import type { Header } from "../../src/core/header";
import type { Message } from "../../src/core/message";
import type { DialogAnswer, DialogQuestion } from "../../src/core/dialog";
import { Delivery, type AskPerson, type DeliveryUpdate } from "../../src/app/delivery";
import type { AttachmentFetcher } from "../../src/app/attachments";
import type { Attachment, FileRef } from "../../src/core/attachment";
import { EventLog } from "../../src/infra/event-log";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { fakeClock, tempDir, waitFor } from "../helpers";

const dialog: AgentEvent = { kind: "dialog-opened", dialog: "question", summary: "?" };

/** The header of a new message from the person (Household's id `m<n>`), as Chat makes it. */
const fromChat = (n: number, relayed = false): Header => ({
  event: { kind: "message", id: `m${n}`, ...(relayed ? { relayed: true as const } : {}) },
  from: { id: "p1", name: "Oleg", trust: "owner" },
  channel: { id: "c1", kind: "telegram-private", name: "Telegram Bot DM (threaded)", audience: "private", meta: { username: "oleg" } },
});

/** The ids of the messages a prompt carries (a batch's, in order, or the one message's): from their headers. */
function idsIn(prompt: string): string[] {
  const lines = prompt.split("\n");
  const headers = lines.flatMap((line, i) => (line === "<household-header>" ? [JSON.parse(lines[i + 1]!).event] : []));
  return headers.map((event) => event.id ?? event.kind);
}

/** The bodies of the messages a prompt carries, in order: what is between their content tags. */
const contentsIn = (prompt: string) => [...prompt.matchAll(/<household-content>\n([^]*?)\n<\/household-content>/g)].map((match) => match[1]);

/**
 * An agent whose payloads are already events, or `{ waits }` for a dialog that waits for its answer (the
 * person's is `answer()`); `send` and `dialogVisible` answer from the given lists.
 */
function setup(
  options: {
    memory?: () => {revision: number | string; text: string};
    sanitizeEvent?: (house: string, pet: string, event: AgentEvent) => AgentEvent;
    sends?: (SendResult | Promise<SendResult>)[];
    visible?: () => Promise<boolean>;
    idle?: () => Promise<boolean>;
    eventsPerSecond?: number;
    store?: SqliteStore;
    answer?: (signal?: AbortSignal) => Promise<DialogAnswer | undefined> | DialogAnswer | undefined;
    attachments?: Pick<AttachmentFetcher, "fetch">;
  } = {},
) {
  const sends = [...(options.sends ?? [])];
  const interrupts: string[] = [];
  const sent: { text: string; at: number; canSubmit: () => boolean }[] = [];
  const agent: AgentAdapter = {
    name: "fake",
    imageContext: "/",
    home: "/",
    env: () => ({}),
    models: ["m"],
    defaultModel: "m",
    providers: ["anthropic"],
    useKey: () => ({ kind: "test", env: {}, wire: [] }),
    credentialHeaders: [],
    isReady: async () => ({ ready: true }),
    isIdle: options.idle ?? (async () => true),
    translate: (payload) => ("waits" in (payload as object) ? [dialog] : [payload as AgentEvent]),
    dialogs: {
      ask: (payload) => (payload as { waits?: DialogQuestion }).waits,
      answer: (_, answer) => ({ answered: answer }),
    },
    async send(_, text, canSubmit) {
      sent.push({ text, at: Date.now(), canSubmit });
      return (await sends.shift()) ?? { status: "sent" };
    },
    dialogVisible: options.visible ?? (async () => false),
    async interrupt() {
      interrupts.push("Escape");
      return { status: "stopped" };
    },
  };
  const lines: string[] = [];
  const log = new EventLog(join(tempDir(), "events.jsonl"), (line) => lines.push(line));
  const timing = { retryMs: 10, watchMs: 10, eventsPerSecond: options.eventsPerSecond ?? 100, reportMs: 50, batchMs: 1_200, batchMax: 25 };
  const store = options.store ?? new SqliteStore(":memory:");
  const updates: DeliveryUpdate[] = [];
  const asked: DialogQuestion[] = [];
  const ask: AskPerson = async (_house, _pet, dialog, signal) => {
    asked.push(dialog);
    return options.answer?.(signal);
  };
  const clock = fakeClock();
  const delivery = new Delivery(log, () => async () => ({ ok: true, output: "" }), store, (update) => updates.push(update), ask, timing, clock, undefined, options.memory, options.attachments, options.sanitizeEvent);
  const pet = { house: "work", pet: "sibling", agent, model: "m", key: "k", keyUse: { kind: "test", env: {}, wire: [] } };
  delivery.setPets([pet]);
  const post = (event: AgentEvent) => delivery.onPayload("work", "sibling", event);
  const has = (text: string) => lines.filter((line) => line.includes(text)).length;
  const send = (text: string, ref?: string) =>
    delivery.send("work", "sibling", { text, origin: ref ? "chat" : "cli", ref: ref as MessageRef | undefined });
  /** The person edits message `of`; this version of it is `ref`. */
  const edit = (of: string, ref: string, text: string) =>
    delivery.send("work", "sibling", { text, origin: "chat", ref: ref as MessageRef, edits: of as MessageRef });
  const statuses = () => store.unfinished("work", "sibling").map((m) => `${m.text}:${m.status}`);
  /** The person writes message `n` (ref `r<n>`) in `place`; it may go in a batch. */
  const say = (n: number, place = "c1", relayed = false) =>
    delivery.send("work", "sibling", { text: `text ${n}`, origin: "chat", ref: `r${n}` as MessageRef, header: fromChat(n, relayed), place });
  /** What each send carried, by Household's ids. */
  const prompts = () => sent.map(({ text }) => idsIn(text));
  return { delivery, pet, sent, lines, post, has, send, edit, store, updates, statuses, asked, clock, say, prompts, interrupts };
}

test("automatic review decisions remain inline progress after ordinary events exhaust the budget and never become notices", async () => {
  const { delivery, post, updates } = setup({ eventsPerSecond: 1 });
  try {
    for (let i = 0; i < 12; i++) await post({ kind: "notification", text: "internal diagnostic" });
    for (const status of ["inProgress", "approved", "denied"] as const) {
      await post({ kind: "tool-review", review: `review-${status}`, call: "command", turn: "turn1", status });
    }
    expect(updates.filter(update => update.kind === "notification")).toEqual([]);
    expect(updates.filter(update => update.kind === "progress")).toHaveLength(3);
  } finally { delivery.stop(); }
});

test("a retained pet uses its reloaded adapter and keeps its queued and delivered messages", async () => {
  const { delivery, pet, sent, send, say, statuses, clock, post } = setup();
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    ...pet.agent,
    name: "replacement",
    translate(payload) {
      calls.push("translate");
      return [payload as AgentEvent];
    },
    async send(_, text) {
      calls.push(`send:${contentsIn(text).join(",")}`);
      return { status: "sent" };
    },
    async dialogVisible() {
      calls.push("screen");
      return false;
    },
    async interrupt() {
      calls.push("interrupt");
      return { status: "stopped" };
    },
  };
  try {
    send("already delivered");
    await waitFor(() => statuses().includes("already delivered:delivered"));
    say(1); // A chat batch is still waiting for its quiet window.
    delivery.setPets([{ ...pet, agent: adapter }]);
    expect(statuses()).toEqual(["already delivered:delivered", "text 1:received"]);
    delivery.answered("work", "sibling");
    expect(statuses()).toEqual(["text 1:received"]);
    clock.tick(1_200);
    await waitFor(() => statuses().includes("text 1:delivered"));
    expect(sent.length).toBe(1); // Only the first message used the old adapter.
    await delivery.adopt([{ ...pet, agent: adapter }]);
    await post({ kind: "prompt-accepted", text: "next turn" });
    expect(await delivery.interrupt("work", "sibling", async () => false)).toEqual({ status: "stopped" });
    expect(calls).toEqual(["send:text 1", "screen", "translate", "interrupt"]);
  } finally {
    delivery.stop();
  }
});

test("the model a session says it runs is in the log line of its start", async () => {
  const { delivery, post, has } = setup();
  try {
    await post({ kind: "session-started", model: "claude-sonnet-5-5" });
    expect(has("session started (claude-sonnet-5-5)")).toBe(1);
  } finally {
    delivery.stop();
  }
});

test("a refused message is retried with growing waits, and the reason is logged once", async () => {
  const refused = { status: "refused", reason: "the input box is not empty" } as const;
  const { delivery, sent, has, send } = setup({ sends: [refused, refused, refused, refused] });
  try {
    send("hi");
    await waitFor(() => has("message delivered") === 1);
    expect(sent.map((attempt) => attempt.text)).toEqual(["hi", "hi", "hi", "hi", "hi"]);
    const waits = sent.slice(1).map((attempt, i) => attempt.at - sent[i]!.at);
    expect(waits[3]!).toBeGreaterThan(waits[0]! * 3); // 10, 20, 40, 80 ms
    expect(has("message kept in queue (the input box is not empty)")).toBe(1);
  } finally {
    delivery.stop();
  }
});

test("a message that may sit typed in the input is never typed again; the next one goes on", async () => {
  const { delivery, sent, has, send } = setup({ sends: [{ status: "stuck", reason: "no Enter" }] });
  try {
    send("one");
    send("two");
    await waitFor(() => has("message delivered") === 1);
    await Bun.sleep(50);
    expect(sent.map((attempt) => attempt.text)).toEqual(["one", "two"]);
    expect(has("ERROR bot work/sibling: message typed but not submitted (no Enter)")).toBe(1);
  } finally {
    delivery.stop();
  }
});

test("the agent is told not to submit once a dialog opens during the send", async () => {
  const { delivery, sent, post, send } = setup();
  try {
    send("hi");
    await waitFor(() => sent.length === 1);
    expect(sent[0]!.canSubmit()).toBe(true);
    await post(dialog);
    expect(sent[0]!.canSubmit()).toBe(false);
  } finally {
    delivery.stop();
  }
});

test("a dialog dismissed without a word from the agent is closed once the screen shows none", async () => {
  const answers = [true, true, false];
  const { delivery, sent, post, has, send } = setup({ visible: async () => answers.shift() ?? false });
  try {
    await post({ kind: "prompt-accepted", text: "x" });
    await post(dialog);
    send("after");
    await Bun.sleep(5);
    expect(sent).toEqual([]);
    await waitFor(() => sent.length === 1);
    expect(answers).toEqual([]);
    expect(has("dialog closed")).toBe(1);
  } finally {
    delivery.stop();
  }
});

test("a screen look that started before a new dialog opened cannot close it", async () => {
  let answer = (_: boolean) => {};
  const { delivery, post, has } = setup({ visible: () => new Promise((resolve) => (answer = resolve)) });
  try {
    await post(dialog);
    await Bun.sleep(30); // the look is under way
    await post({ kind: "dialog-closed" });
    await post({ ...dialog, summary: "second" });
    answer(false);
    await Bun.sleep(5);
    expect(has("dialog closed")).toBe(1); // only the explicit one
    expect(has("dialog open (question): second")).toBe(1);
  } finally {
    delivery.stop();
  }
});

test("a pet adopted with a dialog on screen holds its messages", async () => {
  const { delivery, pet, sent, has, send } = setup({ visible: async () => true });
  try {
    await delivery.adopt([pet]);
    expect(has("dialog open (unknown): already on screen")).toBe(1);
    send("x");
    await Bun.sleep(30);
    expect(sent).toEqual([]);
  } finally {
    delivery.stop();
  }
});

test("events over the pet's rate are dropped and counted in one line", async () => {
  const { delivery, lines, post, has } = setup({ eventsPerSecond: 1 }); // a burst of 10
  try {
    for (let i = 0; i < 30; i++) await post({ kind: "notification", text: `n${i}` });
    expect(has("notification: n")).toBe(10);
    await waitFor(() => has("dropped") === 1);
    expect(lines.at(-1)).toContain("ERROR bot work/sibling: dropped 20 events over 1/s");
  } finally {
    delivery.stop();
  }
});

test("over the rate progress goes; turns' starts and ends never", async () => {
  const { delivery, post, updates } = setup({ eventsPerSecond: 1 }); // a burst of 10
  try {
    for (let i = 0; i < 14; i++) await post({ kind: "tool-started", tool: "Bash", summary: `s${i}` });
    const steps = () => updates.filter((update) => update.kind === "progress" && update.event.kind === "tool-started").length;
    expect(steps()).toBe(10);
    await post({ kind: "turn-finished", text: "done", turn: "t1" });
    await post({ kind: "prompt-accepted", text: "next", turn: "t2" });
    expect(updates.slice(-2).map((update) => update.kind)).toEqual(["turn-finished", "turn-started"]);
  } finally {
    delivery.stop();
  }
});

test("statuses: received → delivered → answered at the end of the turn; a stuck message fails", async () => {
  const { delivery, send, post, store, updates, statuses } = setup({ sends: [{ status: "sent" }, { status: "stuck", reason: "no Enter" }] });
  try {
    send("one", "m1");
    send("two");
    await waitFor(() => updates.length === 2);
    expect(updates.map((u) => u.kind)).toEqual(["delivered", "failed"]);
    expect(updates[1]).toMatchObject({ why: "stuck", messages: [{ text: "two", status: "failed" }] });
    expect(statuses()).toEqual(["one:delivered"]);
    await post({ kind: "turn-finished", text: "done" });
    expect(statuses()).toEqual([]);
    expect(store.byRef("work", "m1" as MessageRef)).toMatchObject({ pet: "sibling", status: "answered" });
    expect(updates.at(-1)).toEqual({ kind: "turn-finished", house: "work", pet: "sibling" });
  } finally {
    delivery.stop();
  }
});

test("a reply marks what the pet was given as answered", async () => {
  const { delivery, send, updates, statuses } = setup();
  try {
    send("one");
    await waitFor(() => updates.length === 1);
    delivery.answered("work", "sibling");
    expect(statuses()).toEqual([]);
  } finally {
    delivery.stop();
  }
});

test("after a restart, queued messages are delivered; those already with the pet fail as interrupted", async () => {
  const store = new SqliteStore(":memory:");
  const busy = { status: "refused", reason: "busy" } as const;
  const first = setup({ store, sends: [{ status: "sent" }, busy, busy, busy, busy, busy] });
  first.send("given");
  first.send("queued");
  await waitFor(() => first.updates.length === 1);
  first.delivery.stop();
  expect(first.statuses()).toEqual(["given:delivered", "queued:received"]);

  const second = setup({ store });
  try {
    await waitFor(() => second.sent.length === 1);
    expect(second.sent[0]!.text).toBe("queued");
    expect(second.updates[0]).toMatchObject({ kind: "failed", why: "interrupted", messages: [{ text: "given" }] });
    await waitFor(() => second.updates.length === 2);
    expect(second.statuses()).toEqual(["queued:delivered"]);
  } finally {
    second.delivery.stop();
  }
});

test("a message the channel replays (same ref) is taken once", async () => {
  const { delivery, send, sent } = setup();
  try {
    send("hi", "m1");
    send("hi", "m1");
    await Bun.sleep(30);
    expect(sent.map((attempt) => attempt.text)).toEqual(["hi"]);
  } finally {
    delivery.stop();
  }
});

test("an edit goes to the pet Chat names, never to the one that got the original: that one's queued copy stays as it was", async () => {
  const { delivery, send, store, statuses, post } = setup();
  try {
    await post({ kind: "dialog-opened", dialog: "question", summary: "?" }); // nothing goes out
    send("helo", "m1"); // queued for sibling
    // Chair is no pet this Delivery runs: the edit is for chair all the same, not moved to sibling.
    expect(() => delivery.send("work", "chair", { text: "hello", origin: "chat", ref: "m1.1" as MessageRef, edits: "m1" as MessageRef })).toThrow("unknown bot work/chair");
    expect(statuses()).toEqual(["helo:received"]);
    expect(store.unfinished("work", "chair")).toEqual([]);
  } finally {
    delivery.stop();
  }
});

test("an edit replaces a queued message; once delivered, it goes again as a message of its own (and only once)", async () => {
  const { delivery, send, edit, sent, post, statuses } = setup();
  try {
    await post({ kind: "dialog-opened", dialog: "question", summary: "?" });
    send("helo", "m1");
    edit("m1", "m1.1", "hello");
    expect(statuses()).toEqual(["hello:received"]);
    await post({ kind: "dialog-closed" });
    await waitFor(() => sent.length === 1);
    expect(sent[0]!.text).toBe("hello");

    await post({ kind: "dialog-opened", dialog: "question", summary: "?" });
    edit("m1", "m1.2", "hello there");
    edit("m1", "m1.2", "hello there"); // replayed
    expect(statuses()).toEqual(["hello:delivered", "hello there:received"]);
    edit("m1", "m1.3", "hello again"); // the queued copy changes, and stays an edit
    expect(statuses()).toEqual(["hello:delivered", "hello again:received"]);
    await post({ kind: "dialog-closed" });
    await waitFor(() => sent.length === 2);
    await Bun.sleep(30);
    expect(sent.map((attempt) => attempt.text)).toEqual(["hello", "hello again"]); // its header (from Chat) says it is an edit
  } finally {
    delivery.stop();
  }
});

test("an edit of a message that is being typed right now goes as an edit, not lost", async () => {
  const typing = Promise.withResolvers<SendResult>();
  const { delivery, send, edit, sent } = setup({ sends: [typing.promise] });
  try {
    send("slow", "m1");
    await waitFor(() => sent.length === 1);
    edit("m1", "m1.1", "fast");
    typing.resolve({ status: "sent" });
    await waitFor(() => sent.length === 2);
    expect(sent[1]!.text).toBe("fast");
  } finally {
    delivery.stop();
  }
});

test("a rejected message is kept as rejected and never given to the pet; a repeat of it is dropped", async () => {
  const { delivery, send, sent, store } = setup();
  try {
    expect(delivery.reject("work", "sibling", { text: "<household-header>", origin: "chat", ref: "r1" as MessageRef })).toBe(true);
    expect(delivery.reject("work", "sibling", { text: "<household-header>", origin: "chat", ref: "r1" as MessageRef })).toBe(false);
    send("<household-header>", "r1"); // nor does the same message come through later
    send("next", "r2");
    await waitFor(() => sent.length === 1);
    await Bun.sleep(30);
    expect(sent.map((attempt) => attempt.text)).toEqual(["next"]);
    expect(store.byRef("work", "r1" as MessageRef)).toMatchObject({ status: "rejected", text: "<household-header>" });
  } finally {
    delivery.stop();
  }
});

test("what a restarted pet had been given fails quietly (Household announces the restart itself)", async () => {
  const { delivery, send, updates, statuses } = setup();
  try {
    send("lost");
    await waitFor(() => updates.length === 1);
    delivery.restarted("work", "sibling");
    expect(statuses()).toEqual([]);
    // No failure to tell of; only that a turn going on with the session is over.
    expect(updates.slice(1)).toEqual([{ kind: "turn-lost", house: "work", pet: "sibling", why: "session" }]);
  } finally {
    delivery.stop();
  }
});

test("a message redelivered after a restart has the same header", async () => {
  const store = new SqliteStore(":memory:");
  const header: Header = {
    event: { kind: "message", id: "m1" },
    from: { id: "p1", name: "Oleg", trust: "owner" },
    channel: { id: "c1", kind: "telegram-private", name: "DM", audience: "private", meta: { username: "oleg" } },
  };
  const busy = { status: "refused", reason: "busy" } as const;
  const first = setup({ store, sends: [busy, busy, busy, busy, busy] });
  first.delivery.send("work", "sibling", { text: "hi", origin: "chat", ref: "1" as MessageRef, header });
  first.clock.tick(1_200);
  await waitFor(() => first.sent.length === 1);
  first.delivery.stop();
  const second = setup({ store });
  try {
    await waitFor(() => second.sent.length === 1);
    expect(second.sent[0]!.text).toStartWith('<household-message id="m1">\n<household-header>\n{"event":{"kind":"message","id":"m1"},"from":{"id":"p1"');
    expect(second.sent[0]!.text).toEndWith('"meta":{"username":"oleg"}}}\n</household-header>\n<household-content>\nhi\n</household-content>\n</household-message>');
    expect(second.sent[0]!.text).toBe(first.sent[0]!.text);
  } finally {
    second.delivery.stop();
  }
});

const question: DialogQuestion = { kind: "questions", questions: [{ text: "Red or green?", options: [{ label: "Red" }, { label: "Green" }], multiSelect: false }] };

test("a dialog waits for the person's answer, which goes back in the agent's terms; the dialog is then closed", async () => {
  const answered = Promise.withResolvers<DialogAnswer>();
  const { delivery, sent, send, asked, has } = setup({ answer: () => answered.promise, visible: async () => true });
  try {
    const reply = delivery.onPayload("work", "sibling", { waits: question });
    send("queued meanwhile");
    await Bun.sleep(20);
    expect(asked).toEqual([question]);
    expect(sent).toEqual([]); // the pet is in a dialog
    answered.resolve({ kind: "answers", answers: [{ chosen: ["Green"] }] });
    expect(await reply).toEqual({ answered: { kind: "answers", answers: [{ chosen: ["Green"] }] } });
    expect(has("dialog closed")).toBe(1);
    await waitFor(() => sent.length === 1);
  } finally {
    delivery.stop();
  }
});

test("a dialog left to the agent's session gets no decision; over the event rate it is still asked", async () => {
  const { delivery, asked } = setup({ eventsPerSecond: 0.1, answer: () => undefined }); // a burst of 1
  try {
    expect(await delivery.onPayload("work", "sibling", { waits: question })).toEqual({});
    expect(await delivery.onPayload("work", "sibling", { waits: question })).toEqual({}); // over the rate
    expect(asked).toHaveLength(2);
    expect(await delivery.onPayload("ghost", "pet", { waits: question })).toEqual({});
  } finally {
    delivery.stop();
  }
});

test("a dialog that closes some other way (answered in the agent's session) stops its wait only; so does the agent's abort", async () => {
  const waits: PromiseWithResolvers<DialogAnswer | undefined>[] = [];
  const waiting = (signal?: AbortSignal) => {
    waits.push(Promise.withResolvers());
    signal!.addEventListener("abort", () => waits.at(-1)!.resolve(undefined));
    return waits.at(-1)!.promise;
  };
  const { delivery, post, has } = setup({ answer: waiting, visible: async () => true });
  try {
    const first = delivery.onPayload("work", "sibling", { waits: question });
    const second = delivery.onPayload("work", "sibling", { waits: question });
    await Bun.sleep(5);
    await post({ kind: "dialog-closed" }); // e.g. the tool finished: the terminal's answer won
    expect(await second).toEqual({}); // the newest one closed
    await post({ kind: "dialog-opened", dialog: "question", summary: "first, still on screen" });
    waits[0]!.resolve({ kind: "approve" });
    expect(await first).toEqual({ answered: { kind: "approve" } });
    expect(has("dialog closed")).toBe(2); // the agent's close, then Household's own once none waits

    const aborted = new AbortController();
    const dropped = delivery.onPayload("work", "sibling", { waits: question }, aborted.signal);
    aborted.abort();
    expect(await dropped).toEqual({});
  } finally {
    delivery.stop();
  }
});

// Batches: new messages the person sends in a row go as one prompt.

test("messages in a row go as one batch once their place has been quiet for the window; one alone keeps its own shape", async () => {
  const { delivery, sent, say, clock, prompts, updates, statuses } = setup();
  try {
    say(1);
    clock.tick(1_000);
    say(2);
    clock.tick(1_199); // 1.2 s after the last one, not after the first
    await Bun.sleep(30);
    expect(sent).toHaveLength(0);
    clock.tick(1);
    await waitFor(() => sent.length === 1);
    expect(prompts()).toEqual([["m1", "m2"]]);
    expect(sent[0]!.text).toStartWith('<household-batch count="2">\n<household-message id="m1">\n');
    expect(sent[0]!.text).toEndWith("<household-content>\ntext 2\n</household-content>\n</household-message>\n</household-batch>");
    await waitFor(() => updates.length === 1);
    expect(updates[0]).toMatchObject({ kind: "delivered", messages: [{ text: "text 1" }, { text: "text 2" }] });
    expect(statuses()).toEqual(["text 1:delivered", "text 2:delivered"]);

    say(3);
    clock.tick(1_200);
    await waitFor(() => sent.length === 2);
    expect(sent[1]!.text).toStartWith('<household-message id="m3">\n<household-header>\n{"event":{"kind":"message","id":"m3"}');
    expect(sent[1]!.text).toEndWith("</household-header>\n<household-content>\ntext 3\n</household-content>\n</household-message>");
  } finally {
    delivery.stop();
  }
});

test("sideworker attachment paths use its own home and follow placement updates", async () => {
  const homes: string[] = [];
  const attachments = { fetch: async (_house: string, _pet: string, home: string, message: Message) => {
    homes.push(home);
    return message.attachments!.map(file => ({ ...file, path: `${home}/.household/inbox/photo.jpg` }));
  } };
  const { delivery, pet } = setup({ attachments });
  try {
    delivery.setPets([{ ...pet, sideworker: { parent: "owl", cwd: "/home/agent/work" } }]);
    const sendPhoto = () => delivery.send("work", "sibling", { text: "", origin: "chat", attachments: [{ kind: "photo", file: "photo" as FileRef }] });
    sendPhoto();
    expect(homes).toEqual(["/home/worker"]);
    delivery.setPets([pet]);
    sendPhoto();
    expect(homes).toEqual(["/home/worker", "/"]);
  } finally { delivery.stop(); }
});

test("an album goes as one batch, once its files are fetched: a slow file holds its messages, never the channel; a failed one is told", async () => {
  const fetches = new Map<number, (attachments: Attachment[]) => void>();
  const attachments = { fetch: (_house: string, _pet: string, home: string, message: Message) => new Promise<Attachment[]>((resolve) => {
    fetches.set(message.id, (done) => resolve(done));
    expect(home).toBe("/");
  }) };
  const { delivery, sent, clock, prompts, store, statuses } = setup({ attachments });
  try {
    const photo = (n: number): Attachment => ({ kind: "photo", file: `f${n}` as FileRef, mime: "image/jpeg" });
    const album = (n: number) =>
      delivery.send("work", "sibling", { text: n === 1 ? "vacation" : "", origin: "chat", ref: `r${n}` as MessageRef, header: fromChat(n), place: "c1", attachments: [photo(n)] });
    // Each queued at once (the channel's poller goes on), each fetch started as it came.
    for (const n of [1, 2, 3]) expect(album(n)).toEqual({ activity: "idle", queued: n });
    expect([...fetches.keys()]).toEqual([1, 2, 3]);
    clock.tick(1_200);
    await Bun.sleep(30);
    expect(sent).toHaveLength(0); // quiet, but the files are not there yet
    fetches.get(1)!([{ ...photo(1), path: "/.household/inbox/2026-11-06/m1-photo.jpg" }]);
    fetches.get(3)!([{ ...photo(3), path: "/.household/inbox/2026-11-06/m3-photo.jpg" }]);
    await Bun.sleep(30);
    expect(sent).toHaveLength(0);
    fetches.get(2)!([{ ...photo(2), failed: "not downloaded: Telegram refused" }]);
    await waitFor(() => sent.length === 1);
    expect(prompts()).toEqual([["m1", "m2", "m3"]]);
    expect(sent[0]!.text.match(/<household-attachments count="1">\n.*\n/g)).toEqual([
      '<household-attachments count="1">\n{"kind":"photo","mime":"image/jpeg","path":"/.household/inbox/2026-11-06/m1-photo.jpg"}\n',
      '<household-attachments count="1">\n{"kind":"photo","mime":"image/jpeg","failed":"not downloaded: Telegram refused"}\n',
      '<household-attachments count="1">\n{"kind":"photo","mime":"image/jpeg","path":"/.household/inbox/2026-11-06/m3-photo.jpg"}\n',
    ]);
    expect(statuses()).toEqual(["vacation:delivered", ":delivered", ":delivered"]);
    // What came of them is kept: a restart shows them the same, without fetching again.
    expect(store.unfinished("work", "sibling").map((message) => message.attachments?.[0]?.path ?? message.attachments?.[0]?.failed)).toEqual([
      "/.household/inbox/2026-11-06/m1-photo.jpg",
      "not downloaded: Telegram refused",
      "/.household/inbox/2026-11-06/m3-photo.jpg",
    ]);
  } finally {
    delivery.stop();
  }
});

test("after a restart, a queued message's files are fetched before it goes; with nothing to fetch them, they fail and it still goes", async () => {
  const store = new SqliteStore(":memory:");
  const photo: Attachment = { kind: "photo", file: "f" as FileRef };
  store.add("work", "sibling", { text: "before the restart", origin: "chat", ref: "r1" as MessageRef, header: fromChat(1), place: "c1", attachments: [photo] });
  const asked: number[] = [];
  const first = setup({ store, attachments: { fetch: async (_house, _pet, _home, message) => (asked.push(message.id), [{ ...photo, path: "/p" }]) } });
  await waitFor(() => first.sent.length === 1);
  first.delivery.stop();
  expect(asked).toEqual([1]);
  expect(first.sent[0]!.text).toContain('{"kind":"photo","path":"/p"}');

  const bare = setup();
  try {
    bare.delivery.send("work", "sibling", { text: "", origin: "chat", ref: "r2" as MessageRef, header: fromChat(2), place: "c1", attachments: [photo] });
    bare.clock.tick(1_200);
    await waitFor(() => bare.sent.length === 1);
    expect(bare.sent[0]!.text).toContain('{"kind":"photo","failed":"not downloaded: files are not accepted here"}');
  } finally {
    bare.delivery.stop();
  }
});

test("a full batch (25) goes at once, without waiting; the rest starts the next", async () => {
  const { delivery, sent, say, clock, prompts } = setup();
  try {
    for (let n = 1; n <= 26; n++) say(n);
    await waitFor(() => sent.length === 1);
    expect(prompts()[0]).toHaveLength(25);
    await Bun.sleep(30);
    expect(sent).toHaveLength(1);
    clock.tick(1_200);
    await waitFor(() => sent.length === 2);
    expect(prompts()[1]).toEqual(["m26"]);
  } finally {
    delivery.stop();
  }
});

test("another place, an edit of a delivered message, a press and a reaction end a batch: it goes first, at once", async () => {
  const { delivery, sent, say, clock, prompts } = setup();
  const other = (n: number, event: Header["event"], fields: object = {}) =>
    delivery.send("work", "sibling", { text: `other ${n}`, origin: "chat", ref: `o${n}` as MessageRef, header: { ...fromChat(n), event }, place: "c1", ...fields });
  try {
    say(1);
    say(2, "c2"); // another place
    await waitFor(() => sent.length === 1);
    expect(prompts()).toEqual([["m1"]]);
    clock.tick(1_200);
    await waitFor(() => sent.length === 2);

    say(3);
    say(4);
    other(5, { kind: "button", label: "Yes", on: { id: "m9", excerpt: "?" } });
    await waitFor(() => sent.length === 4);
    say(6);
    other(7, { kind: "reaction", added: ["👍"], removed: [], on: { id: "m3", excerpt: "text 3" } });
    await waitFor(() => sent.length === 6);
    say(8);
    other(9, { kind: "edit", id: "m3" }, { edits: "r3" as MessageRef }); // m3 was delivered: the edit goes as its own
    await waitFor(() => sent.length === 8);
    expect(prompts().slice(2)).toEqual([["m3", "m4"], ["button"], ["m6"], ["reaction"], ["m8"], ["m3"]]);
  } finally {
    delivery.stop();
  }
});

test("messages that pile up while the pet cannot take them (a send under way, a dialog) go as one batch", async () => {
  let typed!: () => void;
  const slow = new Promise<{ status: "sent" }>((resolve) => (typed = () => resolve({ status: "sent" })));
  const { delivery, sent, say, clock, prompts, post } = setup({ sends: [slow], visible: async () => true });
  try {
    say(1);
    clock.tick(1_200);
    await waitFor(() => sent.length === 1);
    say(2);
    say(3);
    typed();
    await Bun.sleep(30);
    expect(sent).toHaveLength(1); // they may still grow
    clock.tick(1_200);
    await waitFor(() => sent.length === 2);

    await post(dialog);
    say(4);
    say(5);
    clock.tick(5_000);
    await Bun.sleep(30);
    expect(sent).toHaveLength(2);
    await post({ kind: "dialog-closed" });
    await waitFor(() => sent.length === 3);
    expect(prompts()).toEqual([["m1"], ["m2", "m3"], ["m4", "m5"]]);
  } finally {
    delivery.stop();
  }
});

test("an edit of a message waiting in a batch changes it there; a batch typed but not submitted fails as one", async () => {
  const { delivery, sent, say, clock, edit, updates } = setup({ sends: [{ status: "stuck", reason: "no Enter" }] });
  try {
    say(1);
    say(2);
    edit("r1", "r1.e", "text 1, edited");
    clock.tick(1_200);
    await waitFor(() => updates.length === 1);
    expect(contentsIn(sent[0]!.text)).toEqual(["text 1, edited", "text 2"]);
    expect(updates[0]).toMatchObject({ kind: "failed", why: "stuck", messages: [{ status: "failed" }, { status: "failed" }] });
  } finally {
    delivery.stop();
  }
});

test("after a restart, a half-collected batch goes at once, as one; what the pet had been given fails as one", async () => {
  const store = new SqliteStore(":memory:");
  const first = setup({ store });
  first.say(1);
  first.say(2);
  first.clock.tick(1_200);
  await waitFor(() => first.updates.length === 1);
  first.say(3);
  first.say(4, "c1", true);
  first.delivery.stop(); // before the window is over
  expect(first.statuses()).toEqual(["text 1:delivered", "text 2:delivered", "text 3:received", "text 4:received"]);

  const second = setup({ store });
  try {
    await waitFor(() => second.sent.length === 1); // no window: nothing more is coming from before
    expect(second.prompts()).toEqual([["m3", "m4"]]);
    expect(contentsIn(second.sent[0]!.text)).toEqual(["text 3", "> text 4"]);
    expect(second.updates[0]).toMatchObject({ kind: "failed", why: "interrupted", messages: [{ text: "text 1" }, { text: "text 2" }] });
  } finally {
    second.delivery.stop();
  }
});

test("a refused message closes the pet's batch: what came before and what comes after go apart", async () => {
  const { delivery, sent, say, clock, prompts, post, store } = setup({ visible: async () => true });
  try {
    await post(dialog); // held, so the batch could still grow
    say(10);
    delivery.reject("work", "sibling", { text: "<household-header>", origin: "chat", ref: "bad" as MessageRef });
    say(11);
    clock.tick(1_200);
    await post({ kind: "dialog-closed" });
    await waitFor(() => sent.length === 2);
    expect(prompts()).toEqual([["m10"], ["m11"]]);
    expect(store.byRef("work", "bad" as MessageRef)?.status).toBe("rejected");
  } finally {
    delivery.stop();
  }
});

test("an edit of a message waiting in a batch starts its quiet window again", async () => {
  const { delivery, sent, say, clock, edit, prompts } = setup();
  try {
    say(1);
    say(2);
    clock.tick(1_000);
    edit("r1", "r1.e", "text 1, edited");
    clock.tick(1_199);
    await Bun.sleep(30);
    expect(sent).toHaveLength(0);
    clock.tick(1);
    await waitFor(() => sent.length === 1);
    expect(prompts()).toEqual([["m1", "m2"]]);
  } finally {
    delivery.stop();
  }
});

test("after a restart, a message refused between two queued ones still keeps them apart", async () => {
  const store = new SqliteStore(":memory:");
  const first = setup({ store, visible: async () => true });
  await first.post(dialog); // nothing goes before the restart
  first.say(1);
  first.delivery.reject("work", "sibling", { text: "<household-header>", origin: "chat", ref: "bad" as MessageRef });
  first.say(2);
  first.say(3);
  first.delivery.stop();
  const second = setup({ store });
  try {
    await waitFor(() => second.sent.length === 2);
    expect(second.prompts()).toEqual([["m1"], ["m2", "m3"]]);
  } finally {
    second.delivery.stop();
  }
});

// Turns: what the agent does with what it was given, for the live message.

test("a prompt the agent takes is matched to the batch typed as it, also when it says so before the typing is over", async () => {
  let typed!: (result: SendResult) => void;
  const { delivery, sent, say, send, clock, post, updates, has } = setup({ sends: [new Promise((resolve) => (typed = resolve)), { status: "sent" }] });
  try {
    say(1);
    say(2);
    clock.tick(1_200);
    await waitFor(() => sent.length === 1);
    // The agent's hook comes before the send returns (its Enter was pressed): still the batch's turn.
    await post({ kind: "prompt-accepted", text: `  ${sent[0]!.text.replace(/\n/g, "\r\n")}\u0007`, turn: "t1" });
    expect(updates.at(-1)).toMatchObject({ kind: "turn-started", turn: "t1", messages: [{ text: "text 1" }, { text: "text 2" }] });
    typed({ status: "sent" });
    await waitFor(() => updates.some((update) => update.kind === "delivered"));

    // The agent's own prompt (a background task's news): a turn of no message of Household's.
    await post({ kind: "prompt-accepted", text: "<task-notification>done</task-notification>", turn: "t2" });
    expect(updates.at(-1)).toEqual({ kind: "turn-started", house: "work", pet: "sibling", turn: "t2", messages: [] });
    // Its steps are progress.
    await post({ kind: "tool-started", tool: "Bash", summary: "ls", turn: "t2", call: "c1" });
    expect(updates.at(-1)!.kind).toBe("progress");
    await post({ kind: "turn-finished", text: "done", turn: "t2" });
    expect(updates.at(-1)).toEqual({ kind: "turn-finished", house: "work", pet: "sibling", turn: "t2" });

    // A CLI message's turn names it; a new session loses whatever turn was going on.
    send("from the cli");
    await waitFor(() => sent.length === 2);
    await post({ kind: "prompt-accepted", text: "from the cli" });
    expect(updates.findLast((update) => update.kind === "turn-started")).toMatchObject({ messages: [{ text: "from the cli", origin: "cli" }] });
    // A session that goes on (compacted mid-turn) loses nothing, and the pet is as busy as it was.
    const reported = updates.length;
    await post({ kind: "tool-started", tool: "Bash", summary: "make" });
    await post({ kind: "session-started", continues: true });
    expect(updates.slice(reported).map((update) => update.kind)).toEqual(["progress"]);
    expect(delivery.send("work", "sibling", { text: "and?", origin: "cli" }).activity).toBe("busy");
    await post({ kind: "session-started" });
    expect(updates.at(-1)).toEqual({ kind: "turn-lost", house: "work", pet: "sibling", why: "session" });
    // A turn that failed (the model's service): lost, by its id.
    await post({ kind: "turn-failed", error: "overloaded", turn: "t9" });
    expect(updates.findLast((update) => update.kind === "turn-lost")).toEqual({ kind: "turn-lost", house: "work", pet: "sibling", why: "failed", turn: "t9" });
  } finally {
    delivery.stop();
  }
});

test("a dialog opening while another is open (calls in parallel) is reported too, with its call; one seen only on screen then is the same one", async () => {
  const { delivery, post, updates } = setup();
  try {
    const opened = (input: string): AgentEvent => ({ kind: "dialog-opened", dialog: "permission", summary: "Bash: rm", input });
    await post(opened("fa"));
    await post(opened("fb"));
    await post({ kind: "dialog-opened", dialog: "unknown", summary: "Claude needs your permission" }); // its Notification
    expect(updates.filter((update) => update.kind === "dialog")).toEqual([
      { kind: "dialog", house: "work", pet: "sibling", dialog: "permission", input: "fa" },
      { kind: "dialog", house: "work", pet: "sibling", dialog: "permission", input: "fb" },
    ]);
    await post({ kind: "dialog-closed" });
    expect(updates.at(-1)).toEqual({ kind: "dialog", house: "work", pet: "sibling" });
  } finally {
    delivery.stop();
  }
});

test("a stop: nothing is pressed on an idle agent; a working one is interrupted, then idle; a dialog Household asks is answered instead", async () => {
  const { delivery, post, send, interrupts } = setup({ answer: () => new Promise(() => {}) });
  try {
    const none = async () => false;
    expect(await delivery.interrupt("work", "sibling", none)).toEqual({ status: "idle" });
    expect(interrupts).toEqual([]); // a key on an idle agent would do something else
    await post({ kind: "prompt-accepted", text: "go", turn: "t1" });
    expect(await delivery.interrupt("work", "sibling", none)).toEqual({ status: "stopped" });
    expect(interrupts).toEqual(["Escape"]);
    expect(send("next").activity).toBe("idle"); // it waits for input now
    // A dialog Household is asking: answered (refused with an interrupt), no key pressed.
    void delivery.onPayload("work", "sibling", { waits: { kind: "permission", tool: "Bash", detail: "rm x" } });
    await Bun.sleep(0);
    let answered = 0;
    expect(await delivery.interrupt("work", "sibling", async () => (answered++, true))).toEqual({ status: "stopped" });
    expect([answered, interrupts.length]).toEqual([1, 1]);
    expect(await delivery.interrupt("ghost", "pet", none)).toEqual({ status: "idle" });
  } finally {
    delivery.stop();
  }
});

test("VM restart suspends delivery and stale events until readiness resumes the queued messages", async () => {
  const { delivery, send, sent, post, updates } = setup();
  await delivery.suspend("work", "sibling");
  send("queued during reboot");
  await post({ kind: "dialog-opened", dialog: "question", summary: "stale old process" });
  await Bun.sleep(5);
  expect(sent).toHaveLength(0);
  expect(delivery.isSuspended("work", "sibling")).toBe(true);
  expect(updates.some((update) => update.kind === "turn-lost" && update.why === "session")).toBe(true);
  delivery.resume("work", "sibling");
  await waitFor(() => sent.length === 1);
  expect(sent[0]!.text).toContain("queued during reboot");
  expect(delivery.isSuspended("work", "sibling")).toBe(false);
  delivery.stop();
});

test("scheduled prompts wait for idle, persist results and do not finish on an early reply", async () => {
  const {delivery,post,sent,store}=setup();
  try {
    await post({kind:"prompt-accepted",text:"human work"});
    const now=Date.now();
    const job=store.crons.create("work","sibling",{name:"timer",body:"Check status silently",at:new Date(now+1000).toISOString().slice(0,-1)},now);
    const message=store.crons.fire(job,now+1000)!;
    delivery.acceptScheduled("work","sibling",message);
    await Bun.sleep(10);expect(sent).toHaveLength(0);
    await post({kind:"turn-finished",text:"human work done"});
    await waitFor(()=>sent.length===1);
    await post({kind:"prompt-accepted",text:message.text,turn:"cron-turn"});
    delivery.answered("work","sibling");
    expect(store.crons.view("work","sibling").runs[0]!.status).toBe("delivered");
    await post({kind:"turn-finished",text:"Everything is fine",turn:"cron-turn"});
    const run=store.crons.view("work","sibling").runs[0]!;
    expect(run.status).toBe("answered");expect(run.result).toBe("Everything is fine");expect(run.started).not.toBeNull();
  } finally {delivery.stop();store.close();}
});

test("scheduled errors are recorded; queued tasks recover, dispatched tasks never replay", async () => {
  const {delivery,post,sent,store}=setup();
  const now=Date.now();
  try {
    const job=store.crons.create("work","sibling",{name:"timer",body:"check",at:new Date(now+1).toISOString().slice(0,-1)},now);
    const message=store.crons.fire(job,now+1)!;
    delivery.acceptScheduled("work","sibling",message);await waitFor(()=>sent.length===1);
    await post({kind:"prompt-accepted",text:message.text});
    await post({kind:"turn-failed",error:"provider unavailable"});
    expect(store.crons.view("work","sibling").runs[0]!.error).toBe("provider unavailable");
    expect(store.crons.view("work","sibling").runs[0]!.status).toBe("failed");
    delivery.stop();
    const restarted=setup({store});
    await Bun.sleep(10);expect(restarted.sent).toHaveLength(0);restarted.delivery.stop();
  } finally {delivery.stop();store.close();}
});

test("two cron tasks never enter the session together before prompt-accepted arrives", async () => {
  const {delivery,sent,post,store}=setup();const now=Date.now();
  try {
    for (let n=0;n<2;n++) {
      const j=store.crons.create("work","sibling",{name:`task ${n}`,body:"check",at:new Date(now+1).toISOString().slice(0,-1)},now);
      delivery.acceptScheduled("work","sibling",store.crons.fire(j,now+1)!);
    }
    await waitFor(()=>sent.length===1);await Bun.sleep(20);expect(sent).toHaveLength(1);
    await post({kind:"prompt-accepted",text:sent[0]!.text});
    await post({kind:"turn-finished",text:"first done"});
    await waitFor(()=>store.crons.view("work","sibling").runs.some(r=>r.status === "delivered"));
    expect(sent).toHaveLength(2);
    expect(store.crons.view("work","sibling").runs.map(r=>r.status).sort()).toEqual(["answered","delivered"]);
  } finally {delivery.stop();store.close();}
});

test("a crash during scheduled submission is not replayed after restart", async()=>{
  const store=new SqliteStore(":memory:");const now=Date.now();
  const job=store.crons.create("work","sibling",{name:"once",body:"check",at:new Date(now+1).toISOString().slice(0,-1)},now);
  const message=store.crons.fire(job,now+1)!;
  store.setStatus(message.id,"dispatching");
  const {delivery,sent}=setup({store});
  try {await Bun.sleep(10);expect(sent).toHaveLength(0);expect(store.crons.view("work","sibling").runs[0]!.status).toBe("failed");}
  finally {delivery.stop();store.close();}
});


test("restored cron waits for the surviving busy session and ignores unrelated turn results", async () => {
  const store = new SqliteStore(":memory:");
  const now = Date.now();
  const job = store.crons.create("work", "sibling", { name: "restored", body: "check", at: new Date(now + 1).toISOString().slice(0, -1) }, now);
  store.crons.fire(job, now + 1);
  let idle = false;
  const { delivery, sent, post, pet } = setup({ store, idle: async () => idle });
  const run = () => store.crons.view("work", "sibling").runs[0]!;
  try {
    await delivery.adopt([pet]);
    await Bun.sleep(30);
    expect(sent).toHaveLength(0);
    expect(run().status).toBe("received");
    idle = true;
    await post({ kind: "turn-finished", text: "old human result", turn: "human" });
    await waitFor(() => run().status === "delivered");
    await post({ kind: "turn-finished", text: "late human result", turn: "human" });
    await post({ kind: "turn-failed", error: "late human error", turn: "human" });
    expect(run().status).toBe("delivered");
    expect(run().result).toBeNull();
    expect(run().started).toBeNull();
    await post({ kind: "prompt-accepted", text: sent[0]!.text, turn: "cron" });
    await post({ kind: "turn-finished", text: "wrong turn", turn: "human" });
    await post({ kind: "turn-failed", error: "wrong error", turn: "human" });
    expect(run().status).toBe("delivered");
    expect(run().error).toBeNull();
    await post({ kind: "turn-finished", text: "correct result", turn: "cron" });
    expect(run().status).toBe("answered");
    expect(run().result).toBe("correct result");
    expect(sent).toHaveLength(1);
  } finally { delivery.stop(); store.close(); }
});

test("unavailable idle probe keeps cron durable until the session can be checked", async () => {
  let available = false;
  const { delivery, sent, store } = setup({ idle: async () => { if (!available) throw new Error("offline"); return true; } });
  const now = Date.now();
  const job = store.crons.create("work", "sibling", { name: "retry", body: "check", at: new Date(now + 1).toISOString().slice(0, -1) }, now);
  try {
    delivery.acceptScheduled("work", "sibling", store.crons.fire(job, now + 1)!);
    await Bun.sleep(30);
    expect(sent).toHaveLength(0);
    expect(store.crons.view("work", "sibling").runs[0]!.status).toBe("received");
    available = true;
    await waitFor(() => sent.length === 1);
  } finally { delivery.stop(); store.close(); }
});


test("session disconnect fails both accepted and not-yet-accepted scheduled submissions", async () => {
  for (const accepted of [false, true]) {
    const { delivery, sent, store, post } = setup();
    const now = Date.now();
    const job = store.crons.create("work", "sibling", { name: "disconnect", body: "check", at: new Date(now + 1).toISOString().slice(0, -1) }, now);
    try {
      delivery.acceptScheduled("work", "sibling", store.crons.fire(job, now + 1)!);
      await waitFor(() => store.crons.view("work", "sibling").runs[0]!.status === "delivered");
      if (accepted) await post({ kind: "prompt-accepted", text: sent[0]!.text, turn: "cron" });
      await post({ kind: "turn-failed", scope: "session", error: "bridge disconnected" });
      const run = store.crons.view("work", "sibling").runs[0]!;
      expect(run.status).toBe("failed");
      expect(run.error).toBe("bridge disconnected");
    } finally { delivery.stop(); store.close(); }
  }
});


test("core is injected once, then only after revision changes or context resets; refused sends retry it", async () => {
  let revision=1;
  const {delivery,send,post,sent,clock,store}=setup({memory:()=>({revision,text:`CORE${revision}\n`}), sends:[{status:"refused",reason:"busy"},{status:"sent"}]});
  try {
    send("one"); await waitFor(()=>sent.length===1);
    clock.tick(20); await waitFor(()=>sent.length===2);
    expect(sent[0]!.text).toContain("CORE1"); expect(sent[1]!.text).toContain("CORE1");
    await post({kind:"turn-finished",text:"done"});
    send("two"); await waitFor(()=>sent.length===3); expect(sent[2]!.text).not.toContain("CORE");
    await post({kind:"turn-finished",text:"done"}); revision=2;
    send("three"); await waitFor(()=>sent.length===4); expect(sent[3]!.text).toContain("CORE2");
    await post({kind:"turn-finished",text:"done"}); await post({kind:"session-started",continues:true});
    send("four"); await waitFor(()=>sent.length===5); expect(sent[4]!.text).toContain("CORE2");
  } finally {delivery.stop();store.close();}
});


test("the house's scouts ride with core: a change to the list alone sends both again", async () => {
  let scouts="general";
  const {delivery,send,post,sent,store}=setup({memory:()=>({revision:`1:${scouts}`,text:`CORE1\n<household-scouts>${scouts}</household-scouts>\n`})});
  try {
    send("one"); await waitFor(()=>sent.length===1); expect(sent[0]!.text).toContain("<household-scouts>general");
    await post({kind:"turn-finished",text:"done"});
    send("two"); await waitFor(()=>sent.length===2); expect(sent[1]!.text).not.toContain("household-scouts");
    await post({kind:"turn-finished",text:"done"}); scouts="general,prod-ops";
    send("three"); await waitFor(()=>sent.length===3); expect(sent[2]!.text).toContain("<household-scouts>general,prod-ops");
  } finally {delivery.stop();store.close();}
});

test("compaction during submission cannot mark the old core snapshot as current",async()=>{
  let finish!:(value:SendResult)=>void;
  const pending=new Promise<SendResult>(resolve=>{finish=resolve;});
  const {delivery,send,post,sent,store}=setup({memory:()=>({revision:1,text:"CORE\n"}),sends:[pending]});
  try {
    send("one");await waitFor(()=>sent.length===1);
    await post({kind:"session-started",continues:true});finish({status:"sent"});
    await waitFor(()=>store.unfinished("work","sibling")[0]?.status==="delivered");
    await post({kind:"turn-finished",text:"done"});
    send("two");await waitFor(()=>sent.length===2);expect(sent[1]!.text).toContain("CORE");
  }finally{delivery.stop();store.close();}
});

test("restart notice waits for idle, matches its own turn and holds incoming messages until release", async () => {
  const { delivery, sent, post, send, clock } = setup();
  await post({ kind: "prompt-accepted", text: "old work", turn: "old" });
  let released: (() => void) | undefined;
  const preparing = delivery.prepareRestart("work", "sibling", 1000).then(value => { released = value; });
  expect(sent).toHaveLength(0);
  send("message during restart");
  await post({ kind: "turn-finished", text: "done", turn: "old" });
  clock.tick(250);
  await waitFor(() => sent.length === 1);
  expect(sent[0]!.text).toContain("Save your work");
  await post({ kind: "turn-finished", text: "done", turn: "old" });
  expect(released).toBeUndefined();
  await post({ kind: "prompt-accepted", text: sent[0]!.text, turn: "shutdown" });
  await post({ kind: "turn-finished", text: "done", turn: "unrelated" });
  expect(released).toBeUndefined();
  await post({ kind: "turn-finished", text: "done", turn: "shutdown" });
  await preparing;
  expect(sent).toHaveLength(1);
  released!();
  await waitFor(() => sent.length === 2);
  expect(sent[1]!.text).toContain("message during restart");
  delivery.stop();
});

test("restart grace period expires even when idle probe hangs, and never sends a stale notice", async () => {
  let resolve!: (value: boolean) => void;
  const { delivery, clock, sent } = setup({ idle: () => new Promise(r => { resolve = r; }) });
  const preparing = delivery.prepareRestart("work", "sibling", 1000);
  await expect(delivery.prepareRestart("work", "sibling")).rejects.toThrow("already restarting");
  clock.tick(1000);
  const release = await preparing;
  resolve(true);
  await Promise.resolve();
  expect(sent).toHaveLength(0);
  release();
  delivery.stop();
});

test("uncertain restart submission is never retried", async () => {
  const { delivery, sent, clock } = setup({ sends: [{ status: "stuck", reason: "uncertain" }] });
  const preparing = delivery.prepareRestart("work", "sibling", 1000);
  await waitFor(() => sent.length === 1);
  clock.tick(500);
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  clock.tick(500);
  (await preparing)();
  delivery.stop();
});

test("a delayed shutdown send cannot execute new commands after the deadline", async () => {
  const { delivery, pet, clock } = setup();
  let continueSend!: () => void;
  let lateResult: { ok: boolean; output: string } | undefined;
  pet.agent.send = async exec => {
    await new Promise<void>(r => { continueSend = r; });
    lateResult = await exec(["tmux", "paste-buffer"]);
    return { status: "stuck", reason: "deadline" };
  };
  const preparing = delivery.prepareRestart("work", "sibling", 1000);
  await waitFor(() => !!continueSend);
  clock.tick(1000);
  (await preparing)();
  continueSend();
  await waitFor(() => !!lateResult);
  expect(lateResult!.ok).toBe(false);
  delivery.stop();
});

test("disabled pets keep messages queued across mailbox initialization until explicitly resumed", async () => {
  const { delivery, pet, sent, send, clock } = setup();
  await delivery.suspend("work", "sibling");
  delivery.setPets([{ ...pet, enabled: false }]);
  send("queued while disabled");
  clock.tick(5000);
  await Promise.resolve();
  expect(sent).toHaveLength(0);
  delivery.setPets([pet]);
  expect(sent).toHaveLength(0);
  delivery.resume("work", "sibling");
  await waitFor(() => sent.length === 1);
  expect(sent[0]!.text).toContain("queued while disabled");
  delivery.stop();
});


test("presentation redaction does not change inbox correlation or native event identities", async () => {
  const { redactAgentEvent } = await import("../../src/app/scout-redaction");
  const { delivery, send, post, sent, updates, lines } = setup({ sanitizeEvent: (_h, _p, event) => redactAgentEvent(event, text => text.replaceAll("private-token", "[masked]")) });
  try {
    send("Task private-token");
    await waitFor(() => sent.length === 1);
    await post({ kind: "prompt-accepted", text: sent[0]!.text, turn: "private-token-turn" });
    const start = updates.find(update => update.kind === "turn-started");
    expect(start?.kind).toBe("turn-started");
    if (start?.kind === "turn-started") { expect(start.turn).toBe("private-token-turn"); expect(start.messages).toHaveLength(1); }
    await post({ kind: "tool-started", tool: "Bash", summary: "curl private-token", call: "private-token-call", turn: "private-token-turn", input: "private-token-fingerprint", action: { kind: "run", target: "private-token", says: "Use private-token" } });
    const progress = updates.find(update => update.kind === "progress");
    if (progress?.kind === "progress" && progress.event.kind === "tool-started") {
      expect(progress.event.call).toBe("private-token-call"); expect(progress.event.input).toBe("private-token-fingerprint"); expect(progress.event.summary).toBe("curl [masked]"); expect(progress.event.action?.target).toBe("[masked]");
    } else throw new Error("Missing tool progress");
    expect(lines.join("\n")).not.toContain("curl private-token");
    await post({ kind: "notification", text: "Value private-token", audience: "chat" });
    expect(updates.find(update => update.kind === "notification")).toMatchObject({ text: "Value [masked]" });
  } finally { delivery.stop(); }
});

function inboxEvent(n: number, inbox = 'alerts', place = 'pet:sibling@c1') {
  return {origin:'inbox' as const,ref:`inbox-${n}` as MessageRef,place,text:`FULL_EXTERNAL_BODY_${n}`,header:{...fromChat(n,true),from:{id:`source-${inbox}`,name:inbox,trust:'guest' as const},channel:{...fromChat(n).channel,meta:{inbox,inboxTitle:inbox,eventTitle:`Event ${n}`,receivedAt:new Date(Date.UTC(2026,10,9,12,0,n)).toISOString()}},place:{id:place,kind:'pet-thread',title:'Sibling'}}};
}

test('offline inbox backlog returns as one digest grouped by source, then acknowledgments cover all originals',async()=>{
 const s=setup();
 try {
  await s.delivery.suspend('work','sibling');
  for(let n=0;n<100;n++)s.delivery.send('work','sibling',inboxEvent(n,n%2?'mail':'alerts'));
  expect(s.sent).toHaveLength(0);
  expect(s.store.unfinished('work','sibling')).toHaveLength(100);
  s.delivery.resume('work','sibling');
  await waitFor(()=>s.sent.length===1);
  expect(s.sent[0]!.text).toContain('inbox_catchup');
  expect(s.sent[0]!.text).toContain('"count":100');
  expect(s.sent[0]!.text.match(/"count":50/g)).toHaveLength(2);
  expect(s.sent[0]!.text).toContain('inbox_history');
  expect(s.sent[0]!.text).not.toContain('FULL_EXTERNAL_BODY');
  expect(s.sent[0]!.text.length).toBeLessThan(6000);
  expect(s.store.unfinished('work','sibling').every(m=>m.status==='delivered')).toBe(true);
  await s.post({kind:'turn-finished',text:''});
  expect(s.store.unfinished('work','sibling')).toHaveLength(0);
  s.delivery.resume('work','sibling');expect(s.sent).toHaveLength(1);
 } finally{s.delivery.stop();}
});

test('digest survives daemon restart and does not merge distinct reply places',async()=>{
 const store=new SqliteStore(':memory:');const first=setup({store});
 await first.delivery.suspend('work','sibling');
 first.delivery.send('work','sibling',inboxEvent(1));
 first.delivery.send('work','sibling',inboxEvent(2,'alerts','pet:sibling@c2'));
 first.delivery.stop();
 const second=setup({store});
 try {
  await waitFor(()=>second.sent.length===1);
  expect(second.sent[0]!.text).toContain('inbox_catchup');
  expect(second.sent[0]!.text).toContain('"count":1');
  expect(second.sent[0]!.text).not.toContain('pet:sibling@c2');
  await second.post({kind:'turn-finished',text:''});
  await waitFor(()=>second.sent.length===2);
  expect(second.sent[1]!.text).toContain('pet:sibling@c2');
 }finally{second.delivery.stop();}
});

test('interrupted delivered inbox events are recovered as uncertain catch-up, not raw replay',async()=>{
 const s=setup();
 try {
  s.delivery.send('work','sibling',inboxEvent(1));
  s.clock.tick(1200);await waitFor(()=>s.sent.length===1);
  expect(s.sent[0]!.text).toContain('FULL_EXTERNAL_BODY_1');
  await s.delivery.suspend('work','sibling');
  expect(s.store.unfinished('work','sibling')[0]!.status).toBe('received');
  s.delivery.resume('work','sibling');await waitFor(()=>s.sent.length===2);
  expect(s.sent[1]!.text).toContain('completion was not confirmed');
  expect(s.sent[1]!.text).not.toContain('FULL_EXTERNAL_BODY_1');
  await s.post({kind:'turn-finished',text:''});expect(s.store.unfinished('work','sibling')).toHaveLength(0);
 }finally{s.delivery.stop();}
});

test('temporarily unavailable VM retains events and gives a digest when ready',async()=>{
 let ready=false;const s=setup({idle:async()=>ready});
 try {
  s.delivery.send('work','sibling',inboxEvent(1));
  s.delivery.send('work','sibling',inboxEvent(2));
  await Bun.sleep(20);expect(s.sent).toHaveLength(0);
  ready=true;s.clock.tick(1200);
  await waitFor(()=>s.sent.length===1);
  expect(s.sent[0]!.text).toContain('"count":2');
  expect(s.sent[0]!.text).toContain('inbox_catchup');
 }finally{s.delivery.stop();}
});

test('a send interrupted by VM loss retries a compact digest without losing queue rows',async()=>{
 const s=setup();const original=s.pet.agent.send;let attempts=0;
 s.pet.agent.send=async(...args)=>{if(++attempts===1)throw Error('VM unavailable');return original(...args);};
 try{
  s.delivery.send('work','sibling',inboxEvent(1));
  s.clock.tick(1200);await waitFor(()=>s.sent.length===1);
  expect(s.sent[0]!.text).toContain('inbox_catchup');
  expect(s.store.unfinished('work','sibling')[0]!.status).toBe('delivered');
 }finally{s.delivery.stop();}
});

test('failed inbox turn does not leave catch-up delivery blocked forever',async()=>{
 const s=setup();try{
  s.delivery.send('work','sibling',inboxEvent(1));s.clock.tick(1200);await waitFor(()=>s.sent.length===1);
  await s.post({kind:'turn-failed',error:'session disappeared',scope:'session'});
  await waitFor(()=>s.sent.length===2);expect(s.sent[1]!.text).toContain('inbox_catchup');
 }finally{s.delivery.stop();}
});
