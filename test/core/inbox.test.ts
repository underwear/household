import { expect, test } from "bun:test";
import { PetInbox } from "../../src/core/inbox";
import type { Message } from "../../src/core/message";

const dialog = { kind: "dialog-opened", dialog: "question", summary: "?" } as const;
const closed = { kind: "dialog-closed" } as const;

test("activity follows events: idle → busy → dialog → busy → idle", () => {
  const inbox = new PetInbox();
  expect(inbox.activity).toBe("idle");
  inbox.observe({ kind: "prompt-accepted", text: "hi" });
  expect(inbox.activity).toBe("busy");
  inbox.observe(dialog);
  expect(inbox.activity).toBe("dialog");
  inbox.observe({ kind: "notification", text: "needs you" });
  expect(inbox.activity).toBe("dialog");
  inbox.observe(closed);
  expect(inbox.activity).toBe("busy");
  inbox.observe({ kind: "turn-finished", text: "done" });
  expect(inbox.activity).toBe("idle");
});

test("only dialog-closed closes a dialog: background work goes on while it waits", () => {
  const inbox = new PetInbox();
  inbox.observe(dialog);
  for (const event of [
    { kind: "tool-started", tool: "Bash", summary: "ls" },
    { kind: "tool-finished", tool: "Bash" },
    { kind: "turn-finished", text: "x" },
  ] as const) {
    expect(inbox.observe(event)).toBe(true);
    expect(inbox.activity).toBe("dialog");
  }
  expect(inbox.observe(closed)).toBe(true);
  expect(inbox.activity).toBe("busy");
});

test("a close with no dialog open and a second open are not worth recording", () => {
  const inbox = new PetInbox();
  expect(inbox.observe(closed)).toBe(false);
  expect(inbox.activity).toBe("idle");
  expect(inbox.observe(dialog)).toBe(true);
  expect(inbox.observe({ ...dialog, dialog: "permission" })).toBe(false);
  expect(inbox.activity).toBe("dialog");
});

const message = (id: number, text: string): Message => ({ id, text, status: "received", origin: "cli" });

const texts = (inbox: PetInbox) => inbox.next(25).messages.map((m) => m.text);

test("messages wait while a dialog is open, in order, and leave only when delivered", () => {
  const inbox = new PetInbox();
  inbox.push(message(1, "one"));
  inbox.push(message(2, "two"));
  expect(texts(inbox)).toEqual(["one"]); // idle or busy: fine, the agent queues it
  inbox.observe(dialog);
  expect(inbox.next(25)).toEqual({ messages: [], complete: true });
  inbox.observe(closed);
  expect(texts(inbox)).toEqual(["one"]);
  inbox.delivered();
  expect([texts(inbox), inbox.size]).toEqual([["two"], 1]);
});

test("a waiting message can be edited; one that left cannot", () => {
  const inbox = new PetInbox();
  inbox.push(message(1, "one"));
  inbox.push(message(2, "two"));
  inbox.delivered();
  expect(inbox.replace(1, "uno")).toBe(false);
  expect(inbox.replace(2, "dos")).toBe(true);
  expect(texts(inbox)).toEqual(["dos"]);
});

/** A new message from the chat, by person `from` in place `place`; `kind` other than message makes it no batch's. */
const chat = (id: number, place = "c1", from = "p1", kind: "message" | "edit" = "message"): Message => ({
  ...message(id, `m${id}`),
  origin: "chat",
  header: { event: { kind, id: `m${id}` }, from: { id: from, name: "Oleg", trust: "owner" }, channel: { id: "c1", kind: "telegram-private", name: "x", audience: "private" } },
  place,
});

/** Hands out everything waiting, batch by batch: their ids, and whether each was complete. */
function drain(inbox: PetInbox, max: number): [number[], boolean][] {
  const batches: [number[], boolean][] = [];
  for (let next = inbox.next(max); next.messages.length > 0; next = inbox.next(max)) {
    batches.push([next.messages.map((m) => m.id), next.complete]);
    inbox.delivered(next.messages.length);
  }
  return batches;
}

test("new messages in a row from one person in one place go together; the batch may grow until something else waits behind it", () => {
  const inbox = new PetInbox();
  inbox.push(chat(1));
  expect(inbox.next(25)).toMatchObject({ messages: [{ id: 1 }], complete: false });
  inbox.push(chat(2));
  expect(inbox.next(25)).toMatchObject({ messages: [{ id: 1 }, { id: 2 }], complete: false });
  inbox.push(chat(3, "c2")); // another place
  expect(inbox.next(25)).toMatchObject({ messages: [{ id: 1 }, { id: 2 }], complete: true });
  inbox.delivered(2);
  inbox.push(chat(4, "c2", "p2")); // another person
  inbox.push(chat(5, "c2", "p2", "edit")); // an edit: on its own
  inbox.push({ ...message(6, "cli") }); // `house pet send`: on its own, at once
  expect(drain(inbox, 25)).toEqual([[[3], true], [[4], true], [[5], true], [[6], true]]);
});

test("a batch is full at `max`; a boundary the queue does not show closes it", () => {
  const inbox = new PetInbox();
  for (let id = 1; id <= 4; id++) inbox.push(chat(id));
  expect(inbox.next(3)).toMatchObject({ messages: [{ id: 1 }, { id: 2 }, { id: 3 }], complete: true });
  inbox.delivered(3);
  expect(inbox.next(3)).toMatchObject({ messages: [{ id: 4 }], complete: false });
  inbox.close(); // e.g. a message refused after it
  inbox.push(chat(5));
  expect(inbox.next(3)).toMatchObject({ messages: [{ id: 4 }], complete: true });
  inbox.delivered();
  expect(inbox.next(3)).toMatchObject({ messages: [{ id: 5 }], complete: false });
  inbox.observe(dialog); // held: boundaries pile up with the messages
  inbox.close();
  inbox.push(chat(6));
  inbox.close();
  inbox.push(chat(7));
  inbox.observe(closed);
  expect(drain(inbox, 3)).toEqual([[[5], true], [[6], true], [[7], false]]);
});

test("polled events wait until idle and do not interrupt the current task", () => {
  const inbox = new PetInbox();
  inbox.observe({ kind: "prompt-accepted", text: "working" });
  inbox.push({ id: 1, text: "new email", status: "received", origin: "inbox" });
  expect(inbox.next(10).messages).toHaveLength(0);
  inbox.observe({ kind: "turn-finished", text: "done" });
  expect(inbox.next(10).messages).toHaveLength(1);
});
