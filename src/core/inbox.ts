import type { AgentEvent } from "./agent-events";
import { batchable, joins, type Message } from "./message";

/** idle: waits for input. busy: working (pasting is fine, the agent queues it). dialog: pasting would answer it. */
export type Activity = "idle" | "busy" | "dialog";

/**
 * What to hand out next: one message, or several that go as one (a batch, see `joins`). `complete`: nothing
 * more may join it (it is full, something else waits behind it, or a boundary closed it); otherwise the next
 * message to arrive still might.
 */
export interface Next {
  messages: Message[];
  complete: boolean;
  digest?: boolean;
}

/**
 * A pet's activity, followed from its events, and the messages waiting for it. Messages may be handed out
 * whenever no dialog is open: text pasted into a dialog is lost and its Enter answers the dialog. A dialog
 * closes only on `dialog-closed`: other events may come from the agent's background work while it waits.
 */
export class PetInbox {
  private current: Activity = "idle";
  private readonly waiting: Message[] = [];
  /** Ids of messages no later one may join: boundaries the queue does not show (`close`). */
  private readonly closed = new Set<number>();
  private readonly catchup = new Set<number>();

  get activity(): Activity {
    return this.current;
  }

  get size(): number {
    return this.waiting.length;
  }

  /**
   * Updates the activity; false when the event changes nothing worth recording: a dialog closing while none
   * is open (adapters close on every turn end), or opening while one already is (agents may report it twice).
   */
  observe(event: AgentEvent): boolean {
    if (event.kind === "dialog-closed" && this.current !== "dialog") return false;
    if (event.kind === "dialog-opened" && this.current === "dialog") return false;
    this.current = next(this.current, event);
    return true;
  }

  /** The agent was stopped (no event says so): it waits for input, no dialog open. */
  stopped(): void {
    this.current = "idle";
  }

  push(message: Message, catchup = false): void {
    this.waiting.push(message);
    if (catchup && message.origin === "inbox") this.catchup.add(message.id);
  }

  /** Pending external events accumulated while delivery was unavailable. */
  markInboxCatchup(): void {
    for (const message of this.waiting) if (message.origin === "inbox") this.catchup.add(message.id);
  }

  /**
   * The messages to deliver now, together: the first waiting one, and those right behind it that join it, at
   * most `max`. None while a dialog is open. They stay queued until `delivered()`.
   */
  next(max: number): Next {
    const { waiting, closed } = this;
    const first = waiting[0];
    if (this.current === "dialog" || !first || ((first.origin === "cron" || first.origin === "inbox") && this.current !== "idle")) return { messages: [], complete: true };
    if (first.origin === "inbox" && this.catchup.has(first.id) && first.header && first.place) {
      const messages: Message[] = [];
      const groups = new Set<string>();
      for (const message of waiting) {
        if (message.origin !== "inbox" || !message.header || message.place !== first.place || messages.length >= 500) break;
        const group = String(message.header.channel.meta?.inbox ?? message.header.from.id);
        if (!groups.has(group) && groups.size >= 30) break;
        groups.add(group); messages.push(message);
        if (closed.has(message.id)) break;
      }
      return { messages, complete: true, digest: true };
    }
    const ends = (i: number) => closed.has(waiting[i]!.id); // a boundary right after message i
    let count = 1;
    while (count < max && count < waiting.length && !ends(count - 1) && joins(first, waiting[count]!)) count += 1;
    // Nothing more can join: it is full, something else waits behind it, a boundary closed it, or it is no batch.
    const blocked = count === max || count < waiting.length || ends(count - 1) || !batchable(first);
    return { messages: waiting.slice(0, count), complete: blocked };
  }

  /** What waits now goes on its own, joined by nothing that comes later (e.g. after a message that was refused). */
  close(): void {
    const last = this.waiting.at(-1);
    if (last) this.closed.add(last.id);
  }

  /** The first `count` waiting messages were handed out. */
  delivered(count = 1): void {
    for (const { id } of this.waiting.splice(0, count)) { this.closed.delete(id); this.catchup.delete(id); }
  }

  /** Changes the text of a message still waiting; false when it is not waiting (any more). */
  replace(id: number, text: string): boolean {
    const message = this.waiting.find((waiting) => waiting.id === id);
    if (message) message.text = text;
    return message !== undefined;
  }
}

function next(current: Activity, event: AgentEvent): Activity {
  if (event.kind === "dialog-opened") return "dialog";
  if (event.kind === "dialog-closed") return "busy";
  // A session that goes on (compacted mid-turn) is as busy as it was.
  if (current === "dialog" || event.kind === "notification" || event.kind === "tool-review") return current;
  if (event.kind === "session-started" && event.continues) return current;
  return ["session-started", "turn-finished", "turn-failed"].includes(event.kind) ? "idle" : "busy";
}
