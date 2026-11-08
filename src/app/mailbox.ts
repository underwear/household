import type { AgentAdapter } from "../core/agent";
import { CLOCK, type Clock } from "../core/clock";
import { PetInbox } from "../core/inbox";
import type { Message } from "../core/message";
import { Backoff } from "./backoff";
import { TokenBucket } from "./token-bucket";

export interface DeliveryTiming {
  /** First wait before a refused message is tried again; doubles up to a minute. */
  retryMs: number;
  /** First wait before an open dialog is looked for on screen; doubles up to a minute. */
  watchMs: number;
  /** A pet's events beyond this rate (burst: ten seconds' worth) are dropped, and counted in one line per period. */
  eventsPerSecond: number;
  reportMs: number;
  /**
   * New messages in a row go to the pet as one batch: once their place has been quiet this long, or as soon as
   * there are `batchMax` of them. Kept short: every message waits it.
   */
  batchMs: number;
  batchMax: number;
}

export const TIMING: DeliveryTiming = { retryMs: 3_000, watchMs: 5_000, eventsPerSecond: 20, reportMs: 10_000, batchMs: 1_200, batchMax: 25 };

const MAX_WAIT_MS = 60_000;

/** One pet's side of Delivery: its inbox, the messages it has, timers and its event budget. */
export class Mailbox {
  readonly inbox = new PetInbox();
  /** Delivered, not answered yet. */
  awaiting: Message[] = [];
  /** Scheduled prompts actually accepted by the agent, correlated to their native turn. */
  readonly cronTurns = new Map<number, string | undefined>();
  /** Being typed into the agent right now: an edit can no longer change them. */
  sending: Message[] = [];
  /** Batches typed (or being typed), oldest first, as their text, until the agent says it took them. */
  typed: { text: string; messages: Message[] }[] = [];
  /** When a message last arrived (the clock's time; never, for one from before a restart): a batch waits for quiet. */
  private lastQueued = -Infinity;
  readonly retry: Backoff;
  readonly watch: Backoff;
  flushing = false;
  /** Messages whose files are being fetched, by id: one fetch each at a time. */
  readonly fetching = new Map<number, Promise<void>>();
  memoryRevision?: number | string;
  memoryEpoch = 0;
  /** The last refusal logged, so a pet that keeps refusing gives one line, not one per retry. */
  refusal?: string;
  /** Bumped on every dialog opened, so a screen look that started before it cannot close it. */
  dialogs = 0;
  /** Dialogs put to the person and not answered yet, oldest first; the newest is the one on the agent's screen. */
  readonly asking: AbortController[] = [];
  private readonly events: TokenBucket;
  private dropped = 0;
  private report?: ReturnType<typeof setTimeout>;
  private cancelBatch?: () => void;

  /** Where this session’s own home is mounted inside its VM. */
  home: string;

  constructor(
    public agent: AgentAdapter,
    private readonly timing: DeliveryTiming,
    /** Told, once per report period, how many events were dropped in it. */
    private readonly onDropped: (count: number) => void,
    private readonly clock: Clock = CLOCK,
  ) {
    this.home = agent.home;
    this.retry = new Backoff(timing.retryMs, MAX_WAIT_MS);
    this.watch = new Backoff(timing.watchMs, MAX_WAIT_MS);
    this.events = new TokenBucket(timing.eventsPerSecond, timing.eventsPerSecond * 10);
  }

  /** Whether an event of the pet is taken; beyond its rate it is dropped and counted. A vital one is always taken (and counts). */
  admit(vital = false): boolean {
    if (this.events.take() || vital) return true;
    this.dropped += 1;
    this.report ??= setTimeout(() => {
      this.onDropped(this.dropped);
      this.dropped = 0;
      this.report = undefined;
    }, this.timing.reportMs);
    return false;
  }

  /** A message that arrives now. */
  queue(message: Message): void {
    this.inbox.push(message);
    this.lastQueued = this.clock.now();
  }

  /** A waiting message changes (edited); a batch it is in waits for quiet again. False when it is not waiting. */
  replace(id: number, text: string): boolean {
    if (!this.inbox.replace(id, text)) return false;
    this.lastQueued = this.clock.now();
    return true;
  }

  /** How long a batch still waits for its place to be quiet; 0 when it need not. */
  quietLeft(): number {
    return Math.max(0, this.lastQueued + this.timing.batchMs - this.clock.now());
  }

  /** Runs `flush` once the batch's quiet window is over (one wait at a time: a new one replaces it). */
  awaitQuiet(flush: () => void): void {
    this.cancelBatch?.();
    this.cancelBatch = this.clock.after(this.quietLeft(), flush);
  }

  close(): void {
    this.retry.cancel();
    this.watch.cancel();
    this.cancelBatch?.();
    clearTimeout(this.report);
  }
}
