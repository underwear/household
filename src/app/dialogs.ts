import type { Choices, PostRef } from "../core/channel";
import type { DialogAnswer, DialogQuestion, QuestionAnswer } from "../core/dialog";
import type { EventLog } from "../infra/event-log";
import { cardsFor, questionChoices, quote } from "./dialog-cards";

/** Starts a timer; the result cancels it. Injected, so tests need not wait half an hour. */
export type Timer = (ms: number, fire: () => void) => () => void;

const realTimer: Timer = (ms, fire) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/**
 * Cards in one place, through whatever channel its house has at the moment. `post` shows a card (a notice with
 * choices) and calls `onPress` with the index of each press on it until it is resolved. Never throws but `post`.
 */
export interface Board {
  post(text: string, choices: Choices, onPress: (index: number) => Promise<void>): Promise<PostRef>;
  setChoices(ref: PostRef, choices: Choices): Promise<void>;
  resolve(ref: PostRef, outcome: string): Promise<void>;
}

/** Who asks (`house/pet`) and how they are called, where the cards go, and how long the person has. */
export interface DialogTarget {
  pet: string;
  title: string;
  board: Board;
  waitMs: number;
}

interface Pending {
  target: DialogTarget;
  dialog: DialogQuestion;
  /** One card per question (a plan has one), as far as shown. */
  cards: (PostRef | undefined)[];
  answers: (QuestionAnswer | undefined)[];
  /** Options marked so far, per question (a multi-select's). */
  marks: Set<number>[];
  /** Set once it ended, with what its open cards show. */
  outcome?: string;
  settle: (answer: DialogAnswer | undefined) => void;
}

/**
 * Pets' dialogs waiting for the person, as cards in the pet's place (in memory: a restart drops the agent's
 * wait too). A dialog ends with the person's answer (buttons, or text written in the pet's place), when nobody
 * answers in time, or when the agent stops waiting (answered in its session). Every card then shows how it ended.
 */
export class Dialogs {
  private pending: Pending[] = [];
  private stopped = false;

  constructor(
    private readonly events: Pick<EventLog, "info" | "error">,
    private readonly timer: Timer = realTimer,
  ) {}

  /**
   * Shows the dialog and waits for its answer, at most `target.waitMs`, then the answer is a timeout (for a
   * permission: `unanswered`, Household refuses it). Undefined when nobody waits for an answer any more (`signal`
   * aborted, Household stopping), or when the cards could not be shown: the dialog stays in the agent's session.
   */
  async ask(target: DialogTarget, dialog: DialogQuestion, signal?: AbortSignal): Promise<DialogAnswer | undefined> {
    if (this.stopped || signal?.aborted) return undefined;
    const { waitMs } = target;
    const shown = cardsFor(target.title, dialog, waitMs);
    const { promise, resolve } = Promise.withResolvers<DialogAnswer | undefined>();
    const pending: Pending = { target, dialog, cards: [], answers: shown.map(() => undefined), marks: shown.map(() => new Set()), settle: resolve };
    const cancel = this.timer(waitMs, () => {
      if (dialog.kind === "permission") {
        return void this.finish(pending, { kind: "unanswered", waitedMs: waitMs }, "not answered in time: refused", `No answer in ${Math.round(waitMs / 1000)} s: denied`);
      }
      void this.finish(pending, { kind: "timeout", answers: [...pending.answers] }, "not answered in time", "Time to answer ran out");
    });
    const abort = () => void this.finish(pending, undefined, "answered in the terminal", "Answered in the terminal");
    pending.settle = (answer) => {
      cancel();
      signal?.removeEventListener("abort", abort);
      resolve(answer);
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.pending.push(pending);
    try {
      for (const [i, { text, choices }] of shown.entries()) {
        const card = await target.board.post(text, choices, (index) => this.press(pending, i, index));
        pending.cards[i] = card;
        if (pending.outcome !== undefined) {
          await target.board.resolve(card, pending.outcome); // it ended while this card was being posted
          return promise;
        }
      }
      this.events.info(`bot ${target.pet}: dialog shown in the chat`);
    } catch (error) {
      this.events.error(`bot ${target.pet}: the dialog could not be shown (${(error as Error).message})`);
      await this.finish(pending, undefined, "left to the terminal", "Could not be shown in full: answer in the terminal");
    }
    return promise;
  }

  /**
   * What the person wrote in pet `pet`'s place. When a dialog of the pet waits (the oldest) and a card of it is
   * open, it is the answer: to the first question not answered yet, or a plan sent back with what to change.
   * False when it answers nothing.
   */
  async text(pet: string, text: string): Promise<boolean> {
    const pending = this.pending.find((open) => open.target.pet === pet);
    if (!pending || pending.dialog.kind === "permission") return false; // a permission is a button's: text goes to the pet
    if (pending.dialog.kind === "plan") {
      await this.finish(pending, { kind: "revise", text }, "sent back with changes", `Sent back: ${quote(text, 40)}`);
      return true;
    }
    const at = pending.answers.findIndex((given, i) => given === undefined && pending.cards[i] !== undefined);
    if (at < 0) return false;
    await this.answer(pending, at, { text }, quote(text, 40));
    return true;
  }

  /** The dialog shown on `board` ends refused, `message` going to its agent and `outcome` to its open cards (its channel goes away, say). */
  async refuse(board: Board, message: string, outcome: string): Promise<void> {
    const mine = this.pending.filter((open) => open.target.board === board);
    await Promise.all(mine.map((pending) => this.finish(pending, { kind: "refused", message }, `refused (${message})`, outcome)));
  }

  /**
   * The person stopped pet `pet`: its dialogs waiting here end so (the agent's turn with them), their cards
   * "Stopped". False when none waits.
   */
  async halt(pet: string): Promise<boolean> {
    const mine = this.pending.filter((open) => open.target.pet === pet);
    await Promise.all(mine.map((pending) => this.finish(pending, { kind: "stopped" }, "stopped by the person", "Stopped")));
    return mine.length > 0;
  }

  /** Household is stopping: every dialog goes back to its agent's session, and no new one is shown. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.pending.map((pending) => this.finish(pending, undefined, "left to the terminal: Household stops", "Household stopped: answer in the terminal")));
  }

  /** A press on card `at` of a dialog. */
  private async press(pending: Pending, at: number, index: number): Promise<void> {
    const { dialog, marks, target } = pending;
    if (pending.outcome !== undefined || pending.answers[at]) return;
    if (dialog.kind === "plan") {
      if (index === 0) await this.finish(pending, { kind: "approve" }, "approved", "Approved");
      return;
    }
    if (dialog.kind === "permission") {
      if (index === 0) await this.finish(pending, { kind: "allow" }, "allowed", "Allowed");
      if (index === 1) await this.finish(pending, { kind: "deny" }, "denied", "Denied");
      return;
    }
    const question = dialog.questions[at]!;
    const option = question.options[index];
    const marked = marks[at]!;
    if (!question.multiSelect) {
      if (option) await this.answer(pending, at, { chosen: [option.label] }, option.label);
    } else if (option) {
      if (marked.has(index)) marked.delete(index);
      else marked.add(index);
      await target.board.setChoices(pending.cards[at]!, questionChoices(question, marked));
    } else if (index === question.options.length && marked.size > 0) {
      const chosen = question.options.filter((_, i) => marked.has(i)).map(({ label }) => label);
      await this.answer(pending, at, { chosen }, chosen.join(", "));
    }
  }

  private async answer(pending: Pending, at: number, answer: QuestionAnswer, outcome: string): Promise<void> {
    pending.answers[at] = answer;
    await pending.target.board.resolve(pending.cards[at]!, outcome);
    const answers = pending.answers.filter((given) => given !== undefined);
    if (answers.length === pending.answers.length) await this.finish(pending, { kind: "answers", answers }, "answered");
  }

  /** Ends a dialog once: the agent gets `answer`, and cards still open show `outcome`. */
  private async finish(pending: Pending, answer: DialogAnswer | undefined, how: string, outcome = ""): Promise<void> {
    if (pending.outcome !== undefined) return;
    pending.outcome = outcome;
    this.pending = this.pending.filter((open) => open !== pending);
    pending.settle(answer);
    this.events.info(`bot ${pending.target.pet}: dialog ${how}`);
    const open = pending.cards.filter((card, i) => card !== undefined && pending.answers[i] === undefined);
    await Promise.all(open.map((card) => pending.target.board.resolve(card!, outcome)));
  }
}
