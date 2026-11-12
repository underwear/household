import type { ClaudeSigninView, KeysView } from "../app/web-views";
import { HouseholdError } from "../core/errors";
import type { Paths } from "../infra/paths";
import { api } from "./commands";
import { bold, dim, green, yellow, type Terminal } from "./terminal";

/** What a Claude sign-in means, said once before it starts (the web says the same). */
const POINTS = [
  "Your bots can use this Claude account's connectors (Drive, Jira…), as that account.",
  "Household keeps it fresh; about once a month Claude ends it and Household asks you to sign in again.",
  "It's Household's own sign-in: your Claude on this computer stays as it is.",
];

/**
 * Key `name` as a Claude sign-in, through the daemon: it boots a throwaway VM running Claude Code's own login and
 * gives its link; the code Claude's page shows is typed back. Asks again on a refused code.
 */
export async function signInClaude(t: Terminal, paths: Paths, name: string): Promise<void> {
  t.say(bold(`Sign in to Claude for key '${name}'`));
  for (const point of POINTS) t.say(dim(`  · ${point}`));
  for (;;) {
    t.say(dim("  Starting Claude's sign-in…"));
    const { id, url } = await api<ClaudeSigninView>(paths, "POST", "/api/keys/claude/signin", { name });
    t.say(`  1. Open this on any device and sign in to the account your bots should use:`);
    t.say(`     ${url}`);
    const code = await t.ask("  2. Paste the code Claude shows: ");
    if (!code) {
      await api(paths, "DELETE", `/api/keys/claude/signin/${encodeURIComponent(id)}`).catch(() => undefined);
      throw new HouseholdError("no code, so no sign-in: run it again when you have one");
    }
    try {
      const { keys } = await api<KeysView>(paths, "POST", `/api/keys/claude/signin/${encodeURIComponent(id)}`, { code });
      const signin = keys.find((key) => key.name === name)?.signin;
      const who = [signin?.email, signin?.orgName, signin?.subscriptionType].filter(Boolean).join(" · ");
      t.say(`${green("✓")} key '${name}' signed in${who ? `: ${who}` : ""}.`);
      if (signin?.endsAt) t.say(dim(`  Household renews it by itself; sign in again by ${new Date(signin.endsAt).toLocaleDateString()} (house key claude ${name}).`));
      return;
    } catch (error) {
      t.say(yellow(`  ${(error as Error).message}`));
      if ((await t.ask("  Try again with a new link? [Y/n] ")).toLowerCase().startsWith("n")) throw new HouseholdError("not signed in");
    }
  }
}

/** `--link`: starts key `name`'s sign-in and prints its link, without waiting (the daemon keeps it 10 minutes). */
export async function claudeSigninLink(paths: Paths, name: string): Promise<void> {
  const { url } = await api<ClaudeSigninView>(paths, "POST", "/api/keys/claude/signin", { name });
  console.log(`Open this on any device and sign in to the Claude account the bots should use (it works once, for 10 minutes):`);
  console.log(url);
  console.log(`Then: house key claude ${name} --code <the code Claude shows>`);
}

/** `--code`: the code for key `name`'s waiting sign-in; saves the key. */
export async function claudeSigninCode(paths: Paths, name: string, code: string): Promise<void> {
  const { keys } = await api<KeysView>(paths, "POST", `/api/keys/${encodeURIComponent(name)}/claude-signin/code`, { code });
  const signin = keys.find((key) => key.name === name)?.signin;
  const who = [signin?.email, signin?.orgName, signin?.subscriptionType].filter(Boolean).join(" · ");
  console.log(`key '${name}' signed in${who ? `: ${who}` : ""}${signin?.endsAt ? `; sign in again by ${new Date(signin.endsAt).toLocaleDateString()}` : ""}`);
}
