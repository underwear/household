import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexAuthEnvironment, readLocalCodexAuth, refreshLocalCodexAuth, type LocalCodexAuth } from "../agent-adapters/codex-app-server/host-auth";
import { hostCodex } from "../agent-adapters/codex-app-server/host-codex";
import { parseSubscriptionMarker, SUBSCRIPTION_PREFIX } from "../agent-adapters/codex-app-server/auth";
import { assertAuthDestination, dedicatedAuthRoot } from "../app/codex-auth-backup";
import { HouseholdError } from "../core/errors";
import { assertName } from "../core/names";
import type { ConfigStore } from "../infra/config-store";
import type { Paths } from "../infra/paths";

/** Household's own auth store for subscription `name`, made private; its auth.json, and whether one is there. */
async function dedicatedHome(paths: Paths, config: ConfigStore, name: string) {
  assertName("key", name); // before a name can become a directory
  const existing = (await config.load()).keys.find((key) => key.name === name);
  if (existing && (existing.provider !== "openai" || !parseSubscriptionMarker(existing.value))) {
    throw new HouseholdError(`key '${name}' already exists: choose another name for the subscription`);
  }
  const root = dedicatedAuthRoot(paths.configFile);
  assertAuthDestination(root, name);
  const home = join(root, name);
  const file = join(home, "auth.json");
  const present = lstatSync(file, { throwIfNoEntry: false });
  if (present && !present.isFile()) throw new HouseholdError("dedicated Codex auth.json must be a plain file");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  return { existing, home, file, present: Boolean(present) };
}

/** The login in `home`, refreshed by Household's Codex when it has expired; undefined when it cannot be. */
async function usableLogin(home: string): Promise<LocalCodexAuth | undefined> {
  try { return await readLocalCodexAuth(undefined, { home }); } catch {
    try {
      await refreshLocalCodexAuth(home);
      return await readLocalCodexAuth(undefined, { home });
    } catch { return undefined; }
  }
}

async function saveSubscription(config: ConfigStore, name: string, file: string, auth: LocalCodexAuth, note: string, existing?: { note?: string }) {
  chmodSync(file, 0o600);
  const fields = { provider: "openai", value: `${SUBSCRIPTION_PREFIX}${auth.accountId}`, note: existing?.note ?? note };
  if (existing) await config.updateKey(name, fields);
  else await config.addKey(name, fields);
}

/**
 * A subscription belongs to Household's config, independently of any host Codex installation: Household's own Codex
 * signs in (a device code, so from any browser, a phone too) into its own auth store.
 */
export async function connectCodex(paths: Paths, config: ConfigStore, name: string, note?: string): Promise<void> {
  const { existing, home, file, present } = await dedicatedHome(paths, config, name);
  let auth = present ? await usableLogin(home) : undefined; // a failed or expired login is replaced by a new one
  if (!auth) {
    console.log(`Sign in to ChatGPT for Household subscription '${name}'; this login is stored with Household and included in its backups.`);
    let child;
    try {
      child = Bun.spawn([hostCodex(), "-c", 'forced_login_method="chatgpt"', "-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"], {
        cwd: home, env: codexAuthEnvironment(home), stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
    } catch {
      throw new HouseholdError("could not start Household's Codex: run `bun run setup` in the Household checkout, then try again");
    }
    const halt = () => child.kill("SIGTERM");
    process.once("SIGINT", halt);
    process.once("SIGTERM", halt);
    try {
      if (await child.exited !== 0) throw new HouseholdError("Codex subscription login did not finish; no key was saved");
    } finally {
      process.off("SIGINT", halt);
      process.off("SIGTERM", halt);
    }
    auth = await readLocalCodexAuth(undefined, { home });
  }
  await saveSubscription(config, name, file, auth, note ?? "Household ChatGPT subscription", existing);
  console.log(`subscription '${name}' connected; dedicated credentials stay with Household`);
}

/** A Codex's ChatGPT login on this machine: its auth.json, and whose it is. */
export interface LocalCodexLogin { file: string; email?: string; plan?: string }

/** The ChatGPT login of the Codex at `codexHome` (`$CODEX_HOME`, else ~/.codex), or undefined when it has none. */
export function localCodexLogin(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")): LocalCodexLogin | undefined {
  const file = join(codexHome, "auth.json");
  try {
    const auth = JSON.parse(readFileSync(file, "utf8"));
    if (auth.auth_mode !== "chatgpt" || typeof auth.tokens?.refresh_token !== "string") return undefined;
    let claims: Record<string, unknown> = {};
    try { claims = JSON.parse(Buffer.from(String(auth.tokens.id_token).split(".")[1] ?? "", "base64url").toString("utf8")); } catch { /* who it is is a nicety */ }
    const plan = (claims["https://api.openai.com/auth"] as { chatgpt_plan_type?: unknown } | undefined)?.chatgpt_plan_type;
    return { file, ...(typeof claims.email === "string" ? { email: claims.email } : {}), ...(typeof plan === "string" ? { plan } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Subscription `name` from a copy of a Codex's ChatGPT login (this machine's by default); Household refreshes its copy
 * itself from then on. The two share one sign-in: when it ends there, Household is signed in again.
 */
export async function importCodex(paths: Paths, config: ConfigStore, name: string, source = localCodexLogin(), note?: string): Promise<LocalCodexLogin> {
  if (!source) throw new HouseholdError("no ChatGPT login of Codex on this machine (`codex login` makes one)");
  const { existing, home, file } = await dedicatedHome(paths, config, name);
  copyFileSync(source.file, file);
  chmodSync(file, 0o600);
  const auth = await usableLogin(home);
  if (!auth) {
    rmSync(file, { force: true });
    throw new HouseholdError("that Codex login has ended: sign in to Codex again (`codex login`), then try again");
  }
  await saveSubscription(config, name, file, auth, note ?? `ChatGPT login copied from this machine's Codex${source.email ? ` (${source.email})` : ""}`, existing);
  return source;
}
