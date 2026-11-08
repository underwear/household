import { RateLimited, StatusGone, type Channel, type Choices, type LinkButton, type InboundMessage, type MessageRef, type Place, type PostRef, type SenderRef, type StatusView } from "../../src/core/channel";

/** How choices are recorded: ` {a|b}{c}` (one brace per row). */
const shown = (choices?: Choices) => (choices ? ` ${choices.map((row) => `{${row.join("|")}}`).join("")}` : "");

/**
 * A channel that records what Household sent, as `kind title: text {choices}` (posts and notices are
 * `post-<n>`, n counting the calls), and lets a test play the person.
 */
export class FakeChannel implements Channel {
  readonly inbox = "General";
  calls: string[] = [];
  stopped = false;
  /** When set, posts and notices fail with it. */
  failure?: string;
  private onMessage?: (message: InboundMessage) => Promise<string | void>;
  private presses = 0;

  start(onMessage: (message: InboundMessage) => Promise<string | void>): void {
    this.onMessage = onMessage;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async post(place: Place, text: string, choices?: Choices): Promise<PostRef[]> {
    return [this.record(`post ${place.title}: ${text}${shown(choices)}`)];
  }

  async notice(place: Place, text: string, choices?: Choices): Promise<PostRef[]> {
    return [this.record(`notice ${place.title}: ${text}${shown(choices)}`)];
  }

  /** Recorded as `choices <ref>: {choices}`, with ` — <note>` when there is one; a replacement also in `replaced`. */
  async setChoices(ref: PostRef, choices: Choices, note?: string, replacement?: { text: string; link?: LinkButton }): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    this.calls.push(`choices ${ref}:${shown(choices)}${note === undefined ? "" : ` — ${note}`}`);
    if (replacement) this.replaced.push({ ref, text: replacement.text, ...(replacement.link ? { link: replacement.link } : {}) });
  }

  /** Whole texts notices were replaced with (`setChoices`), with the link button under each, if any. */
  replaced: { ref: PostRef; text: string; link?: LinkButton }[] = [];
  /** Places that have a thread (`placeLink` makes one), by id; `removePlace` takes them away, recorded in `removed`. */
  threads = new Set<string>();
  removed: string[] = [];

  async placeLink(place: Place): Promise<string | undefined> {
    if (place.kind !== "pet-thread") return undefined;
    this.threads.add(place.id);
    return `https://chat.example/${encodeURIComponent(place.id)}`;
  }

  async removePlace(place: Place): Promise<boolean> {
    if (this.failure) throw new Error(this.failure);
    this.removed.push(place.id);
    return this.threads.delete(place.id);
  }

  async resolve(ref: PostRef, outcome: string): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    this.calls.push(`resolve ${ref}: ${outcome}`);
  }

  /**
   * Status posts (live messages), apart from `calls`: `post <ref> <place>: <view>`, `edit <ref>: <view>`,
   * `drop <ref>` (a view as `shownView` writes it).
   */
  statuses: string[] = [];
  /** The latest view of each status post, by ref. */
  views = new Map<string, StatusView>();
  /**
   * When set, the next status calls (posts and edits) fail with these, in turn: a number is rate limited for that
   * many ms, `gone: …` can never work, any other text passes.
   */
  statusFailures: (string | number)[] = [];
  /** When set, status posts wait for it. */
  statusHold?: Promise<void>;
  private statusPosts = 0;
  /** Status post refs are `<prefix>-<n>`: one chat's refs are its own. */
  statusPrefix = "status";

  async postStatus(place: Place, view: StatusView): Promise<PostRef> {
    await this.statusHold;
    if (this.failure) throw new Error(this.failure);
    this.statusFailure();
    const ref = `${this.statusPrefix}-${++this.statusPosts}`;
    this.statuses.push(`post ${ref} ${place.title}: ${shownView(view)}`);
    this.views.set(ref, view);
    return ref as PostRef;
  }

  /** When set, status edits wait for it. */
  editHold?: Promise<void>;
  /** Status edits under way now, and the most there ever were at once. */
  editing = 0;
  mostEditing = 0;

  async editStatus(ref: PostRef, view: StatusView): Promise<void> {
    this.mostEditing = Math.max(this.mostEditing, ++this.editing);
    try {
      await this.editHold;
    } finally {
      this.editing -= 1;
    }
    this.statusFailure();
    this.statuses.push(`edit ${ref}: ${shownView(view)}`);
    this.views.set(ref, view);
  }

  async dropStatus(ref: PostRef): Promise<void> {
    this.statusFailure();
    this.statuses.push(`drop ${ref}`);
    this.views.delete(ref);
  }

  private statusFailure(): void {
    const failure = this.statusFailures.shift();
    if (typeof failure === "number") throw new RateLimited(failure);
    if (failure?.startsWith("gone: ")) throw new StatusGone(failure.slice(6));
    if (failure !== undefined) throw new Error(failure);
  }

  async delivered(ref: MessageRef): Promise<void> {
    this.calls.push(`seen ${ref}`);
  }

  async react(ref: MessageRef | PostRef, emoji: string | undefined): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    this.calls.push(`react ${ref}: ${emoji ?? "(none)"}`);
  }

  /** The titles its places were given on reloads, by place id (apart from `calls`: every reload gives them). */
  titles = new Map<string, string>();
  async retitle(place: Place): Promise<void> {
    this.titles.set(place.id, place.title);
  }

  isSender(ref: SenderRef, id: string): boolean {
    return ref === `fake.user.${id}`;
  }

  /** The person writes; for a press, resolves to what they are told. */
  say(message: InboundMessage): Promise<string | void> {
    return this.onMessage!(message);
  }

  /** The person presses choice `index` (shown as `label`) on post `answersTo`, in `place`. */
  press(answersTo: string, index: number, label: string, fields: Partial<Extract<InboundMessage, { kind: "choice" }>> = {}): Promise<string | void> {
    const ref = `press-${answersTo}-${index}-${this.presses++}` as MessageRef;
    return this.say({ kind: "choice", ref, from: { ref: OWNER, name: "Oleg" }, external: {}, answersTo: answersTo as PostRef, index, label, ...fields });
  }

  private record(call: string): PostRef {
    if (this.failure) throw new Error(this.failure);
    this.calls.push(call);
    return `post-${this.calls.length}` as PostRef;
  }
}

/** A status view in one line: `working <line> [Stop]`, or `over <title>`. */
export function shownView(view: StatusView): string {
  return view.state === "working" ? `working ${view.line}${view.stop ? ` [${view.stop}]` : ""}` : `over ${view.title}`;
}

/** A ref as a channel would hand it out. */
export const ref = (value: string) => value as MessageRef;

/** The owner the tests configure (`owners: [1]`), as the fake channel refers to senders. */
export const OWNER = "fake.user.1" as SenderRef;

/** A text message from the owner (or from `from`), in the inbox unless `place` is given. */
export function text(value: string, fields: Partial<Extract<InboundMessage, { kind: "text" }>> = {}): InboundMessage {
  return { kind: "text", ref: ref(value), from: { ref: OWNER, name: "Oleg" }, external: { message: 1 }, text: value, ...fields };
}
