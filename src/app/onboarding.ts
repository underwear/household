import { randomUUID } from "node:crypto";
import type { Contact, FoundGroup } from "../channel-adapters/telegram/first-contact";
import { HouseholdError } from "../core/errors";
import { NotFoundError } from "../infra/config-store";
import type { DeviceLogin } from "./codex-login";

/** How long the web's setup keeps a sign-in or a wait for a first message it is no longer asked about. */
const KEPT_MS = 20 * 60_000;
/** How long a new bot is watched for its owner and its group (the person may need to install Telegram first). */
const LISTEN_MS = 10 * 60_000;

export interface OnboardingDeps {
  /** Household's own ChatGPT sign-in for key `name`, by a device code. */
  deviceLogin?: (name: string) => Promise<DeviceLogin>;
  /** Watches a new bot for its owner (the first to write in private) and, with `group`, its group (telegram/first-contact.ts). */
  watch: (token: string, options: { group: boolean; signal: AbortSignal; timeoutMs: number; onContact: (contact: Contact) => void; onGroup: (group: FoundGroup) => void }) => Promise<"done" | "timeout">;
  /** What a group the bot is in still needs. */
  checkGroup: (token: string, chat: string) => Promise<FoundGroup>;
  /** The config changed (a key was saved): the daemon's reload. */
  apply: () => Promise<unknown>;
  now?: () => number;
}

export type LoginStatus = { status: "waiting" } | { status: "done"; key: string } | { status: "failed"; error: string };
/**
 * A new bot's watch: `waiting` while it lacks its owner (or, for a group, a group with nothing missing); `ready`
 * once it has them; `timeout`; `failed`; `manual`: the bot is one Household runs already, so its messages are the
 * daemon's, and the person types their id. What was found so far comes along either way.
 */
export interface ListenStatus {
  status: "waiting" | "ready" | "timeout" | "manual" | "failed";
  /** Whether the channel is a group, so a group is looked for too. */
  needsGroup: boolean;
  contact?: Contact;
  group?: FoundGroup;
  error?: string;
}

interface Login { key: string; state: LoginStatus; cancel: () => void; at: number }
interface Listen { token: string; house: string; kind: string; bot: string; state: ListenStatus; abort: AbortController; at: number }

/**
 * What the web's setup does that is more than a write to the config, and takes a while: a ChatGPT sign-in by device
 * code, and the wait for the first person to write to a new Telegram bot (who becomes the workspace's owner). Each
 * runs in the daemon under an id the page asks about; a bot's token stays here, never sent back.
 */
export class Onboarding {
  private readonly logins = new Map<string, Login>();
  private readonly listens = new Map<string, Listen>();
  private readonly now: () => number;

  /** Forgets, now and then, what the page stopped asking about: a wait left behind would hold its bot's updates. */
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly deps: OnboardingDeps) {
    this.now = deps.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  async startLogin(key: string): Promise<{ id: string; url: string; code: string }> {
    if (!this.deps.deviceLogin) throw new HouseholdError("this Household cannot sign in to ChatGPT");
    this.sweep();
    // One sign-in per key: a new one replaces one still running (two would write the same login).
    for (const [id, other] of this.logins) if (other.key === key && other.state.status === "waiting") this.cancelLogin(id);
    const login = await this.deps.deviceLogin(key);
    const id = randomUUID();
    const entry: Login = { key, state: { status: "waiting" }, cancel: login.cancel, at: this.now() };
    this.logins.set(id, entry);
    login.done.then(
      async () => {
        await this.deps.apply().catch(() => undefined);
        entry.state = { status: "done", key };
      },
      (error) => { entry.state = { status: "failed", error: (error as Error).message }; },
    );
    return { id, url: login.url, code: login.code };
  }

  login(id: string): LoginStatus {
    const entry = this.logins.get(id);
    if (!entry) throw new NotFoundError("no such sign-in (it ended, or Household restarted): start again");
    entry.at = this.now();
    return entry.state;
  }

  cancelLogin(id: string): void {
    this.logins.get(id)?.cancel();
    this.logins.delete(id);
  }

  /**
   * Waits for the first message to bot `bot` (its token checked already) for workspace `house`'s channel of `kind`;
   * only keeps the token when the bot is not to be read here (`poll` false).
   */
  listen(token: string, house: string, kind: string, bot: string, poll = true): string {
    this.sweep();
    for (const [id, other] of this.listens) if (other.token === token) this.stop(id); // one wait per bot
    const id = randomUUID();
    const entry: Listen = { token, house, kind, bot, state: { status: poll ? "waiting" : "manual", needsGroup: kind === "telegram-group" }, abort: new AbortController(), at: this.now() };
    this.listens.set(id, entry);
    if (poll) this.wait(entry);
    return id;
  }

  /** The same watch again, for another owner (the one who wrote was someone else, or it timed out); a group found stays. */
  relisten(id: string): void {
    const entry = this.listening(id);
    if (entry.state.status === "manual") return;
    entry.abort.abort();
    entry.abort = new AbortController();
    const { group, needsGroup } = entry.state;
    entry.state = { status: "waiting", needsGroup, ...(group ? { group } : {}) };
    this.wait(entry);
  }

  /** The group found, asked about again (its settings changed without the bot being told): ready once it has all. */
  async recheck(id: string): Promise<void> {
    const entry = this.listening(id);
    const group = entry.state.group;
    if (!group) return;
    entry.state.group = await this.deps.checkGroup(entry.token, group.id);
    if (entry.state.contact && entry.state.group.problems.length === 0 && entry.state.status !== "manual") {
      entry.abort.abort();
      entry.state.status = "ready";
    }
  }

  status(id: string): ListenStatus & { bot: string } {
    this.sweep();
    const entry = this.listening(id);
    return { ...entry.state, bot: entry.bot };
  }

  /** The wait's bot, for its channel: its token, workspace and kind, and the group found for it. */
  bot(id: string): { token: string; house: string; kind: string; bot: string; group?: FoundGroup } {
    const { token, house, kind, bot, state } = this.listening(id);
    return { token, house, kind, bot, ...(state.group ? { group: state.group } : {}) };
  }

  /** The bot's channel is made: the wait ends, and its token is forgotten here. */
  finish(id: string): void {
    this.stop(id);
  }

  /** A channel of bot `token` was added another way (the Channels page): its updates are the daemon's from now. */
  release(token: string): void {
    for (const [id, entry] of this.listens) if (entry.token === token) this.stop(id);
  }

  stopAll(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.listens.keys()]) this.stop(id);
    for (const id of [...this.logins.keys()]) this.cancelLogin(id);
  }

  private listening(id: string): Listen {
    const entry = this.listens.get(id);
    if (!entry) throw new NotFoundError("no such wait for a bot (it ended, or Household restarted): enter the token again");
    entry.at = this.now();
    return entry;
  }

  private wait(entry: Listen): void {
    const { signal } = entry.abort;
    const state = entry.state;
    this.deps.watch(entry.token, {
      group: state.needsGroup, signal, timeoutMs: LISTEN_MS,
      onContact: (contact) => { if (!signal.aborted) state.contact = contact; },
      onGroup: (group) => { if (!signal.aborted) state.group = group; },
    }).then(
      (end) => { if (!signal.aborted) state.status = end === "done" ? "ready" : "timeout"; },
      (error) => { if (!signal.aborted) Object.assign(state, { status: "failed", error: (error as Error).message }); },
    );
  }

  private stop(id: string): void {
    this.listens.get(id)?.abort.abort();
    this.listens.delete(id);
  }

  /** Forgets what the page stopped asking about. */
  private sweep(): void {
    const old = this.now() - KEPT_MS;
    for (const [id, entry] of this.listens) if (entry.at < old) this.stop(id);
    for (const [id, entry] of this.logins) if (entry.at < old) this.cancelLogin(id);
  }
}
