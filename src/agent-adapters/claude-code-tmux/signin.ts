/*
 * A Claude sign-in Household holds: the full claude.ai login of Claude Code (scope user:mcp_servers, so the bots get
 * the account's claude.ai connectors), made and renewed by Claude Code itself in a throwaway VM of this harness's
 * image. Household never speaks OAuth: it hands the person the link Claude Code prints, types back the code they
 * bring, and keeps the credentials file Claude Code writes.
 *
 * What Claude Code 2.1.296 does with such a login (measured 2026-11-12): its access token lasts 8 hours (a year is
 * granted only to inference-only tokens, `claude setup-token`'s); every renewal rotates both tokens, the old ones
 * dying at once; the refresh token ends about 29 days after the sign-in, renewals not moving that day.
 */

/** A key's value for a sign-in Household holds: a reference, no credential (the tokens stay in Household's files). */
export const SIGNIN_PREFIX = "claude-signin:";

/** The account a `claude-signin:` key refers to (its organisation's id), or undefined when the value is none. */
export function parseSigninMarker(value: string): string | undefined {
  if (!value.startsWith(SIGNIN_PREFIX)) return undefined;
  const org = value.slice(SIGNIN_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/.test(org) ? org : undefined;
}

/** The scopes a bot's claude is told its token has (`CLAUDE_CODE_OAUTH_SCOPES`): enough for claude.ai connectors. */
export const SIGNIN_SCOPES = "user:inference user:mcp_servers";

/** Claude Code's credentials file (`~/.claude/.credentials.json` on Linux), as Household keeps it. */
export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** When the sign-in itself ends (epoch ms): renewals cannot go past it. */
  refreshTokenExpiresAt?: number;
  scopes: string[];
  subscriptionType?: string;
}

/** Whose sign-in it is, from `claude auth status`: shown to the owner, and checked on every renewal. */
export interface ClaudeAccount {
  email?: string;
  orgId: string;
  orgName?: string;
  subscriptionType?: string;
}

const invalid = () => new Error("Claude sign-in is unavailable or invalid; sign in again");

/** The credentials in Claude Code's file, checked; an error that quotes nothing of it otherwise. */
export function parseCredentials(text: string): ClaudeCredentials {
  try {
    const oauth = JSON.parse(text)?.claudeAiOauth;
    const ok = typeof oauth?.accessToken === "string" && oauth.accessToken.startsWith("sk-ant-oat")
      && typeof oauth.refreshToken === "string" && oauth.refreshToken.startsWith("sk-ant-ort")
      && Number.isFinite(oauth.expiresAt) && Array.isArray(oauth.scopes) && oauth.scopes.every((scope: unknown) => typeof scope === "string");
    if (!ok) throw invalid();
    return {
      accessToken: oauth.accessToken, refreshToken: oauth.refreshToken, expiresAt: oauth.expiresAt, scopes: oauth.scopes,
      ...(Number.isFinite(oauth.refreshTokenExpiresAt) ? { refreshTokenExpiresAt: oauth.refreshTokenExpiresAt } : {}),
      ...(typeof oauth.subscriptionType === "string" ? { subscriptionType: oauth.subscriptionType } : {}),
    };
  } catch {
    throw invalid(); // a JSON error can quote the token
  }
}

/** The file Claude Code reads, from what Household keeps. */
export function credentialsFile(credentials: ClaudeCredentials): string {
  return `${JSON.stringify({ claudeAiOauth: credentials }, null, 2)}\n`;
}

/** `claude auth status` (JSON) as Household keeps it; undefined when it is not a claude.ai sign-in. */
export function parseStatus(text: string): ClaudeAccount | undefined {
  try {
    const status = JSON.parse(text.slice(text.indexOf("{")));
    if (status.loggedIn !== true || status.authMethod !== "claude.ai" || typeof status.orgId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(status.orgId)) return undefined;
    return {
      orgId: status.orgId,
      ...(typeof status.email === "string" ? { email: status.email } : {}),
      ...(typeof status.orgName === "string" ? { orgName: status.orgName } : {}),
      ...(typeof status.subscriptionType === "string" ? { subscriptionType: status.subscriptionType } : {}),
    };
  } catch {
    return undefined;
  }
}

/** A command in the throwaway VM, as the agent user: its exit and output. */
export type VmExec = (command: string[], stdin?: string, timeoutMs?: number) => Promise<{ ok: boolean; output: string }>;

const LOGIN_SESSION = "signin";
const CONFIG = "/home/agent/.household-signin";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Where Claude Code says to sign in (it prints the link whole when the pane is wide enough). */
const LINK = /https:\/\/claude\.(?:com|ai)\/[^\s"'<>]*oauth\/authorize\?[^\s"'<>]+/;

/** The code the person brings back from Claude's page: `<code>#<state>`, nothing a shell or tmux would read. */
export function checkCode(code: string): string {
  const trimmed = code.trim();
  if (!/^[A-Za-z0-9_-]{8,512}(?:#[A-Za-z0-9_-]{8,512})?$/.test(trimmed)) throw new Error("That is not the code Claude's page shows (letters and digits, often with a # in the middle). Copy it again.");
  return trimmed;
}

/** The link the VM's waiting `claude auth login` printed, for the person to open on any device. */
export async function startLogin(exec: VmExec, poll = { tries: 60, everyMs: 500 }): Promise<string> {
  // The VM's entrypoint started it (`HOUSEHOLD_UTILITY=signin`): its tmux outlives any one command of Household's.
  for (let i = 0; i < poll.tries; i++) {
    const pane = await exec(["tmux", "capture-pane", "-p", "-J", "-t", LOGIN_SESSION]);
    const link = pane.ok ? LINK.exec(pane.output)?.[0] : undefined;
    if (link) return link;
    await sleep(poll.everyMs);
  }
  throw new Error("Claude Code printed no sign-in link");
}

/**
 * Types the person's code into the waiting `claude auth login`, then reads what Claude Code saved: the credentials
 * and whose they are. Claude Code's own refusal is said as it put it.
 */
export async function finishLogin(exec: VmExec, code: string, poll = { tries: 60, everyMs: 500 }): Promise<{ credentials: ClaudeCredentials; account: ClaudeAccount }> {
  const typed = checkCode(code);
  if (!(await exec(["tmux", "send-keys", "-t", LOGIN_SESSION, "-l", typed])).ok || !(await exec(["tmux", "send-keys", "-t", LOGIN_SESSION, "Enter"])).ok) {
    throw new Error("The sign-in VM did not take the code; start the sign-in again");
  }
  for (let i = 0; i < poll.tries; i++) {
    await sleep(poll.everyMs);
    const saved = await exec(["cat", `${CONFIG}/.credentials.json`]);
    if (saved.ok && saved.output.trim()) return { credentials: parseCredentials(saved.output), account: await status(exec, CONFIG) };
    const pane = await exec(["tmux", "capture-pane", "-p", "-J", "-t", LOGIN_SESSION]);
    const failed = pane.ok ? /(?:Login failed|OAuth error|Invalid code|failed)[^\n]*/i.exec(pane.output)?.[0] : undefined;
    if (failed) throw new Error(`Claude did not take that code (${failed.trim().slice(0, 160)}). Start the sign-in again: each link works once.`);
    if (!pane.ok && !saved.ok) break; // the session ended without saving
  }
  throw new Error("Claude Code did not finish the sign-in; start it again");
}

async function status(exec: VmExec, dir: string): Promise<ClaudeAccount> {
  const result = await exec(["env", `CLAUDE_CONFIG_DIR=${dir}`, "claude", "auth", "status"], undefined, 30_000);
  const account = result.ok ? parseStatus(result.output) : undefined;
  if (!account) throw new Error("Claude Code signed in, but not to a claude.ai account (an API key or Console login?). Sign in with your Claude subscription.");
  return account;
}

/**
 * Renews a sign-in the way Claude Code itself offers (`CLAUDE_CODE_OAUTH_REFRESH_TOKEN` with `claude auth login`).
 * The old tokens die in that moment, so the new ones go to `save` as soon as they are read, before anything else can
 * fail; then whose they are, if Claude says (undefined when it does not: they are the same sign-in's anyway).
 */
export async function renew(exec: VmExec, current: ClaudeCredentials, save: (credentials: ClaudeCredentials) => Promise<void>): Promise<ClaudeAccount | undefined> {
  const dir = "/home/agent/.household-renew";
  // The refresh token goes in by stdin to a file of the VM's own, never on a command line.
  const script = `set -e; umask 077; rm -rf ${dir}; mkdir -p ${dir}; IFS= read -r token; IFS= read -r scopes
CLAUDE_CONFIG_DIR=${dir} CLAUDE_CODE_OAUTH_REFRESH_TOKEN="$token" CLAUDE_CODE_OAUTH_SCOPES="$scopes" claude auth login >/dev/null 2>&1`;
  const ran = await exec(["sh", "-c", script], `${current.refreshToken}\n${current.scopes.join(" ")}\n`, 60_000);
  if (!ran.ok) throw new Error("Claude refused to renew the sign-in (it has ended or was signed out): sign in again");
  const saved = await exec(["cat", `${dir}/.credentials.json`]);
  if (!saved.ok) throw invalid();
  await save(parseCredentials(saved.output));
  return status(exec, dir).catch(() => undefined);
}
