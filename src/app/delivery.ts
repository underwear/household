import { inboxDigest } from "../core/inbox-digest";
import { effectivePetHome } from "../core/household";
import { fetched } from "../core/attachment";
import { block, CLOCK_TAG, tagFreeJson } from "../core/tags";
import type { Exec, SendResult } from "../core/agent";
import type { AgentEvent, DialogKind, TurnProgress } from "../core/agent-events";
import type { DialogAnswer, DialogQuestion } from "../core/dialog";
import { HouseholdError } from "../core/errors";
import type { Activity } from "../core/inbox";
import { promptText, type Message, type MessageDraft, type MessageStatus } from "../core/message";
import type { EventLog } from "../infra/event-log";
import type { MessageStore } from "../infra/sqlite-store";
import type { PlacedPet } from "./agents";
import type { AttachmentFetcher } from "./attachments";
import { CLOCK, type Clock } from "../core/clock";
import { Mailbox, TIMING } from "./mailbox";


/**
 * What happened to a pet's messages, for whoever relays them to the person. `delivered`: handed to the pet
 * together (one message, or a batch). `failed`: `stuck` when they were typed but not submitted, `interrupted`
 * when they were with the pet as Household restarted. `turn-started`: the agent took a prompt: the messages
 * Household typed that it is (none: the agent's own, e.g. a background task's news); a turn that was going on
 * and did not finish is over. `progress`: what it does in its turn. `turn-finished`: the pet is done with what it
 * had (whether it replied is its own business). `turn-lost`: a turn will not finish: the one named failed
 * (`failed`), or whatever was going on ended with the agent's session (`session`: it started anew, restarted).
 * `dialog`: a dialog of the agent's opened (its kind, the fingerprint of the call it asks about) — also one more
 * while another is open — or the pet has none open any more (no kind).
 */
export type DeliveryUpdate =
  | { kind: "delivered"; house: string; pet: string; messages: Message[] }
  | { kind: "failed"; house: string; pet: string; messages: Message[]; why: "stuck" | "interrupted" }
  | { kind: "turn-started"; house: string; pet: string; turn?: string; messages: Message[] }
  | { kind: "progress"; house: string; pet: string; event: TurnProgress }
  | { kind: "notification"; house: string; pet: string; text: string }
  | { kind: "dialog"; house: string; pet: string; dialog?: DialogKind; input?: string }
  | { kind: "turn-finished"; house: string; pet: string; turn?: string }
  | { kind: "turn-lost"; house: string; pet: string; why: "failed" | "session"; turn?: string };

/** Events never dropped over a pet's event rate: what turns and dialogs hang on. */
const VITAL: AgentEvent["kind"][] = ["prompt-accepted", "turn-finished", "turn-failed", "session-started", "dialog-opened"];

/** A message with files not fetched yet: the pet gets it once they are (or once they failed). */
const unfetched = (message: Message) => message.attachments?.some((attachment) => !fetched(attachment)) ?? false;

/** A prompt as the agent reports it, compared with what was typed: control characters gone, spaces collapsed. */
const sameText = (typed: string, accepted: string) => {
  const plain = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  return plain(typed) === plain(accepted);
};

/**
 * Puts a pet's dialog to its person; resolves to their answer, or undefined when it stays in the pet's session.
 * `signal` aborts when the agent stops waiting.
 */
export type AskPerson = (house: string, pet: string, dialog: DialogQuestion, signal?: AbortSignal) => Promise<DialogAnswer | undefined>;

/**
 * Messages to pets and what pets report back. Each pet has an inbox; its agent's events move the pet between
 * idle, busy and dialog, and queued messages go out whenever no dialog is open. New messages the person sends in
 * a row (same place) go as one batch, once the place has been quiet for a moment or the batch is full; anything
 * else in the queue ends a batch and goes on its own. A dialog that closes without the agent saying so
 * (dismissed with Esc) is noticed by looking at the screen now and then. Every message and its status is in the
 * store, so a restart redelivers what was still queued (as one batch, if it was one). The files a message came
 * with are fetched into the pet's home as it is queued (or, after a restart, as it is due): it waits for them,
 * and so do the messages behind it, never the channel.
 */
export class Delivery {
  private readonly boxes = new Map<string, Mailbox>();
  private readonly suspended = new Set<string>();
  private readonly restarting = new Map<string, (event: AgentEvent) => void>();

  constructor(
    private readonly events: EventLog,
    private readonly execIn: (house: string, pet: string) => Exec,
    private readonly store: MessageStore,
    private readonly report: (update: DeliveryUpdate) => void,
    private readonly askPerson: AskPerson,
    private readonly timing = TIMING,
    private readonly clock: Clock = CLOCK,
    private readonly timezone?: () => string,
    /** What a pet keeps being told (its core memory, the house's scouts): sent with a message whenever its revision changed, and again in each new session. */
    private readonly memoryContext?: (house: string, pet: string) => { revision: number | string; text: string },
    private readonly attachments?: Pick<AttachmentFetcher, "fetch">,
    /** Presentation/log filtering must never rewrite protocol payloads or inbox correlation. */
    private readonly sanitizeEvent?: (house: string, pet: string, event: AgentEvent) => AgentEvent,
  ) {}

  /**
   * Follows the configured pets; inboxes of pets that stay keep their messages. A pet new to this run gets its
   * queued messages back from the store. Those it had been given before are not typed again (a duplicate is
   * worse than asking the person to repeat): they fail as interrupted. Retained inboxes use the pet's current
   * adapter, including when a reload changes its agent.
   */
  setPets(pets: PlacedPet[]): void {
    for (const pet of pets) if (pet.enabled === false) this.suspended.add(key(pet.house, pet.pet));
    const wanted = new Map(pets.map((pet) => [key(pet.house, pet.pet), pet]));
    for (const [name, box] of this.boxes) {
      if (wanted.has(name)) continue;
      box.close();
      this.boxes.delete(name);
      this.suspended.delete(name);
    }
    for (const [name, placed] of wanted) {
      const { house, pet, agent } = placed;
      const home = effectivePetHome(placed, agent.home);
      const existing = this.boxes.get(name);
      if (existing) {
        existing.agent = agent;
        existing.home = home;
        continue;
      }
      const onDropped = (count: number) => this.events.error(`bot ${house}/${pet}: dropped ${count} events over ${this.timing.eventsPerSecond}/s`);
      const box = new Mailbox(agent, this.timing, onDropped, this.clock);
      box.home = home;
      this.boxes.set(name, box);
      const unfinished = this.store.unfinished(house, pet);
      for (const message of unfinished) if (message.origin === "inbox" && message.status !== "received") this.mark(message, "received");
      this.restore(house, pet, box, unfinished.filter((message) => message.status === "received"));
      this.fail(house, pet, unfinished.filter((message) => message.status !== "received"), "interrupted");
      if (box.inbox.size > 0) this.events.info(`bot ${house}/${pet}: ${box.inbox.size} queued message(s) from before the restart`);
      void this.flush(house, pet);
    }
  }

  /**
   * Queues a pet's messages from before the restart again, with the batch boundaries that were between them: a
   * message refused there closes the batch before it, as it did when it came.
   */
  private restore(house: string, pet: string, box: Mailbox, queued: Message[]): void {
    const refused = queued[0] ? this.store.rejectedAfter(house, pet, queued[0].id) : [];
    for (const message of queued) {
      while (refused[0] !== undefined && refused[0] < message.id) {
        box.inbox.close();
        refused.shift();
      }
      box.inbox.push(message, message.origin === "inbox");
    }
  }

  /** Pets that were running before this reload: a dialog may already be open on their screen. */
  async adopt(pets: PlacedPet[]): Promise<void> {
    for (const { house, pet } of pets) {
      const box = this.boxes.get(key(house, pet));
      if (!box || box.inbox.activity === "dialog") continue;
      const seen = box.dialogs;
      if (!(await box.agent.dialogVisible(this.execIn(house, pet))) || !this.current(house, pet, box, seen)) continue;
      this.record(house, pet, box, { kind: "dialog-opened", dialog: "unknown", summary: "already on screen" });
    }
  }

  /**
   * A payload the pet's agent posted. Unknown pets are ignored. Resolves to the answer for the agent: for a
   * dialog that waits for one (`ask`), the person's, once they gave it; otherwise nothing (`{}`). `signal`
   * aborts when the agent stops waiting (the dialog was answered in its session).
   */
  async onPayload(house: string, pet: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const box = this.boxes.get(key(house, pet));
    if (!box || this.suspended.has(key(house, pet))) return {};
    const { dialogs } = box.agent;
    const dialog = dialogs?.ask(payload);
    const events = box.agent.translate(payload);
    // Over the rate, progress goes; turns' ends and starts and dialogs never.
    if (!box.admit(dialog !== undefined || events.some((event) => VITAL.includes(event.kind) || event.kind === "tool-review" || (event.kind === "notification" && event.audience === "chat")))) return {};
    for (const event of events) this.record(house, pet, box, event);
    void this.flush(house, pet);
    if (!dialogs || !dialog) return {};
    const answer = await this.ask(house, pet, box, dialog, signal);
    if (!answer) return {}; // it stays with the person in the agent's session
    if (this.boxes.get(key(house, pet)) === box && box.asking.length === 0) {
      // Answered here, the dialog is gone; waiting messages need not wait for a look at the screen.
      this.record(house, pet, box, { kind: "dialog-closed" });
      void this.flush(house, pet);
    }
    return dialogs.answer(payload, answer);
  }

  /**
   * Puts the dialog to the person until they answer, the agent stops waiting (`signal`), or the dialog closes
   * some other way (`record`): answered in the agent's session, the agent may keep waiting on a request whose
   * answer it will ignore (claude does), so its closing is what tells.
   */
  private async ask(house: string, pet: string, box: Mailbox, dialog: DialogQuestion, signal?: AbortSignal): Promise<DialogAnswer | undefined> {
    const closed = new AbortController();
    box.asking.push(closed);
    try {
      return await this.askPerson(house, pet, dialog, signal ? AbortSignal.any([signal, closed.signal]) : closed.signal);
    } finally {
      box.asking.splice(box.asking.indexOf(closed), 1);
    }
  }

  /**
   * Queues a message for `pet` (Chat decides who: the routing rule). One whose `ref` the house already has is a
   * repeat (a channel replaying) and is dropped. An edit (`edits`) of a message still queued for that pet
   * replaces its text; otherwise it goes as a new message, marked as an edit.
   */
  send(house: string, pet: string, draft: MessageDraft): { activity: Activity; queued: number } {
    if (draft.ref !== undefined && this.store.byRef(house, draft.ref)) return this.state(house, pet);
    if (draft.edits === undefined) return this.queue(house, pet, draft);
    const latest = this.store.byRef(house, draft.edits);
    const box = this.boxes.get(key(house, pet));
    // Unseen by the pet, the original just changes (an earlier edit's copy stays an edit). Only the text: the
    // header stays the original's, same sender and place; the edit's own facts (its date) are not shown.
    if (latest?.pet === pet && latest.status === "received" && !box?.sending.some((sending) => sending.id === latest.id) && box?.replace(latest.id, draft.text)) {
      this.store.setText(latest.id, draft.text);
      this.events.info(`bot ${house}/${pet}: queued message edited`);
      return this.state(house, pet);
    }
    return this.queue(house, pet, draft);
  }

  /**
   * A message the security system refused: kept as `rejected`, never given to the pet. It ends the pet's batch
   * (whatever its place): what waits goes now, joined by nothing after it. False for a repeat (a channel replaying), which is dropped.
   */
  reject(house: string, pet: string, draft: MessageDraft): boolean {
    if (draft.ref !== undefined && this.store.byRef(house, draft.ref)) return false;
    this.store.add(house, pet, draft, "rejected");
    this.boxes.get(key(house, pet))?.inbox.close();
    void this.flush(house, pet);
    return true;
  }

  /** The pet answered: everything it had been given counts as answered. */
  answered(house: string, pet: string): void {
    const box = this.boxes.get(key(house, pet));
    if (!box) return;
    for (const message of box.awaiting) if (message.origin !== "cron") this.mark(message, "answered");
    box.awaiting = box.awaiting.filter((message) => message.origin === "cron");
  }

  /**
   * Stops what the pet's agent is doing (its turn), as its person asked: `idle` when it is doing nothing (nothing
   * is pressed: a key on an idle agent would do something else), `stopped` once it is seen waiting for input
   * (`leftover`: text it left in its input, which nothing is pasted over), `failed` when that cannot be seen. A
   * dialog Household is asking for it is answered instead (`answerDialogs`: refused with an interrupt).
   */
  async interrupt(house: string, pet: string, answerDialogs: () => Promise<boolean>): Promise<{ status: "stopped" | "idle" | "failed"; leftover?: string }> {
    const box = this.boxes.get(key(house, pet));
    const name = `bot ${house}/${pet}`;
    if (!box) return { status: "idle" };
    if (box.asking.length > 0 && (await answerDialogs())) {
      box.inbox.stopped();
      this.events.info(`${name}: stopped by its person (its dialog refused with an interrupt)`);
      return { status: "stopped" };
    }
    if (box.inbox.activity === "idle" || !box.agent.interrupt) return { status: box.agent.interrupt ? "idle" : "failed" };
    const result = await box.agent.interrupt(this.execIn(house, pet));
    if (result.status === "stopped") box.inbox.stopped();
    this.events.info(`${name}: ${{ stopped: "stopped by its person", idle: "was doing nothing to stop", failed: "could not be stopped" }[result.status]}`);
    return result;
  }

  /** Hold queued messages and ignore old session events while its VM is restarting. */
  async suspend(house: string, pet: string): Promise<void> {
    this.suspended.add(key(house, pet));
    const box = this.boxes.get(key(house, pet));
    if (!box) return;
    box.retry.cancel();
    box.watch.cancel();
    for (const asking of box.asking) asking.abort();
    while (box.flushing) await Bun.sleep(10);
    this.restarted(house, pet);
    box.inbox.stopped();
    box.inbox.markInboxCatchup();
  }

  isSuspended(house: string, pet: string): boolean {
    return this.suspended.has(key(house, pet));
  }

  resume(house: string, pet: string): void {
    this.suspended.delete(key(house, pet));
    void this.flush(house, pet);
  }

  /** A pet's container was (re)started: whatever it had been given is lost with its session, a turn too. */
  restarted(house: string, pet: string): void {
    const box = this.boxes.get(key(house, pet));
    if (!box) return;
    this.recoverInbox(box);
    for (const message of box.awaiting) this.mark(message, "failed");
    box.awaiting = [];
    box.cronTurns.clear();
    box.memoryRevision = undefined;
    box.memoryEpoch++;
    box.typed = [];
    this.report({ kind: "turn-lost", house, pet, why: "session" });
  }

  /** An interrupted event may have been seen; summarize it instead of replaying its full body. */
  private recoverInbox(box: Mailbox): void {
    for (const message of box.awaiting) if (message.origin === "inbox") {
      this.mark(message, "received");
      box.inbox.push(message, true);
    }
    box.awaiting = box.awaiting.filter(message => message.origin !== "inbox");
  }

  stop(): void {
    for (const box of this.boxes.values()) box.close();
    this.boxes.clear();
    this.suspended.clear();
  }

  /** Hold ordinary delivery while the agent saves its work. The caller releases after VM restart.
   * The notice is ephemeral: it must never be replayed into the restarted VM. */
  async prepareRestart(house: string, pet: string, timeoutMs = 180_000, action: "restart" | "disable" = "restart", notice?: string): Promise<() => void> {
    const name = key(house, pet);
    const box = this.box(house, pet);
    if (this.restarting.has(name)) throw new Error("bot is already restarting");
    const text = notice ?? `Household will ${action === "disable" ? "stop" : "restart"} your VM shortly. Save your work and any important context to Household memory now, then finish this turn. Do not start new work or post to Telegram. You have at most three minutes; files and installed packages will be preserved.`;
    let active = true;
    let accepted = false;
    let turn: string | undefined;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const observe = (event: AgentEvent) => {
      if (event.kind === "prompt-accepted" && sameText(text, event.text)) {
        accepted = true;
        turn = event.turn;
      }
      if (accepted && ((event.kind === "turn-finished" && event.turn === turn) ||
        (event.kind === "turn-failed" && (event.scope === "session" || event.turn === turn)))) finish();
    };
    this.restarting.set(name, observe);
    const cancelDeadline = this.clock.after(timeoutMs, () => {
      active = false;
      this.events.info(`bot ${house}/${pet}: restart grace period expired`);
      finish();
    });
    const release = () => {
      active = false;
      cancelDeadline();
      if (this.restarting.get(name) === observe) this.restarting.delete(name);
      void this.flush(house, pet);
    };
    const current = () => active && this.boxes.get(name) === box && !this.suspended.has(name);
    const canSubmit = () => current() && box.inbox.activity === "idle";
    const exec: Exec = (command, stdin) => {
      if (!current()) return Promise.resolve({ ok: false, output: "restart preparation ended" });
      return this.execIn(house, pet)(command, stdin);
    };
    const notify = async () => {
      while (active) {
        if (this.boxes.get(name) !== box || this.suspended.has(name)) { finish(); return; }
        if (!box.flushing && canSubmit() && await box.agent.isIdle?.(exec)) {
          if (!canSubmit()) continue;
          this.events.info(`bot ${house}/${pet}: notifying harness before VM restart`);
          const result = await box.agent.send(exec, text, canSubmit);
          if (result.status === "sent") return;
          // Stuck means submission is uncertain; never type the notice a second time.
          if (result.status === "stuck") {
            this.events.error(`bot ${house}/${pet}: restart notification submission uncertain`);
            return;
          }
        }
        await Promise.race([done, new Promise<void>(resolve => this.clock.after(250, resolve))]);
      }
    };
    // A hung probe/send must not hold the grace period open. Submission checks the deadline too.
    void notify().catch(error => {
      this.events.error(`bot ${house}/${pet}: restart notification failed: ${String(error)}`);
      finish();
    });
    await done;
    active = false;
    cancelDeadline();
    return release;
  }

  /** Admit an already persisted scheduler message; the scheduler commits it atomically with its run. */
  acceptScheduled(house: string, pet: string, message: Message): void {
    this.box(house, pet).queue(message);
    void this.flush(house, pet);
  }

  private queue(house: string, pet: string, draft: MessageDraft): { activity: Activity; queued: number } {
    const box = this.box(house, pet);
    const message = this.store.add(house, pet, draft);
    box.queue(message);
    if (unfetched(message)) void this.fetch(house, pet, box, message);
    if (draft.origin === "inbox" && (this.suspended.has(key(house, pet)) || box.inbox.activity !== "idle")) box.inbox.markInboxCatchup();
    this.events.info(`bot ${house}/${pet}: message queued (bot is ${box.inbox.activity}, ${box.inbox.size} waiting)`);
    void this.flush(house, pet);
    return this.state(house, pet);
  }

  private state(house: string, pet: string): { activity: Activity; queued: number } {
    const { inbox } = this.box(house, pet);
    return { activity: inbox.activity, queued: inbox.size };
  }

  private box(house: string, pet: string): Mailbox {
    const box = this.boxes.get(key(house, pet));
    if (!box) throw new HouseholdError(`unknown bot ${house}/${pet}`);
    return box;
  }

  private mark(message: Message, status: MessageStatus): void {
    message.status = status;
    this.store.setStatus(message.id, status);
  }

  private fail(house: string, pet: string, messages: Message[], why: "stuck" | "interrupted"): void {
    if (messages.length === 0) return;
    for (const message of messages) this.mark(message, "failed");
    this.report({ kind: "failed", house, pet, messages, why });
  }

  private record(house: string, pet: string, box: Mailbox, event: AgentEvent): void {
    if (event.kind === "session-started") { box.memoryRevision = undefined; box.memoryEpoch++; }
    this.restarting.get(key(house, pet))?.(event);
    if (!box.inbox.observe(event)) {
      // Another dialog while one is open (permissions for calls in parallel) is its own; a screen-only one is the same.
      if (event.kind === "dialog-opened" && event.dialog !== "unknown") this.report({ kind: "dialog", house, pet, dialog: event.dialog, ...(event.input ? { input: event.input } : {}) });
      return;
    }
    // The agent's text is for the person to glimpse (the live message); the answer is logged with the turn's end.
    const visible = this.sanitizeEvent?.(house, pet, event) ?? event;
    this.events.agent(house, pet, visible);
    const turn = "turn" in event && event.turn !== undefined ? { turn: event.turn } : {};
    if (event.kind === "turn-finished" || event.kind === "turn-failed") {
      const completed = box.awaiting.filter(message => message.origin === "cron" && ((event.kind === "turn-failed" && event.scope === "session") || (box.cronTurns.has(message.id) && box.cronTurns.get(message.id) === event.turn)));
      this.store.cronEvent?.(completed.map(message => message.id), visible);
      for (const message of completed) {
        this.mark(message, event.kind === "turn-finished" ? "answered" : "failed");
        box.cronTurns.delete(message.id);
      }
      box.awaiting = box.awaiting.filter(message => !completed.includes(message));
    }
    if (event.kind === "turn-finished") {
      this.answered(house, pet);
      this.report({ kind: "turn-finished", house, pet, ...turn });
    }
    if (event.kind === "prompt-accepted") {
      const messages = this.typedAs(box, event.text);
      for (const message of messages) if (message.origin === "cron") box.cronTurns.set(message.id, event.turn);
      this.store.cronEvent?.(messages.filter(m => m.origin === "cron").map(m => m.id), visible);
      this.report({ kind: "turn-started", house, pet, ...turn, messages });
    }
    if (visible.kind === "tool-started" || visible.kind === "tool-finished" || visible.kind === "tool-review") this.report({ kind: "progress", house, pet, event: visible });
    if (visible.kind === "notification" && visible.audience === "chat") this.report({ kind: "notification", house, pet, text: visible.text });
    if (event.kind === "session-started" && !event.continues) {
      this.recoverInbox(box);
      for (const message of box.awaiting) if (message.origin === "cron") this.mark(message, "failed");
      box.awaiting = box.awaiting.filter((message) => message.origin !== "cron");
      box.cronTurns.clear();
    }
    if (event.kind === "turn-failed") this.recoverInbox(box);
    if (event.kind === "turn-failed") this.report({ kind: "turn-lost", house, pet, why: "failed", ...turn });
    if (event.kind === "session-started" && !event.continues) this.report({ kind: "turn-lost", house, pet, why: "session" });
    if (event.kind === "dialog-opened") this.report({ kind: "dialog", house, pet, dialog: event.dialog, ...(event.input ? { input: event.input } : {}) });
    if (event.kind === "dialog-closed") this.report({ kind: "dialog", house, pet });
    if (event.kind === "dialog-closed") box.asking.at(-1)?.abort(); // the newest dialog is the one that closed
    if (event.kind !== "dialog-opened") return;
    box.dialogs += 1;
    box.watch.reset();
    box.watch.schedule(() => void this.watchDialog(house, pet, box));
  }

  /**
   * The messages Household typed that a prompt the agent took is: the batch typed as that text (it may report it
   * before the typing is over). Batches typed before it are not waited for any more (the agent took them in
   * another way, or not at all); none when the prompt is not one of Household's.
   */
  private typedAs(box: Mailbox, prompt: string): Message[] {
    const at = box.typed.findIndex((typed) => sameText(typed.text, prompt));
    if (at < 0) return [];
    return box.typed.splice(0, at + 1).at(-1)!.messages;
  }

  /** Closes a dialog that is no longer on screen, or looks again later. */
  private async watchDialog(house: string, pet: string, box: Mailbox): Promise<void> {
    const seen = box.dialogs;
    if (!this.current(house, pet, box, seen) || box.inbox.activity !== "dialog") return;
    const visible = await box.agent.dialogVisible(this.execIn(house, pet));
    if (!this.current(house, pet, box, seen) || box.inbox.activity !== "dialog") return;
    if (visible) return box.watch.schedule(() => void this.watchDialog(house, pet, box));
    this.record(house, pet, box, { kind: "dialog-closed" });
    void this.flush(house, pet);
  }

  /** The box still belongs to the pet and no dialog opened since `seen`. */
  private current(house: string, pet: string, box: Mailbox, seen: number): boolean {
    return this.boxes.get(key(house, pet)) === box && box.dialogs === seen;
  }

  /**
   * Fetches the message's files (one fetch at a time), and keeps what came of them; never rejects. Files that
   * cannot be fetched here (no fetcher) fail.
   */
  private fetch(house: string, pet: string, box: Mailbox, message: Message): Promise<void> {
    const running = box.fetching.get(message.id);
    if (running) return running;
    const files = message.attachments ?? [];
    const fetching = (this.attachments ? this.attachments.fetch(house, pet, box.home, message) : Promise.reject(new Error("files are not accepted here")))
      .catch((error) => files.map((file) => (fetched(file) ? file : { ...file, failed: `not downloaded: ${(error as Error).message}` })))
      .then((attachments) => {
        message.attachments = attachments;
        this.store.setAttachments(message.id, attachments);
      })
      .catch((error) => this.events.error(`bot ${house}/${pet}: files of message ${message.id} not kept: ${(error as Error).message}`))
      .finally(() => box.fetching.delete(message.id));
    box.fetching.set(message.id, fetching);
    return fetching;
  }

  /**
   * Delivers queued messages while allowed, one message or one batch at a time; one flush per pet at a time. A
   * batch that may still grow waits for its place to be quiet.
   */
  private async flush(house: string, pet: string): Promise<void> {
    const box = this.boxes.get(key(house, pet));
    if (!box || box.flushing || this.suspended.has(key(house, pet)) || this.restarting.has(key(house, pet))) return;
    box.flushing = true;
    box.retry.cancel();
    const name = `bot ${house}/${pet}`;
    try {
      for (let next = box.inbox.next(this.timing.batchMax); next.messages.length > 0; next = box.inbox.next(this.timing.batchMax)) {
        if (this.suspended.has(key(house, pet)) || this.restarting.has(key(house, pet))) return;
        if (next.messages[0]?.origin === "cron" && box.awaiting.some(message => message.origin === "cron")) return;
        if (next.messages[0]?.origin === "inbox" && box.awaiting.some(message => message.origin === "inbox")) { box.inbox.markInboxCatchup(); return; }
        // A fresh mailbox cannot know whether the surviving VM is still working. Probe before
        // every cron, including restored ones; an unavailable/unknown session is retried safely.
        if (next.messages[0]?.origin === "cron" || next.messages[0]?.origin === "inbox") {
          let idle = false;
          try { idle = await box.agent.isIdle?.(this.execIn(house, pet)) ?? false; } catch { /* retry */ }
          if (this.boxes.get(key(house, pet)) !== box || this.suspended.has(key(house, pet))) return;
          if (!idle || box.inbox.activity !== "idle") {
            box.inbox.markInboxCatchup();
            box.retry.schedule(() => void this.flush(house, pet));
            return;
          }
        }
        if (!next.complete && box.quietLeft() > 0) return box.awaitQuiet(() => void this.flush(house, pet));
        const fetching = next.messages.filter(unfetched);
        if (fetching.length > 0) {
          void Promise.all(fetching.map((message) => this.fetch(house, pet, box, message))).then(() => this.flush(house, pet));
          return;
        }
        const messages = next.messages as [Message, ...Message[]];
        box.sending = messages;
        const zone = this.timezone?.();
        const clock = zone ? block(CLOCK_TAG,[tagFreeJson({ timezone:zone, now:new Date(this.clock.now()).toISOString(), local:new Intl.DateTimeFormat("sv-SE",{timeZone:zone,dateStyle:"short",timeStyle:"long"}).format(this.clock.now()) })]) + "\n" : "";
        const memory = this.memoryContext?.(house, pet);
        const memoryEpoch = box.memoryEpoch;
        const memoryText = memory && memory.revision !== box.memoryRevision ? memory.text : "";
        const typed = { text: clock + memoryText + (next.digest ? inboxDigest(messages) : promptText(...messages)), messages };
        box.typed = [...box.typed, typed].slice(-TYPED_KEPT);
        const scheduled = messages.filter(message => message.origin === "cron");
        // Commit before the external side effect. A crash with uncertain submission must not replay a cron.
        for (const message of scheduled) this.mark(message, "dispatching");
        box.awaiting.push(...scheduled);
        let result: SendResult;
        try {
          result = await box.agent.send(this.execIn(house, pet), typed.text, () => box.inbox.activity !== "dialog" && ((scheduled.length === 0 && !messages.some(m => m.origin === "inbox")) || box.inbox.activity === "idle") && !this.suspended.has(key(house, pet)));
        } catch (error) {
          if (messages.every(message => message.origin === "inbox")) result = { status: "refused", reason: "inbox submission interrupted; retrying as a catch-up digest" };
          else {
            if (!scheduled.length) throw error;
            result = { status: "stuck", reason: "scheduled submission failed; outcome uncertain" };
          }
        }
        box.sending = [];
        if (result.status !== "sent") box.awaiting = box.awaiting.filter(message => !scheduled.includes(message));
        if (this.boxes.get(key(house, pet)) !== box) return;
        if (result.status !== "sent") box.typed = box.typed.filter((each) => each !== typed);
        if (result.status === "refused") {
          if (messages.some(m => m.origin === "inbox")) box.inbox.markInboxCatchup();
          for (const message of scheduled) this.mark(message, "received");
          if (result.reason !== box.refusal) this.events.info(`${name}: message kept in queue (${result.reason}); retrying`);
          box.refusal = result.reason;
          box.retry.schedule(() => void this.flush(house, pet));
          return;
        }
        // Once typed, a message is never typed again: a retry could leave it twice in the agent's input.
        box.inbox.delivered(messages.length);
        box.refusal = undefined;
        box.retry.reset();
        const what = messages.length === 1 ? "message" : `batch of ${messages.length} messages`;
        if (result.status === "stuck") {
          this.events.error(`${name}: ${what} typed but not submitted (${result.reason}); see \`house bot attach\``);
          this.fail(house, pet, messages, "stuck");
          continue;
        }
        if (memory && box.memoryEpoch === memoryEpoch) box.memoryRevision = memory.revision;
        for (const message of messages) if (message.origin !== "cron" || message.status === "dispatching") this.mark(message, "delivered");
        box.awaiting.push(...messages.filter(message => message.origin !== "cron"));
        this.events.info(`${name}: ${what} delivered (${box.inbox.size} left)`);
        this.report({ kind: "delivered", house, pet, messages });
      }
    } finally {
      box.flushing = false;
    }
  }
}

const key = (house: string, pet: string) => `${house}/${pet}`;

/** Batches typed and not yet seen taken by the agent: a few at most (the agent takes them in turn). */
const TYPED_KEPT = 8;
