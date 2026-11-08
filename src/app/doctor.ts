import { MICROSANDBOX_VERSION } from "../infra/microsandbox-runtime";
import { statSync } from "node:fs";
import { getMe, isBotToken, isRefusedToken } from "../channel-adapters/telegram";
import { channelName, platformOf } from "../core/channels";
import { sameOwner, type Household } from "../core/household";
import type { ConfigStore } from "../infra/config-store";
import { callControl } from "../infra/control-socket";
import type { Paths } from "../infra/paths";
import { placePets, type Agents, type PlacedPet } from "./agents";
import { assertOwners, knownChannelKinds } from "./kinds";
import type { StatusReport } from "./daemon";

/** One line of `house doctor`. */
export interface Finding {
  ok: boolean;
  text: string;
  /** Worth a look, not a failure (the check still counts as passed). */
  warning?: true;
}

export interface DoctorDeps {
  paths: Paths;
  config: ConfigStore;
  agents: Agents;
  /** Runs a command: its stdout, or why it failed in `stderr`. */
  run: (command: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Bot API base URL; the real one when absent. */
  telegramApi?: string;
}

const firstLine = (text: string) => text.split("\n")[0]!.trim();

/**
 * Checks what Household needs, in plain words: Docker, openssl, the config (only its owner may read it: it holds
 * the keys and bot tokens; each pet has a key), each bot's token with Telegram (the only network call), the daemon.
 */
export async function doctor({ paths, config, agents, run, telegramApi }: DoctorDeps): Promise<Finding[]> {
  const findings: Finding[] = [];
  const docker = await run(["docker", "info", "--format", "{{.OperatingSystem}}, Docker {{.ServerVersion}}"]);
  findings.push(
    docker.ok
      ? { ok: true, text: `docker: ${docker.stdout}` }
      : { ok: false, text: `docker: not reachable (${firstLine(docker.stderr)}); start OrbStack (or Docker)` },
  );
  const msb = await run(["msb", "--version"]);
  const expected = `msb ${MICROSANDBOX_VERSION}`;
  if (!msb.ok || msb.stdout.trim() !== expected) findings.push({ ok: false, text: `microsandbox: requires ${MICROSANDBOX_VERSION}; install the pinned runtime` });
  else {
    const ready = await run(["msb", "doctor"]);
    findings.push(ready.ok ? { ok: true, text: `microsandbox: ${MICROSANDBOX_VERSION}, virtualization ready` } : { ok: false, text: "microsandbox: virtualization unavailable; run msb doctor (Linux requires /dev/kvm)" });
  }
  const python = await run(["python3", "--version"]);
  findings.push({ ok: python.ok, text: python.ok ? "python3: file helpers ready (skills, instructions, inbox)" : "python3: required for house skills, pet instructions and inbox files" });
  const openssl = await run(["openssl", "version"]);
  findings.push(
    openssl.ok
      ? { ok: true, text: `openssl: ${firstLine(openssl.stdout)}` }
      : { ok: false, text: "openssl: not found; Household makes its certificates with it, install it" },
  );

  const mode = (statSync(paths.configFile, { throwIfNoEntry: false })?.mode ?? 0) & 0o777;
  if (mode & 0o077) findings.push({ ok: false, text: `config: others can read it (mode ${mode.toString(8)}), and it holds keys and bot tokens; chmod 600 ${paths.configFile}` });
  let household: Household | undefined;
  try {
    household = await config.load();
    const pets = placePets(agents, household);
    assertOwners(household.houses); // an owner the config names wrong is a config error
    const houses = household.houses.map((house) => house.name).join(", ") || "none";
    findings.push({ ok: true, text: `config: valid, houses: ${houses}, pets: ${pets.length} (${paths.configFile})` });
    for (const house of household.houses) {
      for (const channel of house.channels) {
        const platform = platformOf(knownChannelKinds(), channel.kind);
        if (channel.kind !== "telegram-private" || !platform || house.people.owners.some((owner) => sameOwner(owner, { platform, id: channel.chat }))) continue;
        const text = `channel ${channelName(knownChannelKinds(), channel)} of house ${house.name}: its chat ${channel.chat} is not among the owners, so its person is a guest there (\`house owner add ${house.name} ${platform} ${channel.chat}\` if they are yours)`;
        findings.push({ ok: true, warning: true, text });
      }
    }
    for (const { key, kind, pets: users } of keyUsers(pets)) findings.push({ ok: true, text: `key ${key} (${kind}): pets ${users.join(", ")}` });
    const bots = new Map<string, string>();
    for (const house of household.houses) {
      for (const channel of house.channels) if (!bots.has(channel.token)) bots.set(channel.token, `house ${house.name}, channel ${channelName(knownChannelKinds(), channel)}`);
    }
    for (const [token, where] of bots) findings.push(await checkBot(where, token, telegramApi));
  } catch (error) {
    findings.push({ ok: false, text: `config: ${(error as Error).message}` });
  }

  try {
    const status = await callControl<StatusReport>(paths.socket, "/status");
    findings.push(
      status
        ? { ok: true, text: `daemon: ${status.state}, ${status.pets.length} pets` }
        : { ok: true, text: "daemon: not running; start it with `house start`" },
    );
  } catch (error) {
    findings.push({ ok: false, text: `daemon: does not answer properly (${(error as Error).message})` });
  }
  return findings;
}

/** The keys the pets run on, each with its pets. */
function keyUsers(pets: PlacedPet[]): { key: string; kind: string; pets: string[] }[] {
  const users = new Map<string, { kind: string; pets: string[] }>();
  for (const { house, pet, key, keyUse } of pets) {
    const entry = users.get(key) ?? users.set(key, { kind: keyUse.kind, pets: [] }).get(key)!;
    entry.pets.push(`${house}/${pet}`);
  }
  return [...users].map(([key, entry]) => ({ key, ...entry }));
}

/** Telegram's `getMe` with the token: it must be valid, and the bot needs threads (Threaded Mode). Says where it is, never the token. */
async function checkBot(where: string, token: string, apiBase?: string): Promise<Finding> {
  const which = `of ${where}`;
  if (!isBotToken(token)) return { ok: false, text: `bot ${which}: its token is not a bot token (one looks like 123456789:AAH4x…, from @BotFather); not sent to Telegram` };
  try {
    const me = await getMe(token, apiBase);
    if (!me.has_topics_enabled) {
      return { ok: false, text: `bot ${which}: @${me.username} has threads off; turn on Threaded Mode in BotFather (Bot Settings → Threads Settings)` };
    }
    return { ok: true, text: `bot ${which}: @${me.username}, threads on` };
  } catch (error) {
    // A TelegramError never holds the token.
    const what = isRefusedToken(error) ? "Telegram did not accept the token" : "Telegram unreachable";
    return { ok: false, text: `bot ${which}: ${what} (${(error as Error).message})` };
  }
}
