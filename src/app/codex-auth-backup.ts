import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSubscriptionMarker } from "../agent-adapters/codex-app-server/auth";
import { HouseholdError } from "../core/errors";
import type { AgentKey } from "../core/keys";

export const CODEX_AUTH_BACKUP = "codex-auth";

export function subscriptionAuthKeys(keys: AgentKey[]): { name: string; accountId: string }[] {
  return keys.flatMap(({ name, provider, value }) => {
    const accountId = provider === "openai" ? parseSubscriptionMarker(value) : undefined;
    return accountId ? [{ name, accountId }] : [];
  });
}

export const dedicatedAuthRoot = (configFile: string) => join(dirname(configFile), CODEX_AUTH_BACKUP);

/** Never follows a symlink to an unrelated CLI's auth, on either export or restore. */
export function readDedicatedAuth(root: string, name: string, accountId: string): string {
  const home = join(root, name);
  const file = join(home, "auth.json");
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory() || !lstatSync(home, { throwIfNoEntry: false })?.isDirectory() || !lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new HouseholdError(`Codex subscription ${name}: a plain dedicated auth.json is required for backup`);
  }
  try {
    const content = readFileSync(file, "utf8");
    const auth = JSON.parse(content);
    // Expired access tokens remain portable: the dedicated refresh token renews them after restore.
    if (auth.auth_mode !== "chatgpt" || auth.tokens?.account_id !== accountId || typeof auth.tokens?.access_token !== "string" || !auth.tokens.access_token || typeof auth.tokens?.refresh_token !== "string" || !auth.tokens.refresh_token.trim()) throw new Error();
    return content;
  } catch {
    throw new HouseholdError(`Codex subscription ${name}: dedicated authentication does not match its configured account`);
  }
}

export function assertAuthDestination(root: string, name: string): void {
  for (const path of [root, join(root, name)]) {
    const present = lstatSync(path, { throwIfNoEntry: false });
    if (present && !present.isDirectory()) throw new HouseholdError(`Codex subscription ${name}: dedicated auth directory must be a plain folder`);
  }
}

export function copyDedicatedAuth(content: string, root: string, name: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const home = join(root, name);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "auth.json"), content, { mode: 0o600, flag: "wx" });
  chmodSync(join(home, "auth.json"), 0o600);
}

/** Whose a ChatGPT sign-in is (its id token's email and plan) and when its token runs out, for the key list; undefined when unreadable. */
export function codexSigninInfo(root: string, name: string): { email?: string; subscriptionType?: string; expiresAt: number } | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(root, name, "auth.json"), "utf8"));
    const claims = (token: unknown) => JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"));
    const id = claims(auth.tokens?.id_token);
    const access = claims(auth.tokens?.access_token);
    const plan = id["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return { ...(typeof id.email === "string" ? { email: id.email } : {}), ...(typeof plan === "string" ? { subscriptionType: plan } : {}), expiresAt: Number(access.exp) * 1000 };
  } catch {
    return undefined;
  }
}
