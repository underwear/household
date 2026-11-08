import { expect, test } from "bun:test";
import { Dialogs, type Board, type Timer } from "../../src/app/dialogs";
import type { Choices, PostRef } from "../../src/core/channel";
import type { DialogQuestion, Question } from "../../src/core/dialog";

const which: Question = { text: "Which color?", options: [{ label: "Red", description: "warm" }, { label: "Green" }], multiSelect: false };
const color: DialogQuestion = { kind: "questions", questions: [which] };
const shown = (choices: Choices) => choices.map((row) => `{${row.join("|")}}`).join("");

/** Dialogs on a board that records cards as `card-<n>` and lets the test press them. */
function setup() {
  const calls: string[] = [];
  const presses = new Map<string, (index: number) => Promise<void>>();
  let failPost = -1;
  const board: Board = {
    async post(text, choices, onPress) {
      if (presses.size === failPost) throw new Error("sendMessage: 400 Bad Request: chat not found");
      const card = `card-${presses.size + 1}` as PostRef;
      presses.set(card, onPress);
      calls.push(`post ${card}: ${text} ${shown(choices)}`);
      return card;
    },
    setChoices: async (ref, choices) => void calls.push(`choices ${ref}: ${shown(choices)}`),
    resolve: async (ref, outcome) => void calls.push(`resolve ${ref}: ${outcome}`),
  };
  const lines: string[] = [];
  const timer = { ms: 0, fire: () => {}, cancelled: false };
  const start: Timer = (ms, fire) => {
    Object.assign(timer, { ms, fire, cancelled: false });
    return () => void (timer.cancelled = true);
  };
  const dialogs = new Dialogs({ info: (line) => lines.push(line), error: (line) => lines.push(`ERROR ${line}`) }, start);
  const ask = (dialog: DialogQuestion, signal?: AbortSignal) => dialogs.ask({ pet: "work/sibling", title: "Sibling", board, waitMs: 30 * 60_000 }, dialog, signal);
  const press = (card: string, index: number) => presses.get(card)!(index);
  return { calls, lines, timer, dialogs, ask, press, board, failAt: (n: number) => (failPost = n) };
}

test("a question is a card; a button answers it, and the card shows the choice; a late press changes nothing", async () => {
  const { calls, lines, press, ask } = setup();
  const answer = ask(color);
  await Bun.sleep(0);
  expect(calls).toEqual(["post card-1: Sibling asks:\n\nWhich color?\n\n• Red — warm\n• Green\n\nAnswer with a button or in text. {Red}{Green}"]);
  await press("card-1", 1);
  expect(await answer).toEqual({ kind: "answers", answers: [{ chosen: ["Green"] }] });
  await press("card-1", 0);
  expect(calls.slice(1)).toEqual(["resolve card-1: Green"]);
  expect(lines).toEqual(["pet work/sibling: dialog shown in the chat", "pet work/sibling: dialog answered"]);
});

test("text written while a dialog waits answers it; another pet's text, or text once nothing waits, does not", async () => {
  const { calls, dialogs, ask } = setup();
  const answer = ask(color);
  await Bun.sleep(0);
  expect(await dialogs.text("work/chair", "blue")).toBe(false);
  expect(await dialogs.text("work/sibling", "blue,\nbut darker")).toBe(true);
  expect(await answer).toEqual({ kind: "answers", answers: [{ text: "blue,\nbut darker" }] });
  expect(calls.at(-1)).toBe('resolve card-1: "blue, but darker"');
  expect(await dialogs.text("work/sibling", "more")).toBe(false);
});

test('several questions are a card each; a multi-select marks with ✓ until "Done"; text answers the next open one', async () => {
  const { calls, dialogs, press, ask } = setup();
  const answer = ask({
    kind: "questions",
    questions: [
      { text: "Which colors?", options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }], multiSelect: true },
      { text: "Which size?", options: [{ label: "M" }, { label: "L" }], multiSelect: false },
    ],
  });
  await Bun.sleep(0);
  expect(calls[0]).toStartWith("post card-1: Sibling asks (1 of 2):\n\nWhich colors?");
  expect(calls[0]).toEndWith('Tick what fits and press "Done", or answer in text. {Red}{Green}{Blue}{Done}');
  expect(calls[1]).toStartWith("post card-2: Sibling asks (2 of 2):\n\nWhich size?");
  await press("card-1", 3); // "Done" with nothing marked: nothing happens
  for (const index of [0, 1, 0, 2]) await press("card-1", index);
  expect(calls.slice(2)).toEqual([
    "choices card-1: {✓ Red}{Green}{Blue}{Done}",
    "choices card-1: {✓ Red}{✓ Green}{Blue}{Done}",
    "choices card-1: {Red}{✓ Green}{Blue}{Done}",
    "choices card-1: {Red}{✓ Green}{✓ Blue}{Done}",
  ]);
  await press("card-1", 3);
  expect(calls.at(-1)).toBe("resolve card-1: Green, Blue");
  await dialogs.text("work/sibling", "XL");
  expect(await answer).toEqual({ kind: "answers", answers: [{ chosen: ["Green", "Blue"] }, { text: "XL" }] });
  expect(calls.at(-1)).toBe('resolve card-2: "XL"');
});

test("a plan is approved with its button, or sent back with what the person writes; a long one is cut to fit a card", async () => {
  const { calls, dialogs, press, ask } = setup();
  const approved = ask({ kind: "plan", plan: "# Plan\n\n1. README" });
  await Bun.sleep(0);
  expect(calls[0]).toBe("post card-1: Sibling asks you to approve a plan:\n\n# Plan\n\n1. README\n\nApprove with the button or write what to change. {✅ Approve}");
  await press("card-1", 0);
  expect(await approved).toEqual({ kind: "approve" });
  expect(calls.at(-1)).toBe("resolve card-1: Approved");

  const revised = ask({ kind: "plan", plan: "x".repeat(10_000) });
  await Bun.sleep(0);
  expect(calls.at(-1)!.length).toBeLessThan(3200);
  expect(calls.at(-1)).toContain("…\n(the rest is in `house pet attach`)");
  await dialogs.text("work/sibling", "add tests");
  expect(await revised).toEqual({ kind: "revise", text: "add tests" });
  expect(calls.at(-1)).toBe('resolve card-2: Sent back: "add tests"');
});

test("when the wait is over the agent gets the answers given so far, and the cards still open say time is up", async () => {
  const { calls, timer, press, ask } = setup();
  const answer = ask({ kind: "questions", questions: [which, { text: "And the size?", options: [{ label: "M" }], multiSelect: false }] });
  await Bun.sleep(0);
  expect(timer.ms).toBe(30 * 60_000);
  await press("card-1", 0);
  timer.fire();
  expect(await answer).toEqual({ kind: "timeout", answers: [{ chosen: ["Red"] }, undefined] });
  expect(calls.slice(2)).toEqual(["resolve card-1: Red", "resolve card-2: Time to answer ran out"]);
});

test("a dialog answered in the agent's session ends without an answer; when Household stops, all do and no new one starts", async () => {
  const { calls, timer, dialogs, lines, ask } = setup();
  const aborted = new AbortController();
  const terminal = ask(color, aborted.signal);
  await Bun.sleep(0);
  aborted.abort();
  expect(await terminal).toBeUndefined();
  expect(timer.cancelled).toBe(true);
  expect(calls.at(-1)).toBe("resolve card-1: Answered in the terminal");
  expect(lines).toContain("pet work/sibling: dialog answered in the terminal");
  expect(await ask(color, AbortSignal.abort())).toBeUndefined(); // gone before any card
  expect(calls).toHaveLength(2);

  const left = ask({ kind: "plan", plan: "x" });
  await Bun.sleep(0);
  await dialogs.stop();
  expect(await left).toBeUndefined();
  expect(calls.at(-1)).toBe("resolve card-2: Household stopped: answer in the terminal");
  expect(await ask(color)).toBeUndefined();
  expect(calls).toHaveLength(4);
});

test("a dialog that cannot be shown stays in the terminal; a card that did show says so", async () => {
  const { calls, lines, ask, failAt } = setup();
  failAt(1); // the second card
  const two: DialogQuestion = { kind: "questions", questions: [{ text: "1?", options: [{ label: "a" }], multiSelect: false }, { text: "2?", options: [{ label: "b" }], multiSelect: false }] };
  expect(await ask(two)).toBeUndefined();
  expect(lines).toContain("ERROR pet work/sibling: the dialog could not be shown (sendMessage: 400 Bad Request: chat not found)");
  expect(calls.at(-1)).toBe("resolve card-1: Could not be shown in full: answer in the terminal");
});

test("a permission is a Yes / No card waited on 30 s, House's own timer: then House refuses it, saying nobody answered", async () => {
  const { calls, timer, dialogs, press, board } = setup();
  const rm: DialogQuestion = { kind: "permission", tool: "Bash", detail: 'rm "$x/$f.gz"', about: "Remove the archive" };
  const ask = () => dialogs.ask({ pet: "work/sibling", title: "Sibling", board, waitMs: 30_000 }, rm);
  const allowed = ask();
  await Bun.sleep(0);
  expect(calls.at(-1)).toBe('post card-1: Sibling asks for permission (an action inside its VM):\n\nBash: rm "$x/$f.gz"\n(Remove the archive)\n\nNo answer in 30 s means no. {Yes|No}');
  expect(timer.ms).toBe(30_000);
  await press("card-1", 0);
  expect(await allowed).toEqual({ kind: "allow" });
  expect(calls.at(-1)).toBe("resolve card-1: Allowed");

  const denied = ask();
  await Bun.sleep(0);
  expect(await dialogs.text("work/sibling", "no")).toBe(false); // text is the pet's message, not the answer
  await press("card-2", 1);
  expect(await denied).toEqual({ kind: "deny" });
  expect(calls.at(-1)).toBe("resolve card-2: Denied");

  const late = ask();
  await Bun.sleep(0);
  timer.fire();
  expect(await late).toEqual({ kind: "unanswered", waitedMs: 30_000 });
  expect(calls.at(-1)).toBe("resolve card-3: No answer in 30 s: denied");
});
