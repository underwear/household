import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseSubscriptionMarker } from "./auth";
import { hostCodex } from "./host-codex";

export interface LocalCodexAuth {
  accountId: string;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const invalid = () => new Error("Codex ChatGPT authentication is unavailable or invalid; sign in to Codex again");

/** Host-only: never send this result to a pet, config response, or log. No API-key fallback. */
export async function readLocalCodexAuth(accountId?: string, options: { home?: string; now?: number } = {}): Promise<LocalCodexAuth> {
  try {
    if (!options.home) throw invalid();
    const auth = JSON.parse(await readFile(join(options.home, "auth.json"), "utf8"));
    if (auth.auth_mode !== "chatgpt" || !auth.tokens || typeof auth.tokens.account_id !== "string" || !auth.tokens.account_id) throw invalid();
    if (accountId !== undefined && auth.tokens.account_id !== accountId) throw invalid();
    const accessToken = auth.tokens.access_token;
    if (typeof accessToken !== "string") throw invalid();
    const pieces = accessToken.split(".");
    if (pieces.length !== 3 || pieces.some((piece) => !/^[A-Za-z0-9_-]+$/.test(piece))) throw invalid();
    const claims = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString("utf8"));
    const expiresAt = claims.exp * 1000;
    if (typeof claims.exp !== "number" || !Number.isFinite(expiresAt) || expiresAt <= (options.now ?? Date.now())) throw invalid();
    const claimedAccount = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (claimedAccount !== undefined && claimedAccount !== auth.tokens.account_id) throw invalid();
    return { accountId: auth.tokens.account_id, accessToken, expiresAt };
  } catch {
    // JSON parse errors can quote token contents; filesystem and protocol errors can expose host paths.
    throw invalid();
  }
}

/** No inherited API keys, provider/base-URL overrides, proxy, config, or workspace. */
export function codexAuthEnvironment(home: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { CODEX_HOME: home };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (source[key]) env[key] = source[key]!;
  }
  return env;
}

const refreshing = new Map<string, Promise<void>>();

/** Refresh only the managed auth store. Never creates a thread, starts a turn, or authorizes a server request. */
export async function refreshLocalCodexAuth(home: string, run = runCodexAuthServer): Promise<void> {
  let source: string;
  try { source = await realpath(join(home, "auth.json")); } catch { throw invalid(); }
  const existing = refreshing.get(source);
  if (existing) return existing;
  const work = refreshFile(source, run);
  refreshing.set(source, work);
  try { await work; } finally { if (refreshing.get(source) === work) refreshing.delete(source); }
}

async function refreshFile(source: string, run: (home: string, cwd: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(dirname(source), ".household-auth-refresh-"));
  const home = join(root, "home");
  const linked = join(home, "auth.json");
  try {
    await mkdir(home, { mode: 0o700 });
    const before = await stat(source);
    await symlink(source, linked);
    await run(home, root);
    // Some CLI versions atomically replace auth.json rather than writing through its symlink. Move the
    // newly refreshed store back, without reading/copying refresh tokens or leaving a second credential file.
    const updated = await lstat(linked);
    if (!updated.isSymbolicLink()) {
      const after = await stat(source);
      if (!updated.isFile() || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw invalid();
      await chmod(linked, 0o600);
      await rename(linked, source);
    }
  } catch {
    throw invalid();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runCodexAuthServer(home: string, cwd: string, command = hostCodex(), timeoutMs = 30_000): Promise<void> {
  const child = spawn(command, ["app-server", "--stdio", "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"', "-c", 'cli_auth_credentials_store="file"'], {
    cwd, env: codexAuthEnvironment(home), stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  let closed = false;
  const ended = new Promise<void>((done) => child.once("close", () => { closed = true; done(); }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((done, reject) => {
      const fail = () => reject(invalid());
      const send = (packet: object) => child.stdin.write(`${JSON.stringify(packet)}\n`);
      timer = setTimeout(fail, timeoutMs);
      child.once("error", fail);
      child.once("exit", fail);
      let initialized = false;
      lines.on("line", (line) => {
        if (line.length > 1024 * 1024) return fail();
        let packet;
        try { packet = JSON.parse(line); } catch { return fail(); }
        if (packet.method && packet.id !== undefined) {
          send({ id: packet.id, error: { code: -32601, message: "Auth-only client" } });
          return fail();
        }
        if (packet.id === 1 && !initialized) {
          if (packet.error) return fail();
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
        } else if (packet.id === 2 && initialized) {
          if (packet.error || packet.result?.account?.type !== "chatgpt") return fail();
          done();
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "household_auth", title: "Household auth", version: "0.1.0" } } });
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill("SIGTERM");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([ended, new Promise<void>((done) => { killTimer = setTimeout(done, 500); })]);
    clearTimeout(killTimer);
    if (!closed) {
      child.kill("SIGKILL");
      await ended;
    }
    lines.close();
  }
}

export interface CodexRefreshOptions {
  keys: { name: string; value: string; home: string }[];
  /** undefined revokes a previously published credential. */
  onToken: (name: string, token: string | undefined) => void | Promise<void>;
  /** Fixed diagnostic text only, never exceptions from auth or the child. */
  log?: (text: string) => void;
}

export interface CodexRefreshDependencies {
  read?: (accountId: string, home: string) => Promise<LocalCodexAuth>;
  refresh?: (home: string) => Promise<void>;
  now?: () => number;
  /** Maximum time between managed-store checks. */
  intervalMs?: number;
  retryMs?: number;
}

/** Initial credentials are ready before resolving; stop prevents any subsequent publication. */
export async function startCodexRefresh(options: CodexRefreshOptions, deps: CodexRefreshDependencies = {}): Promise<{ stop(): void }> {
  if (options.keys.length === 0) return { stop() {} };
  const keys = options.keys.map(({ name, value, home }) => {
    const accountId = parseSubscriptionMarker(value);
    if (!accountId || !home) throw invalid();
    return { name, accountId, home };
  });
  const read = deps.read ?? ((accountId, home) => readLocalCodexAuth(accountId, { home }));
  const refresh = deps.refresh ?? ((home) => refreshLocalCodexAuth(home));
  const now = deps.now ?? Date.now;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = async (token: string | undefined) => {
    for (const { name } of keys) {
      if (stopped) return;
      await options.onToken(name, token);
    }
  };
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void update(false).catch(() => options.log?.("Codex credential publication failed")); }, ms);
    timer.unref?.();
  };
  const update = async (initial: boolean): Promise<void> => {
    try {
      const prepared: { name: string; auth: LocalCodexAuth }[] = [];
      const refreshedHomes = new Set<string>();
      for (const { name, home, accountId } of keys) {
        if (!refreshedHomes.has(home)) {
          await refresh(home);
          refreshedHomes.add(home);
        }
        if (stopped) return;
        const auth = await read(accountId, home);
        if (stopped) return;
        if (auth.accountId !== accountId || auth.expiresAt <= now() + 30_000) throw invalid();
        prepared.push({ name, auth });
      }
      for (const { name, auth } of prepared) {
        if (stopped) return;
        await options.onToken(name, auth.accessToken);
      }
      const expiresAt = Math.min(...prepared.map(({ auth }) => auth.expiresAt));
      schedule(Math.max(1000, Math.min(deps.intervalMs ?? 60_000, expiresAt - now() - 5 * 60_000)));
    } catch {
      if (stopped) return;
      await publish(undefined);
      if (initial) throw invalid();
      options.log?.("Codex subscription refresh failed; its gateway credential was revoked");
      schedule(deps.retryMs ?? 30_000);
    }
  };
  await update(true);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
