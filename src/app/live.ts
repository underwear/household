import type { DialogKind, ToolAction, TurnProgress } from "../core/agent-events";
import { RateLimited, StatusGone, type Channel, type Place, type PostRef, type StatusView } from "../core/channel";
import { CLOCK, type Clock } from "../core/clock";
import type { DialogQuestion } from "../core/dialog";

export interface LiveTiming {
  /** Status calls through one chat, whatever the turn, at most this often. */
  chatGapMs: number;
}

export const LIVE_TIMING: LiveTiming = { chatGapMs: 1_000 };

/** After a failure that is no rate limit, the chat is let be this long. */
const BACKOFF_MS = 3_000;

/** Where a live message goes: a pet's place in an open channel. */
export interface LiveSpot {
  channel: Channel;
  place: Place;
}

/** Where a place is now, for live messages there: the open channel, and whether the pet is still in it. */
export interface Whereabouts {
  channel?: Channel;
  placed: boolean;
}

/** Why a turn did not finish: the person stopped it, it failed, or something else ended it. */
export type Lost = "stopped" | "failed" | "other";

/** What the pet waits for while a dialog of each kind is open. */
const WAITS: Record<DialogKind, string> = { permission: "Waiting for permission", question: "Waiting for an answer", plan: "Waiting for approval", form: "Waiting for an answer", unknown: "Waiting for an answer" };

/** The stop button's label. */
export const STOP = "Stop";

/** What a tool call does, as the person reads it (the chat's words: English). */
export function describe(action: ToolAction | undefined, tool: string): string {
  const { target, says } = action ?? {};
  switch (action?.kind) {
    case "read":
      return `Reading ${target ?? "a file"}`;
    case "write":
      return `Creating ${target ?? "a file"}`;
    case "edit":
      return `Editing ${target ?? "a file"}`;
    case "run":
      return says ?? (target ? `Running ${target}` : "Running a command");
    case "search":
      return target ? `Searching for "${target}"` : "Searching";
    case "fetch":
      return target ? `Opening ${target}` : "Opening a page";
    case "delegate":
      return says ? `Delegating: ${says}` : "Delegating a task";
    case "ask":
      return "Asking";
    case "plan":
      return "Proposing a plan";
    default:
      return target ?? tool;
  }
}

/** A tool call going on: what it does, its tool, and its fingerprint (a dialog finds its call by it). */
interface Step {
  name: string;
  tool: string;
  input?: string;
  call?: string;
}

/** A dialog of the agent's that waits, and its call when one matches. */
interface Waiting {
  kind: DialogKind;
  input?: string;
  step?: Step;
}

/** One chat's status calls: the wait it asked for, and the last call. */
interface Lane {
  blockedUntil: number;
  lastCall: number;
}

/** One pet turn (a prompt and the agent's own prompts that continue it) as its live message shows it. */
export class LiveTurn {
  readonly turns = new Set<string>();
  /** Calls going on, by call id; the last one shown; how many were shown. */
  readonly open = new Map<string, Step>();
  last?: Step;
  /** Native decisions by review id, retained after a call finishes for late outcomes. */
  readonly reviews = new Map<string, Extract<TurnProgress, { kind: "tool-review" }>>();
  /** Display segments change after outward messages; the logical turn and action count stay. */
  segmentActive = false;
  retiring = false;
  readonly calls = new Set<string>();
  readonly retiredCalls = new Set<string>();
  readonly retiredReviews = new Set<string>();
  count = 0;
  waits: Waiting[] = [];
  state: "working" | "done" | "interrupted" = "working";
  why?: Lost;
  ref?: PostRef;
  /** What the post shows now (to edit only when that changes). */
  shown?: string;
  /** A post, an edit or a delete is under way. */
  busy = false;
  /** Deletes that failed. */
  drops = 0;
  /** The post is done with (shown for the last time, deleted, or it can never change). */
  settled = false;
  gone = false;
  timer?: { at: number; cancel: () => void };
  typing?: { controller: AbortController; cancel?: () => void };

  constructor(
    readonly house: string,
    readonly pet: string,
    turn: string | undefined,
    /** Undefined: a turn shown nowhere (on a CLI message). */
    public spot: LiveSpot | undefined,
  ) {
    if (turn !== undefined) this.turns.add(turn);
  }
}

/** A pet's turn going on, and those typed while it went on (the agent queued them), oldest first. */
interface PetTurns {
  current?: LiveTurn;
  queued: LiveTurn[];
}

/**
 * The live message: one status post per segment of a pet turn, in the place the turn answers: one line,
 * what the agent does now ("⏳ Reading auth.php…", or what it waits for: "Waiting for permission: …"), with a stop button.
 * It is posted with the first action shown (a turn that only answers gets none) and edited only when that line
 * changes; a successfully posted outward message retires it, and the next tool starts a fresh post below that
 * message. When the turn finishes it is deleted. A turn that did not finish keeps one
 * line: "Stopped at action N", "Interrupted · error", "Interrupted". Calls through one chat go `chatGapMs`
 * apart, none while it asks to wait (a 429) or for a moment after any other failure. Live posts are no chat
 * messages and are not kept over a restart. Every failed call is one line in the log.
 *
 * Turns: the agent's own prompts (a background task's news) continue the turn going on; a message typed while it
 * goes on (queued by the agent) is a turn of its own, which starts with its first event or the end of the one
 * before (after a stop: only with its own first event).
 */
export class Live {
  private readonly pets = new Map<string, PetTurns>();
  /** Turns over whose post is still to be changed or deleted. */
  private readonly closing = new Set<LiveTurn>();
  private readonly lanes = new WeakMap<Channel, Lane>();
  /** Posts not done with, by ref: their turn (a press on one is the live message's). */
  private readonly owned = new Map<PostRef, LiveTurn>();
  private stopped = false;

  constructor(
    private readonly log: { error(message: string): void },
    private readonly timing: LiveTiming = LIVE_TIMING,
    private readonly clock: Clock = CLOCK,
  ) {}

  /**
   * The agent took a prompt of Household's messages: turn `turn`, answering in `spot` (none: shown nowhere). One
   * already going on goes on: this one starts once it is over, or with this one's first event.
   */
  start(house: string, pet: string, turn: string | undefined, spot: LiveSpot | undefined): void {
    if (this.stopped) return;
    const turns = this.turnsOf(house, pet);
    if (turn !== undefined && [turns.current, ...turns.queued].some((live) => live?.turns.has(turn))) return;
    const live = new LiveTurn(house, pet, turn, spot);
    if (turns.current?.state === "working") turns.queued.push(live);
    else {
      turns.current = live;
      this.startTyping(live);
    }
  }

  /** The agent took a prompt of its own (no message of Household's): it continues the turn going on. */
  continued(house: string, pet: string, turn: string | undefined): void {
    const current = this.pets.get(key(house, pet))?.current;
    if (current && turn !== undefined) current.turns.add(turn);
  }

  /** The pet's turn going on, if any: what a stop takes before it asks the agent. */
  turnOf(house: string, pet: string): LiveTurn | undefined {
    const current = this.pets.get(key(house, pet))?.current;
    return current?.state === "working" ? current : undefined;
  }

  /** The turn a post (not done with) is of; undefined for any other post. */
  owns(ref: PostRef): LiveTurn | undefined {
    return this.owned.get(ref);
  }

  /**
   * The person stopped `live`: "Stopped at action N", if it was still going on (those queued behind it
   * start with their own first event). True when that line will show (it has a post).
   */
  halt(live: LiveTurn): boolean {
    if (live.state !== "working") return false;
    this.close(live, "interrupted", "stopped", false);
    return !live.retiring && !live.gone && (live.ref !== undefined || live.busy);
  }

  /** `live` turned out to be over already (a stop found the agent idle): finished, its post goes. */
  ended(live: LiveTurn): void {
    this.close(live, "done", undefined, false);
  }

  /** A successfully posted message retires only the status of the captured turn in that same place. */
  replied(live: LiveTurn | undefined, spot: LiveSpot): void {
    if (!live || this.stopped || live !== this.turnOf(live.house, live.pet) || live.spot?.channel !== spot.channel || live.spot.place.id !== spot.place.id) return;
    live.segmentActive = false;
    for (const call of live.calls) live.retiredCalls.add(call);
    for (const review of live.reviews.keys()) live.retiredReviews.add(review);
    live.reviews.clear();
    live.last = undefined;
    live.timer?.cancel();
    live.timer = undefined;
    // Keep open calls and dialog waits for their eventual finish/answer. A pending post/edit
    // still belongs to the old segment and must finish before its deletion can start.
    live.retiring = live.ref !== undefined || live.busy;
    if (!live.retiring) this.resetPost(live);
    this.plan(live);
  }

  private resetPost(live: LiveTurn): void {
    if (live.ref) this.owned.delete(live.ref);
    live.ref = undefined;
    live.shown = undefined;
    live.drops = 0;
    live.gone = false;
    live.retiring = false;
  }

  /** A step; one of a turn not known, or of a subagent, or the agent's plumbing, is not shown. */
  progress(house: string, pet: string, event: TurnProgress): void {
    const live = this.route(house, pet, event.turn);
    if (!live || live.state !== "working" || event.agent !== undefined) return;
    if (event.kind === "tool-review") {
      if (live.retiredReviews.has(event.review) || (event.call && live.retiredCalls.has(event.call))) return;
      const previous = live.reviews.get(event.review);
      // Late starts and duplicate packets cannot erase a completed decision or change its target.
      if (previous && (previous.call !== event.call || previous.status !== "inProgress")) return;
      live.reviews.set(event.review, event);
      if ((event.call && live.calls.has(event.call)) || ["denied", "timedOut", "aborted"].includes(event.status)) live.segmentActive = true;
      return this.plan(live);
    }
    if (event.kind === "tool-started") {
      if (event.internal || (event.call && live.retiredCalls.has(event.call))) return;
      if (event.call) live.calls.add(event.call);
      live.segmentActive = true;
      const step: Step = { name: describe(event.action, event.tool), tool: event.tool, ...(event.call ? { call: event.call } : {}), ...(event.input ? { input: event.input } : {}) };
      live.open.set(event.call ?? `${event.tool}:${live.count}`, step);
      live.last = step;
      live.count += 1;
      return this.plan(live);
    }
    // Without call ids, the last call of that tool still going.
    const id = event.call ?? [...live.open].findLast(([, step]) => step.tool === event.tool)?.[0];
    const step = id === undefined ? undefined : live.open.get(id);
    if (!step) return;
    live.open.delete(id!);
    live.waits = live.waits.filter((waiting) => waiting.step !== step);
    this.plan(live);
  }

  /** A dialog of the agent's opened: the line says what the pet waits for, and on which call (by `input`), when one matches. */
  dialogOpened(house: string, pet: string, kind: DialogKind, input?: string): void {
    const live = this.pets.get(key(house, pet))?.current;
    if (!live || live.state !== "working") return;
    if (input !== undefined && live.waits.some((waiting) => waiting.input === input)) return; // the same one, told twice
    const taken = new Set(live.waits.map((waiting) => waiting.step));
    const step = input === undefined ? undefined : [...live.open.values()].findLast((each) => each.input === input && !taken.has(each));
    live.waits.push({ kind, ...(input === undefined ? {} : { input }), ...(step ? { step } : {}) });
    this.plan(live);
  }

  /** The pet has no dialog open any more, as far as its activity goes: those without a call go (the others go with their call). */
  dialogClosed(house: string, pet: string): void {
    const live = this.pets.get(key(house, pet))?.current;
    if (!live) return;
    live.waits = live.waits.filter((waiting) => waiting.step !== undefined);
    this.plan(live);
  }

  /** A dialog was answered here (or given up on): the line goes back to what the pet does. */
  decided(house: string, pet: string, dialog: DialogQuestion): void {
    const live = this.pets.get(key(house, pet))?.current;
    const at = live?.waits.findIndex((waiting) => (dialog.input === undefined ? waiting.step === undefined : waiting.input === dialog.input)) ?? -1;
    if (!live || at < 0) return;
    live.waits.splice(at, 1);
    this.plan(live);
  }

  /** Turn `turn` finished (none named: the one going on): its post goes; the next queued one starts. */
  finish(house: string, pet: string, turn?: string): void {
    const live = this.route(house, pet, turn);
    if (live) this.close(live, "done");
  }

  /** A turn will not finish: the one named, or (none named) every one going on or queued. */
  lost(house: string, pet: string, why: Lost, turn?: string): void {
    const turns = this.pets.get(key(house, pet));
    if (!turns) return;
    if (turn !== undefined) {
      const queued = turns.queued.findIndex((live) => live.turns.has(turn));
      if (queued >= 0) return void turns.queued.splice(queued, 1);
      if (turns.current?.turns.has(turn)) this.close(turns.current, "interrupted", why);
      return;
    }
    turns.queued = [];
    if (turns.current) this.close(turns.current, "interrupted", why);
  }

  /**
   * Follows a reload: turns whose pet left the place or whose channel was reopened are over (their last line goes
   * through the channel open now, never a stopped one); one whose channel is not open now is let go.
   */
  sync(where: (house: string, pet: string, place: string) => Whereabouts): void {
    if (this.stopped) return;
    for (const live of this.all()) {
      if (!live.spot) continue;
      const now = where(live.house, live.pet, live.spot.place.id);
      if (!now.channel) {
        this.settle(live);
        continue;
      }
      const reopened = now.channel !== live.spot.channel;
      live.spot = { ...live.spot, channel: now.channel };
      if (reopened || !now.placed) this.close(live, "interrupted", "other");
    }
  }

  /** Timers stop; posts stay as they are. */
  stop(): void {
    this.stopped = true;
    for (const live of this.all()) {
      live.timer?.cancel();
      this.stopTyping(live);
    }
    this.pets.clear();
    this.closing.clear();
    this.owned.clear();
  }

  /** Telegram expires typing after five seconds; refresh even when no tool events arrive. */
  private startTyping(live: LiveTurn): void {
    if (live.typing || live.settled || live.state !== "working" || this.stopped || !live.spot?.channel.typing) return;
    const { channel, place } = live.spot;
    const typing = live.typing = { controller: new AbortController(), cancel: undefined as (() => void) | undefined };
    const pulse = async () => {
      if (typing.controller.signal.aborted) return;
      let delay = 4_000;
      try {
        await channel.typing!(place, typing.controller.signal);
      } catch (error) {
        if (typing.controller.signal.aborted) return;
        this.log.error(`pet ${live.house}/${live.pet}: typing not sent: ${(error as Error).message}`);
        if (error instanceof StatusGone) return;
        if (error instanceof RateLimited) delay = Math.max(delay, error.retryAfterMs);
      }
      if (!typing.controller.signal.aborted) typing.cancel = this.clock.after(delay, () => void pulse());
    };
    void pulse();
  }

  private stopTyping(live: LiveTurn): void {
    live.typing?.controller.abort();
    live.typing?.cancel?.();
    live.typing = undefined;
  }

  private turnsOf(house: string, pet: string): PetTurns {
    const name = key(house, pet);
    if (!this.pets.has(name)) this.pets.set(name, { queued: [] });
    return this.pets.get(name)!;
  }

  private all(): LiveTurn[] {
    const turns = [...this.pets.values()].flatMap(({ current, queued }) => [...(current ? [current] : []), ...queued]);
    return [...turns, ...this.closing];
  }

  /**
   * The turn an event of turn `turn` is for: the one going on (none named: that one), or a queued one, which
   * starts now (the one going on did not finish, and those queued before it are not coming).
   */
  private route(house: string, pet: string, turn: string | undefined): LiveTurn | undefined {
    const turns = this.pets.get(key(house, pet));
    if (!turns) return undefined;
    if (turn === undefined || turns.current?.turns.has(turn)) return turns.current;
    const at = turns.queued.findIndex((live) => live.turns.has(turn));
    if (at < 0) return undefined;
    const [next] = turns.queued.splice(0, at + 1).slice(-1) as [LiveTurn];
    const before = turns.current;
    turns.current = next;
    this.startTyping(next);
    if (before) this.close(before, "interrupted", "other");
    return next;
  }

  /** The turn is over: its post goes or shows its last line; the next queued turn starts now (`promote`), or with its own first event. */
  private close(live: LiveTurn, state: "done" | "interrupted", why?: Lost, promote = true): void {
    if (live.state !== "working") return;
    live.state = state;
    this.stopTyping(live);
    if (why) live.why = why;
    const turns = this.pets.get(key(live.house, live.pet));
    if (turns?.current === live) turns.current = promote ? turns.queued.shift() : undefined;
    else if (turns) turns.queued = turns.queued.filter((queued) => queued !== live);
    if (turns?.current) this.startTyping(turns.current);
    if (!live.ref && !live.busy) return this.settle(live); // nothing was shown, nothing will be
    this.closing.add(live);
    this.plan(live);
  }

  /** Done with: forgotten here. */
  private settle(live: LiveTurn): void {
    this.stopTyping(live);
    live.timer?.cancel();
    live.timer = undefined;
    live.settled = true;
    this.closing.delete(live);
    if (live.ref) this.owned.delete(live.ref);
    const turns = this.pets.get(key(live.house, live.pet));
    if (turns?.current === live) turns.current = undefined;
    if (turns) turns.queued = turns.queued.filter((queued) => queued !== live);
  }

  /** What the post shows: the working line, or one line on a turn that did not finish. */
  private view(live: LiveTurn): StatusView {
    if (live.state === "working") {
      const waiting = live.waits.at(-1);
      const on = waiting?.step ?? (waiting ? undefined : live.last);
      // Its own dots off, so the line never ends in two.
      const name = on ? on.name.replace(/[.…\s]+$/u, "") : "";
      const decisions = [...live.reviews.values()];
      const related = on?.call ? decisions.filter(review => review.call === on.call) : [];
      // Multiple execve reviews can concern one command. Any denial remains visible even if
      // another review approves; a pending review must not produce a premature approval badge.
      const priority = ["denied", "timedOut", "aborted", "inProgress", "approved"] as const;
      const status = priority.find(status => related.some(review => review.status === status));
      const labels = { approved: "approved", denied: "denied", timedOut: "no answer", aborted: "aborted", inProgress: "in progress" };
      const icons = { approved: "✅", denied: "⛔", timedOut: "⚠️", aborted: "⚠️", inProgress: "⏳" };
      const scopes = [...new Set(related.filter(review => review.status === status && review.scope && review.scope !== "command").map(review => review.scope))];
      const badge = status ? `Review${scopes.length ? ` (${scopes.join(", ")})` : ""}: ${labels[status]} ${icons[status]}` : undefined;
      const line = waiting ? [WAITS[waiting.kind], name].filter(Boolean).join(": ") : name ? `${name}…` : "";
      // Unmatched negative outcomes stay explicit, without suggesting that the current command
      // was reviewed. Missing-target approvals are never attached to an unrelated action.
      const negative = decisions.filter(review => (!on?.call || review.call !== on.call) && ["denied", "timedOut", "aborted"].includes(review.status));
      const other = [...new Set(negative.map(review => `Review (${review.scope ?? "action"}): ${labels[review.status]} ${icons[review.status]}`))].join("\n\n");
      return { state: "working", line: [line, badge, other].filter(Boolean).join("\n\n"), stop: STOP };
    }
    const title = { stopped: `Stopped at action ${live.count}`, failed: "Interrupted · error", other: "Interrupted" }[live.why ?? "other"];
    return { state: "over", title };
  }

  private lane(channel: Channel): Lane {
    if (!this.lanes.has(channel)) this.lanes.set(channel, { blockedUntil: -Infinity, lastCall: -Infinity });
    return this.lanes.get(channel)!;
  }

  /** The next call of the turn, when it has something new to show (a post waits for its first action). */
  private plan(live: LiveTurn): void {
    if (live.busy || live.settled || (live.gone && !live.retiring) || this.stopped || !live.spot) return;
    if (!live.ref && (live.state !== "working" || !live.segmentActive)) return;
    if (!live.retiring && live.state === "working" && live.shown === JSON.stringify(this.view(live))) return; // nothing new
    const lane = this.lane(live.spot.channel);
    const now = this.clock.now();
    const at = Math.max(lane.blockedUntil, lane.lastCall + this.timing.chatGapMs, now);
    if (live.timer && live.timer.at <= at) return;
    live.timer?.cancel();
    const cancel = this.clock.after(at - now, () => {
      live.timer = undefined;
      void this.show(live);
    });
    live.timer = { at, cancel };
  }

  /** One post, edit or delete, then the next if something changed meanwhile. */
  private async show(live: LiveTurn): Promise<void> {
    if (live.busy || live.settled || this.stopped || !live.spot) return;
    const { channel, place } = live.spot;
    const lane = this.lane(channel);
    if (Math.max(lane.blockedUntil, lane.lastCall + this.timing.chatGapMs) > this.clock.now()) return this.plan(live); // the chat was used meanwhile
    const name = `pet ${live.house}/${live.pet}`;
    if ((live.state === "done" || live.retiring) && live.ref) {
      live.busy = true;
      lane.lastCall = this.clock.now();
      const over = await this.drop(live, channel, lane);
      live.busy = false;
      if (!over) return this.plan(live);
      if (!live.retiring) return this.settle(live);
      this.resetPost(live);
      if (live.state !== "working") return this.settle(live);
      return this.plan(live);
    }
    const view = this.view(live);
    const text = JSON.stringify(view);
    if (live.state === "working" && live.shown === text) return;
    live.busy = true;
    lane.lastCall = this.clock.now();
    try {
      if (live.ref) {
        await channel.editStatus(live.ref, view);
      } else {
        live.ref = await channel.postStatus(place, view);
        this.owned.set(live.ref, live);
      }
      live.shown = text;
      if (live.state !== "working" && !live.retiring) live.settled = true;
    } catch (error) {
      if (error instanceof StatusGone) live.gone = true;
      lane.blockedUntil = this.clock.now() + (error instanceof RateLimited ? error.retryAfterMs : BACKOFF_MS);
      this.log.error(`${name}: live message not ${live.ref ? "updated" : "posted"}: ${(error as Error).message}${live.gone ? "; given up" : ""}`);
    } finally {
      live.busy = false;
    }
    if (live.retiring && !live.ref) this.resetPost(live);
    if (live.settled || (live.gone && live.state !== "working")) return this.settle(live);
    this.plan(live);
  }

  /**
   * Deletes a finished turn's post; one that fails is tried once more, then left as a plain line without the
   * button if it can be (else as it is). True once done with.
   */
  private async drop(live: LiveTurn, channel: Channel, lane: Lane): Promise<boolean> {
    try {
      await channel.dropStatus(live.ref!);
      return true;
    } catch (error) {
      lane.blockedUntil = this.clock.now() + (error instanceof RateLimited ? error.retryAfterMs : BACKOFF_MS);
      const last = ++live.drops >= 2;
      this.log.error(`pet ${live.house}/${live.pet}: live message not removed: ${(error as Error).message}${last ? "; left without its button" : ""}`);
      if (last) await channel.editStatus(live.ref!, { state: "over", title: "Done" }).catch(() => {});
      return last;
    }
  }
}

const key = (house: string, pet: string) => `${house}/${pet}`;
