import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkCode, credentialsFile, finishLogin, parseCredentials, parseSigninMarker, renew, SIGNIN_PREFIX, startLogin,
  type ClaudeAccount, type ClaudeCredentials, type VmExec,
} from "../agent-adapters/claude-code-tmux/signin";
import { HouseholdError } from "../core/errors";

/*
 * Household's Claude sign-ins (`claude-signin:` keys): made by Claude Code in a throwaway VM, kept here, renewed by
 * Claude Code in another throwaway VM before each 8-hour token runs out, and published to the gateway as they change.
 * One sign-in has one keeper: every renewal kills the tokens before it, so nothing else may hold them.
 */

/** Where the sign-ins live: beside the config, one folder per key (`<key>/credentials.json`, `<key>/account.json`). */
export const CLAUDE_AUTH_DIR = "claude-auth";
export const claudeAuthRoot = (configFile: string) => join(dirname(configFile), CLAUDE_AUTH_DIR);

/** The gateway subject Household's own sign-in VMs are (`household` kind): a name no workspace may take. */
export const UTILITY_SUBJECT = "household-auth";

/**
 * What a sign-in VM may reach: Claude's sign-in and token hosts (Claude Code's own OAuth: platform.claude.com's
 * token endpoint, api.anthropic.com's profile), nothing else. Tunnelled, never intercepted: Household reads nothing.
 */
export const SIGNIN_HOSTS = ["platform.claude.com", "api.anthropic.com", "claude.ai", "claude.com"].map((host) => ({ host, port: 443 }));

/** A VM of the claude harness's image, booted for one sign-in or renewal and removed after. */
export interface SigninVm { exec: VmExec; close(): Promise<void> }

/** What the owner sees of a sign-in: whose it is and until when. */
export interface SigninInfo extends ClaudeAccount {
  /** When its current token runs out (renewed well before), and when the sign-in itself ends (epoch ms). */
  expiresAt: number;
  endsAt?: number;
  renewedAt?: number;
}

const NAME = /^[a-z][a-z0-9-]{0,62}$/;

async function plainFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new HouseholdError("Claude sign-ins must be kept in a plain folder");
  await chmod(path, 0o700);
}

/** Writes `file` whole or not at all (a renewal's tokens are the only live ones: half a file would lose them). */
async function atomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export class SigninStore {
  constructor(private readonly root: string) {}

  folder(name: string): string {
    if (!NAME.test(name)) throw new HouseholdError(`invalid key name '${name}'`);
    return join(this.root, name);
  }

  async save(name: string, credentials: ClaudeCredentials, account: ClaudeAccount, renewedAt?: number): Promise<void> {
    await plainFolder(this.root);
    const folder = this.folder(name);
    await plainFolder(folder);
    await atomic(join(folder, "credentials.json"), credentialsFile(credentials));
    await atomic(join(folder, "account.json"), `${JSON.stringify({ ...account, ...(renewedAt ? { renewedAt } : {}) }, null, 2)}\n`);
  }

  /** A renewal's tokens, saved the moment Claude Code has them (the ones before are dead already). */
  async saveCredentials(name: string, credentials: ClaudeCredentials, renewedAt: number): Promise<void> {
    const folder = this.folder(name);
    await atomic(join(folder, "credentials.json"), credentialsFile(credentials));
    try {
      const account = JSON.parse(await readFile(join(folder, "account.json"), "utf8"));
      await atomic(join(folder, "account.json"), `${JSON.stringify({ ...account, renewedAt }, null, 2)}\n`);
    } catch { /* whose it is stays as it was said */ }
  }

  async credentials(name: string): Promise<ClaudeCredentials> {
    let text: string;
    try { text = await readFile(join(this.folder(name), "credentials.json"), "utf8"); } catch { throw new HouseholdError(`key '${name}': its Claude sign-in is missing; sign in again`); }
    return parseCredentials(text);
  }

  async info(name: string): Promise<SigninInfo | undefined> {
    try {
      const account = JSON.parse(await readFile(join(this.folder(name), "account.json"), "utf8")) as ClaudeAccount & { renewedAt?: number };
      const credentials = await this.credentials(name);
      return { ...account, expiresAt: credentials.expiresAt, ...(credentials.refreshTokenExpiresAt ? { endsAt: credentials.refreshTokenExpiresAt } : {}) };
    } catch {
      return undefined;
    }
  }

  /** `info`, read now (two small files): for the key list, which is built in one go. */
  infoNow(name: string): SigninInfo | undefined {
    try {
      const folder = this.folder(name);
      const account = JSON.parse(readFileSync(join(folder, "account.json"), "utf8")) as ClaudeAccount & { renewedAt?: number };
      const credentials = parseCredentials(readFileSync(join(folder, "credentials.json"), "utf8"));
      return { ...account, expiresAt: credentials.expiresAt, ...(credentials.refreshTokenExpiresAt ? { endsAt: credentials.refreshTokenExpiresAt } : {}) };
    } catch {
      return undefined;
    }
  }

  async remove(name: string): Promise<void> { await rm(this.folder(name), { recursive: true, force: true }); }
}

/**
 * What every keeper of Household's sign-ins shares, across reloads (each makes a keeper of its own): one job per key
 * at a time (a renewal, a new sign-in's save, a removal: two renewals would find each other's tokens dead), when a
 * key that failed may be tried again, and the keys whose renewal came back for another account (never published
 * until signed in again).
 */
export class SigninState {
  private readonly locks = new Map<string, Promise<unknown>>();
  readonly retryAt = new Map<string, number>();
  readonly foreign = new Set<string>();

  /** Runs `job` for `key` once the one before it ended. */
  lock<T>(key: string, job: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve();
    const run = before.then(job, job);
    const settled = run.catch(() => {});
    this.locks.set(key, settled);
    void settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key); });
    return run;
  }

  /** Every job under way ended (a shutdown waits: a renewal's tokens are the only live ones until saved). */
  async idle(): Promise<void> { await Promise.allSettled([...this.locks.values()]); }

  /** A new sign-in: tried at once again, published again. */
  reset(key: string): void { this.retryAt.delete(key); this.foreign.delete(key); }
}

/** A sign-in under way: the link the person opens, waiting for the code they bring back. */
export interface PendingSignin { id: string; key: string; url: string; startedAt: number }

const SIGNIN_TTL_MS = 10 * 60_000;

/** Sign-ins under way and done: each in its own throwaway VM, the code typed back into Claude Code's own login. */
export class ClaudeSignins {
  private readonly pending = new Map<string, PendingSignin & { vm: SigninVm; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly deps: {
    store: SigninStore;
    state: SigninState;
    launch(): Promise<SigninVm>;
    /** Why key `name` cannot become a sign-in (it is another kind of key), before a VM boots; undefined: it can. */
    refuse?(name: string): Promise<string | undefined>;
    /** Saves key `name` as this sign-in (`claude-signin:<org>`), replacing one of that name. */
    saveKey(name: string, value: string, account: ClaudeAccount): Promise<void>;
    now?: () => number;
  }) {}

  /** Boots a VM, starts Claude Code's login in it and gives the link to open; the VM waits up to 10 minutes. */
  async start(key: string): Promise<PendingSignin> {
    this.deps.store.folder(key); // the name, checked before a VM boots
    const refused = await this.deps.refuse?.(key);
    if (refused) throw new HouseholdError(refused);
    for (const each of this.pending.values()) if (each.key === key) await this.cancel(each.id);
    const vm = await this.deps.launch();
    let url: string;
    try { url = await startLogin(vm.exec); } catch (error) { await vm.close().catch(() => {}); throw error; }
    const id = randomUUID();
    const timer = setTimeout(() => void this.cancel(id), SIGNIN_TTL_MS);
    timer.unref?.();
    const signin = { id, key, url, startedAt: (this.deps.now ?? Date.now)(), vm, timer };
    this.pending.set(id, signin);
    return { id, key, url, startedAt: signin.startedAt };
  }

  /** Types the person's code into the waiting login; saves the sign-in and its key; ends the VM either way. */
  async finish(id: string, code: string): Promise<ClaudeAccount> {
    const signin = this.pending.get(id);
    if (!signin) throw new HouseholdError("That sign-in has ended (10 minutes, or Household restarted): start it again");
    checkCode(code); // a typo keeps the link
    this.pending.delete(id);
    clearTimeout(signin.timer);
    try {
      const { credentials, account } = await finishLogin(signin.vm.exec, code);
      // After any renewal of the sign-in it replaces: that one would rotate these tokens away.
      await this.deps.state.lock(signin.key, async () => {
        await this.deps.store.save(signin.key, credentials, account, (this.deps.now ?? Date.now)());
        this.deps.state.reset(signin.key);
      });
      await this.deps.saveKey(signin.key, `${SIGNIN_PREFIX}${account.orgId}`, account);
      return account;
    } finally {
      await signin.vm.close().catch(() => {});
    }
  }

  /** The sign-in of key `key` waiting for its code, if one is (the newest: starting one ends the one before). */
  waitingFor(key: string): PendingSignin | undefined {
    for (const each of this.pending.values()) if (each.key === key) return { id: each.id, key: each.key, url: each.url, startedAt: each.startedAt };
    return undefined;
  }

  async cancel(id: string): Promise<void> {
    const signin = this.pending.get(id);
    if (!signin) return;
    this.pending.delete(id);
    clearTimeout(signin.timer);
    await signin.vm.close().catch(() => {});
  }

  async stop(): Promise<void> { await Promise.all([...this.pending.keys()].map((id) => this.cancel(id))); }
}

/** Renew this long before a token runs out: a VM boot and Claude's answer fit many times over. */
const RENEW_BEFORE_MS = 90 * 60_000;
const RETRY_MS = 5 * 60_000;

export interface ClaudeRefreshOptions {
  keys: { name: string; value: string }[];
  /** A key's current token for the gateway; undefined when it has none any more (the sign-in ended). */
  onToken(name: string, token: string | undefined): void | Promise<void>;
  /** Fixed text only: never what Claude or the VM said, which could carry a token. */
  log?(text: string): void;
}

/**
 * Keeps `keys` (sign-ins) fresh: each token published as it is, renewed in a VM 90 minutes before it runs out, one job
 * per key at a time (`state`), a failed one tried again in 5 minutes whichever keeper looks, an ended one only
 * looked at hourly. The first look never renews: it runs inside a network reload, and a renewal's VM needs one of its
 * own. Resolves once every key's token is published (or said to be none).
 */
export async function startClaudeRefresh(options: ClaudeRefreshOptions, deps: { store: SigninStore; state: SigninState; launch(): Promise<SigninVm>; now?: () => number }): Promise<{ stop(): void }> {
  const { store, state } = deps;
  const now = deps.now ?? Date.now;
  const keys = options.keys.filter(({ value }) => parseSigninMarker(value));
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, job: () => Promise<void>) => {
    if (stopped) return;
    const timer = setTimeout(() => { timers.delete(timer); void job(); }, Math.max(1000, ms));
    timer.unref?.();
    timers.add(timer);
  };
  const publish = async (name: string, token: string | undefined) => { if (!stopped) await options.onToken(name, token); };
  const usable = (name: string, credentials: ClaudeCredentials | undefined) =>
    credentials && !state.foreign.has(name) && credentials.expiresAt > now() ? credentials.accessToken : undefined;

  const renewKey = (name: string, org: string) => state.lock(name, async () => {
    const current = await store.credentials(name); // gone (the key was removed): nothing to renew
    if (current.expiresAt - now() >= RENEW_BEFORE_MS) return; // renewed meanwhile
    const vm = await deps.launch();
    try {
      const account = await renew(vm.exec, current, (fresh) => store.saveCredentials(name, fresh, now()));
      // Tokens for another account would hand the bots someone else's connectors: kept, never published.
      if (account && account.orgId !== org) { state.foreign.add(name); throw new Error("another account"); }
    } finally {
      await vm.close().catch(() => {});
    }
  });

  const keep = async (name: string, org: string, first: boolean): Promise<void> => {
    if (stopped) return;
    try {
      let credentials = await store.credentials(name);
      const ended = credentials.refreshTokenExpiresAt !== undefined && credentials.refreshTokenExpiresAt <= now();
      const due = credentials.expiresAt - now() < RENEW_BEFORE_MS && !ended && !state.foreign.has(name);
      const wait = (state.retryAt.get(name) ?? 0) - now();
      if (due && (first || wait > 0)) {
        await publish(name, usable(name, credentials));
        later(Math.max(0, wait), () => keep(name, org, false));
        return;
      }
      if (due) {
        await renewKey(name, org);
        state.retryAt.delete(name);
        credentials = await store.credentials(name);
      }
      await publish(name, usable(name, credentials));
      if (ended || state.foreign.has(name)) {
        if (!usable(name, credentials)) options.log?.(`Claude sign-in '${name}' has ended: its bots get no answers from Claude until it is signed in again (house key claude ${name})`);
        later(60 * 60_000, () => keep(name, org, false));
      } else {
        later(credentials.expiresAt - RENEW_BEFORE_MS - now(), () => keep(name, org, false));
      }
    } catch {
      if (stopped) return;
      state.retryAt.set(name, now() + RETRY_MS);
      // A token still alive goes on being used until it runs out; renewal is tried again meanwhile.
      const alive = usable(name, await store.credentials(name).catch(() => undefined));
      await publish(name, alive);
      options.log?.(alive
        ? `Claude sign-in '${name}': renewal failed; its token holds for now, retrying in 5 minutes`
        : `Claude sign-in '${name}' has no live token: its bots get no answers from Claude; retrying in 5 minutes (or sign in again: house key claude ${name})`);
      later(RETRY_MS, () => keep(name, org, false));
    }
  };

  await Promise.all(keys.map(({ name, value }) => keep(name, parseSigninMarker(value)!, true)));
  return { stop() { stopped = true; for (const timer of timers) clearTimeout(timer); timers.clear(); } };
}

const DAY_MS = 86_400_000;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** How long before a sign-in ends its bots' owners hear of it, once a day. */
export const REMIND_DAYS = 5;

/**
 * Today's reminder for sign-in `key` (its bots' chats say it), or undefined: none until its last days, one a day
 * then (`last`: the day of the one said before, `YYYY-MM-DD`), and one when it has ended.
 */
export function signinReminder(key: string, info: Pick<SigninInfo, "endsAt" | "email">, now: number, last: string | undefined): { day: string; text: string } | undefined {
  if (info.endsAt === undefined) return undefined;
  const day = new Date(now).toISOString().slice(0, 10);
  if (last === day) return undefined;
  const left = info.endsAt - now;
  if (left > REMIND_DAYS * DAY_MS) return undefined;
  const again = `Sign in again: Keys → ${key} → Sign in again, or <code>house key claude ${key}</code>.`;
  if (left <= 0) return { day, text: `Claude sign-in <b>${key}</b> has ended: bots on it get no answers from Claude. ${again}` };
  const days = Math.ceil(left / DAY_MS);
  const when = new Date(info.endsAt).toLocaleDateString("en", { day: "numeric", month: "short" });
  return { day, text: `Claude sign-in <b>${key}</b>${info.email ? ` (${escapeHtml(info.email)})` : ""} ends ${days === 1 ? "tomorrow" : `in ${days} days`}, on ${when}: Claude asks for a new sign-in about monthly. ${again}` };
}
