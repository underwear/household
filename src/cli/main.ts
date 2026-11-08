#!/usr/bin/env bun
import { codexAuthEnvironment, readLocalCodexAuth, refreshLocalCodexAuth } from "../agent-adapters/codex-app-server/host-auth";
import { parseSubscriptionMarker, SUBSCRIPTION_PREFIX } from "../agent-adapters/codex-app-server/auth";
import { parseArgs } from "node:util";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertName } from "../core/names";
import { assertAuthDestination, dedicatedAuthRoot } from "../app/codex-auth-backup";
import { runDaemon, type DashboardLink, type ReloadReport, type StatusReport } from "../app/daemon";
import { formatVersion, householdVersion } from "../app/version";
import { DEFAULT_AGENT, keyKind, knownAgents, placePets } from "../app/agents";
import { configCheck, knownChannelKinds } from "../app/kinds";
import { channelChecks, checkFields } from "../app/channel-fields";
import { doctor } from "../app/doctor";
import { releasedImageFor } from "../app/agent-images";
import { exportHousehold } from "../app/export";
import { importHousehold } from "../app/import";
import { backupRuntime } from "../app/backup-runtime";
import { attachPet } from "../app/attach";
import { HouseholdError } from "../core/errors";
import { channelName, defaultPet } from "../core/channels";
import { findHouse, petDisplay } from "../core/household";
import { formatEndpoint } from "../core/network-policy";
import { ConfigStore } from "../infra/config-store";
import { callControl } from "../infra/control-socket";
import { openInBrowser, runCommand } from "../infra/process";
import { resolvePaths, type Paths } from "../infra/paths";
import { MORE_USAGE, runMore } from "./commands";
import { CAPABILITY_USAGE, FEATURES_USAGE, SCOUT_USAGE, groupUsage, runScouts } from "./scouts";
import { MIGRATE_USAGE, runMigrate } from "./migrate";
import { formatHosts } from "../core/secrets";
import { DEFAULT_LIFECYCLE } from "../core/lifecycle";

const USAGE = `usage:
  house --version                Household's version (and the commit, from a git checkout)
  house start                    run the daemon in the foreground (stops on Ctrl-C or SIGTERM)
  house status                   daemon state and network subjects
  house dashboard [--no-open]    sign in to the web UI: prints a one-time link (60 s) and opens it in the browser
  house reload                   check the config, then apply it to the running daemon
  house doctor                   check images, microsandbox, openssl, the config, the keys, bots and the daemon
  house ls                       keys, houses and pets from the config (no values)
  house key add <name> --provider anthropic|openai [--value <value>] [--note <text>]
                                 a key the pets may run on (its value from stdin when --value is left out:
                                 a command line stays in the shell's history)
  house key codex <name>          sign in to ChatGPT for Household (dedicated, portable subscription login)
  house key rm <name>            remove a key (refused while a pet runs on it)
                                 key add and key set take --houses a,b: only those houses' pets may run on it
  house key set <name> --allow-overage on|off
                                 a subscription key: whether its pets go on once its allowance is used up, spending
                                 what the provider bills apart (credits); off (the default) refuses them until it resets
  house secret add <name> --host h1,h2 --env VAR [--header <name>] [--houses a,b] [--value <value>] [--note <text>]
                                 your own secret (a GitHub token, …): pets get a placeholder in VAR; the gateway puts
                                 the value in its place only in that header (authorization by default) to those hosts
                                 (exact hosts; the value from stdin when --value is left out)
  house secret set <name> [--host …] [--env …] [--header …] [--houses …] [--value …] [--note …]  ("" removes)
  house secret rm <name>         remove a secret
  house create <house>           add a house
  house allow|disallow <house> <host>
                                 add or remove an allowlist entry: host, host:port (443 when left out),
                                 '*.example.com' (its subdomains at any depth, not example.com itself), or
                                 '*' / '*:*' (any public host on 443 / any port; never private addresses)
  house channel add <house> --kind telegram-private [--token <bot token>] --chat <id> [--pets a,b] [--default a] [--name <name>] [--note <text>]
                                 a chat of the house: a private chat with a bot (its token from @BotFather, from
                                 stdin when --token is left out, checked with Telegram as the web UI does; chat:
                                 your Telegram user id), its pets (default: who gets General; needed with two or more)
  house channel rm <house> <chat>  remove the house's channel of that chat
  house owner add|rm <house> <platform> <id> [--note <text>]
                                 an owner of the house on a platform, by the id it knows them by
                                 (telegram: a Telegram user id; the note is yours only, never told to a pet)
  house pet add <house> <pet> --key <key> [--title <title>] [--emoji <emoji>] [--aliases a,b] [--agent <agent>] [--model <model>] [--reasoning-effort <effort>] [--mode <mode>] [--setting k=v]...
                                 add a pet to a house (key: the key it runs on, one of its agent's provider; title:
                                 its name in the chat; emoji: one, before the title wherever people see it, 🐾 when
                                 left out; it is in no channel until one lists it; agent, model and mode: the
                                 defaults when left out; mode: how much it may do without asking, one of its
                                 agent's, e.g. bypassPermissions, acceptEdits, manual; reasoning-effort: optional,
                                 leave out for the agent's native default; setting: one of the agent's own, e.g.
                                 subagentModel=haiku for claude-code-tmux)
  house pet set <house> <pet> [--title <title>] [--emoji <emoji>] [--aliases a,b] [--agent <agent>] [--model <model>] [--reasoning-effort <effort>] [--mode <mode>] [--setting k=v]... [--key <key>] [--cpus <n>] [--memory <GiB>]
                                 change a pet ("" removes a setting, --setting k= removes that one); a new agent,
                                 model, reasoning effort, mode or agent setting restarts it;
                                 CPUs (1 up to this host's, 2 by default) and memory in GiB (0.5 up to this host's, in
                                 0.125 steps, 1 by default) apply on its next restart
  house pet rm <house> <pet>     remove a pet, also from its channels (its VM goes, its files stay on disk)
  house pet attach <house> <pet> open the pet's agent session (detach: Ctrl-b d)
  house pet send <house> <pet> <text>  queue a message for the pet (delivered when no dialog is open)
  house export [file]            back up the config (keys and tokens in it), the database and the pets' homes into one .tar.gz
  house import <file> [--force]  restore a backup (daemon stopped); --force moves the config and the database
                                 aside and replaces the pets' homes
${MORE_USAGE}
${FEATURES_USAGE}
${CAPABILITY_USAGE}
${SCOUT_USAGE}
${MIGRATE_USAGE}
  --json on features, capability and scout commands: what the daemon answered, as JSON
  house <features|capability|scout> --help: that group's commands only`;

async function notifyDaemon(paths: Paths): Promise<void> {
  const report = await callControl<ReloadReport>(paths.socket, "/reload");
  if (!report) return console.log("daemon not running; changes apply on next `house start`");
  console.log("daemon reloaded");
  for (const warning of report.warnings) console.log(warning);
}

/** The link is the running daemon's: a sign-in token only it knows. */
async function dashboard(paths: Paths, open: boolean): Promise<void> {
  const link = await callControl<DashboardLink>(paths.socket, "/dashboard");
  if (!link) throw new HouseholdError("daemon not running; start it with `house start`");
  if ("off" in link) throw new HouseholdError(`web UI off: ${link.off}`);
  console.log(`sign-in link (works once, for 60 s):\n${link.url}`);
  if (open && !(await openInBrowser(link.url))) console.log("could not open a browser: open the link yourself");
}

async function checkUp(paths: Paths, config: ConfigStore): Promise<void> {
  const findings = await doctor({
    paths, config, agents: knownAgents(), run: runCommand, telegramApi: process.env.HOUSEHOLD_TELEGRAM_API,
    released: (tag, contextDir) => releasedImageFor(tag, contextDir),
  });
  for (const { ok, text, warning } of findings) console.log(`${warning ? "!" : ok ? "✓" : "✗"} ${text}`);
  process.exitCode = findings.every((finding) => finding.ok) ? 0 : 1;
}

/** A subscription belongs to Household's config, independently of any host Codex installation. */
async function connectCodex(paths: Paths, config: ConfigStore, name: string, note?: string): Promise<void> {
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
  let auth;
  try { auth = await readLocalCodexAuth(undefined, { home }); } catch {
    if (present) {
      try {
        await refreshLocalCodexAuth(home);
        auth = await readLocalCodexAuth(undefined, { home });
      } catch { /* A failed/expired dedicated login can be replaced by a new device login below. */ }
    }
  }
  if (!auth) {
    console.log(`Sign in to ChatGPT for Household subscription '${name}'; this login is stored with Household and included in its backups.`);
    let child;
    try {
      child = Bun.spawn(["codex", "-c", 'forced_login_method="chatgpt"', "-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"], {
        cwd: home, env: codexAuthEnvironment(home), stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
    } catch {
      throw new HouseholdError("could not start Codex login: install the Codex CLI, then try again");
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
  chmodSync(file, 0o600);
  const fields = { provider: "openai", value: `${SUBSCRIPTION_PREFIX}${auth.accountId}`, note: note ?? existing?.note ?? "Household ChatGPT subscription" };
  if (existing) await config.updateKey(name, fields);
  else await config.addKey(name, fields);
  console.log(`subscription '${name}' connected; dedicated credentials stay with Household`);
  await notifyDaemon(paths);
}

/** A key's value: `--value`, or stdin (a command line ends up in the shell's history). */
async function keyValue(given: string | undefined): Promise<string> {
  const value = (given ?? (await readStdin())).trim();
  if (!value) throw new HouseholdError("no value given (--value, or on stdin); nothing saved");
  return value;
}

/** All of stdin; typed on a terminal, without echo. */
async function readStdin(): Promise<string> {
  if (!process.stdin.isTTY) return Bun.stdin.text();
  const stty = (mode: string) => Bun.spawnSync(["stty", mode], { stdin: "inherit" });
  const restore = () => {
    stty("echo");
    process.exit(130);
  };
  console.error("paste the value (it is not shown), then Enter and Ctrl-D");
  stty("-echo");
  process.once("SIGINT", restore);
  try {
    return await Bun.stdin.text();
  } finally {
    process.off("SIGINT", restore);
    stty("echo");
  }
}


/**
 * Runs an export or import so that Ctrl-C or SIGTERM (once or more) stops it at its next step and kills the docker
 * call running: a paused pet is unpaused, the staging dir (secrets in plain form) removed.
 */
async function interruptible<T>(paths: Paths, run: (runtime: ReturnType<typeof backupRuntime>, signal: AbortSignal) => Promise<T>): Promise<T> {
  const runtime = backupRuntime(paths);
  const stop = new AbortController();
  const interrupt = () => {
    if (stop.signal.aborted) return; // cleaning up already
    stop.abort();
    runtime.cancel();
  };
  process.on("SIGINT", interrupt).on("SIGTERM", interrupt);
  try {
    return await run(runtime, stop.signal);
  } finally {
    process.off("SIGINT", interrupt).off("SIGTERM", interrupt);
  }
}

async function backUp(paths: Paths, file: string | undefined): Promise<void> {
  const { file: archive, bytes } = await interruptible(paths, (runtime, signal) => exportHousehold({ paths, runtime, log: console.log }, file, signal));
  console.log(`exported to ${archive} (${(bytes / 1024 / 1024).toFixed(1)} MB, mode 600; CONTAINS SECRETS — keep it private)`);
}

async function restore(paths: Paths, file: string, force: boolean): Promise<void> {
  if ((await callControl(paths.socket, "/status")) !== undefined) {
    throw new HouseholdError("the daemon is running: stop it first (Ctrl-C or SIGTERM), then import");
  }
  await interruptible(paths, (runtime, signal) => importHousehold({ paths, runtime, log: console.log }, file, { force, signal }));
}

async function list(paths: Paths): Promise<void> {
  const household = await new ConfigStore(paths.configFile).load();
  const { houses } = household;
  for (const key of household.keys) console.log(`key ${key.name}  ${key.provider}  ${keyKind(knownAgents(), key) ?? "unknown kind"}${key.houses ? `  houses: ${key.houses.join(", ")}` : ""}${key.note ? `  (${key.note})` : ""}`);
  for (const secret of household.secrets) console.log(`secret ${secret.name}  ${secret.env}  ${formatHosts(secret.hosts).join(", ")}${secret.header === "authorization" ? "" : `  header ${secret.header}`}  houses: ${secret.houses?.join(", ") ?? "all"}${secret.note ? `  (${secret.note})` : ""}`);
  if (houses.length === 0) console.log("no houses");
  for (const house of houses) {
    const allow = house.network.allow.map((entry) => `${formatEndpoint(entry)}${entry.reach ? " (granted in chat)" : ""}`).join(", ");
    const pets = house.pets.map((pet) => `${pet.name} (${pet.agent ?? DEFAULT_AGENT}${pet.model ? ` ${pet.model}` : ""}${pet.key ? `, key ${pet.key}` : ""}, "${petDisplay(pet)}")`).join(", ");
    console.log(`${house.name}  allow: ${allow || "-"}  pets: ${pets || "-"}  owners: ${house.people.owners.map(({ platform, id }) => `${platform} ${id}`).join(", ") || "-"}`);
    house.channels.forEach((channel, index) => {
      const first = defaultPet(channel);
      const placed = channel.pets.map((pet) => (pet === first && channel.pets.length > 1 ? `${pet} (default)` : pet)).join(", ");
      console.log(`  ${index + 1}. ${channelName(knownChannelKinds(), channel)}  ${channel.kind}  chat ${channel.chat}  pets: ${placed || "-"}`);
    });
  }
}

async function status(paths: Paths): Promise<void> {
  const report = await callControl<StatusReport>(paths.socket, "/status");
  if (!report) {
    console.log("daemon: down");
    return;
  }
  console.log(`daemon: ${report.state}`);
  if (report.web) console.log("url" in report.web ? `web UI: ${report.web.url} (sign in: house dashboard)` : `web UI off: ${report.web.off}`);
  for (const { subject, policy } of report.subjects) {
    const allow = policy.allow.map(formatEndpoint).join(", ") || "-";
    console.log(`${subject.kind} ${subject.name}  allow: ${allow}`);
  }
  for (const pet of report.pets) console.log(`pet ${pet.house}/${pet.pet}  ${pet.agent}  ${pet.container}  ${pet.state}`);
}

async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    const options = {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      title: { type: "string" },
      emoji: { type: "string" },
      aliases: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      "reasoning-effort": { type: "string" },
      mode: { type: "string" },
      setting: { type: "string", multiple: true },
      "allow-overage": { type: "string" },
      kind: { type: "string" },
      token: { type: "string" },
      key: { type: "string" },
      provider: { type: "string" },
      value: { type: "string" },
      note: { type: "string" },
      chat: { type: "string" },
      pets: { type: "string" },
      default: { type: "string" },
      name: { type: "string" },
      force: { type: "boolean" },
      "no-open": { type: "boolean" },
      cpus: { type: "string" },
      memory: { type: "string" },
      now: { type: "boolean" },
      at: { type: "string" },
      cron: { type: "string" },
      text: { type: "string" },
      grep: { type: "string" },
      deleted: { type: "boolean" },
      source: { type: "string" },
      lines: { type: "string", short: "n" },
      follow: { type: "boolean", short: "f" },
      house: { type: "string" },
      pet: { type: "string" },
      problems: { type: "boolean" },
      host: { type: "string" },
      header: { type: "string" },
      env: { type: "string" },
      houses: { type: "string" },
      json: { type: "boolean" },
      description: { type: "string" },
      install: { type: "string" },
      network: { type: "string" },
      capabilities: { type: "string" },
      instructions: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      max: { type: "string" },
      task: { type: "string" },
      wait: { type: "boolean" },
      via: { type: "string" },
    } as const;
    parsed = parseArgs({ args: argv, allowPositionals: true, options });
  } catch (error) {
    throw new HouseholdError(`${(error as Error).message}\n${USAGE}`);
  }
  if (parsed.values.help) return console.log(groupUsage(parsed.positionals[0]) ?? USAGE);
  if (parsed.values.version) return console.log(`household ${formatVersion(await householdVersion())}`);
  const { positionals, values } = parsed;
  const paths = resolvePaths();
  const config = new ConfigStore(paths.configFile, configCheck(knownAgents()));
  const [command, ...args] = positionals;

  if (command === "start" && args.length === 0) return runDaemon(paths);
  if (command === "status" && args.length === 0) return status(paths);
  if (command === "dashboard" && args.length === 0) return dashboard(paths, !values["no-open"]);
  if (command === "doctor" && args.length === 0) return checkUp(paths, config);
  if (command === "reload" && args.length === 0) {
    placePets(knownAgents(), await config.load()); // the daemon would refuse it too, but less plainly
    return notifyDaemon(paths);
  }
  // The old secret files: an agent's key and a bot's token moved into household.yaml.
  if (command === "secret" && !["add", "set", "rm"].includes(args[0] ?? "")) throw new HouseholdError("`house secret add|set|rm` is for your own secrets; an agent's key is `house key add`, a bot's token `house channel add --token`");
  if (command === "key" && args[0] === "add" && args.length === 2 && values.provider) {
    await config.addKey(args[1]!, { provider: values.provider, value: await keyValue(values.value), note: values.note, houses: listOf(values.houses) });
    console.log(`key '${args[1]}' added`);
    return notifyDaemon(paths);
  }
  if (command === "key" && args[0] === "codex" && args.length === 2) {
    return connectCodex(paths, config, args[1]!, values.note);
  }
  if (command === "key" && args[0] === "set" && args.length === 2 && values["allow-overage"] !== undefined) {
    const allowOverage = { on: true, off: false }[values["allow-overage"]];
    if (allowOverage === undefined) throw new HouseholdError("--allow-overage on|off");
    await config.updateKey(args[1]!, { allowOverage });
    console.log(`key '${args[1]}': ${allowOverage ? "its pets go on past its allowance, billed apart" : "its pets stop at its allowance until it resets"}`);
    return notifyDaemon(paths);
  }
  if (command === "key" && args[0] === "set" && args.length === 2 && values.houses !== undefined && values.note === undefined && values.value === undefined) {
    await config.updateKey(args[1]!, { houses: listOf(values.houses) ?? null });
    console.log(`key '${args[1]}' ${values.houses ? `is for ${values.houses}` : "is for every house"}`);
    return notifyDaemon(paths);
  }
  if (command === "secret" && args[0] === "add" && args.length === 2 && values.host && values.env) {
    await config.addSecret(args[1]!, { value: await keyValue(values.value), hosts: listOf(values.host)!, env: values.env, header: values.header, houses: listOf(values.houses), note: values.note });
    console.log(`secret '${args[1]}' added: pets get a placeholder in ${values.env} from their next VM`);
    return notifyDaemon(paths);
  }
  if (command === "secret" && args[0] === "set" && args.length === 2) {
    const blank = (text: string | undefined) => (text === "" ? null : text);
    await config.updateSecret(args[1]!, { value: values.value, hosts: listOf(values.host), env: values.env, header: blank(values.header), houses: values.houses === undefined ? undefined : (listOf(values.houses) ?? null), note: blank(values.note) });
    console.log(`secret '${args[1]}' changed`);
    return notifyDaemon(paths);
  }
  if (command === "secret" && args[0] === "rm" && args.length === 2) {
    await config.removeSecret(args[1]!);
    console.log(`secret '${args[1]}' removed`);
    return notifyDaemon(paths);
  }
  if (command === "key" && args[0] === "rm" && args.length === 2) {
    // The daemon also knows which sideworker snapshots still use this credential.
    const result = await callControl<{ status: number; body: { error?: string } }>(paths.socket, "/api", { method: "DELETE", path: `/api/keys/${encodeURIComponent(args[1]!)}` });
    if (result) {
      if (result.status >= 400) throw new HouseholdError(result.body.error ?? "key could not be removed");
      console.log(`key '${args[1]}' removed`);
      return;
    }
    await config.removeKey(args[1]!);
    console.log(`key '${args[1]}' removed`);
    return notifyDaemon(paths);
  }
  if (command === "ls" && args.length === 0) return list(paths);
  if (command === "export" && args.length <= 1) return backUp(paths, args[0]);
  if (command === "import" && args.length === 1) return restore(paths, args[0]!, values.force ?? false);
  if (command === "create" && args.length === 1) {
    await config.createHouse(args[0]!);
    console.log(`house '${args[0]}' created`);
    return notifyDaemon(paths);
  }
  if ((command === "allow" || command === "disallow") && args.length === 2) {
    const [house, host] = args as [string, string];
    const { entry, changed } = await (command === "allow" ? config.allowHost(house, host) : config.disallowHost(house, host));
    if (command === "allow") console.log(changed ? `house '${house}' allows ${entry}` : `house '${house}' already allows ${entry}`);
    else console.log(changed ? `house '${house}' no longer allows ${entry}` : `house '${house}' has no allowlist entry ${entry}`);
    return changed ? notifyDaemon(paths) : undefined;
  }
  if (command === "channel" && args[0] === "add" && args.length === 2 && values.kind && values.chat) {
    const pets = values.pets?.split(",").map((pet) => pet.trim()).filter(Boolean);
    const { kind, chat, default: first, name } = values;
    const household = await config.load();
    if (!findHouse(household, args[1]!)) throw new HouseholdError(`unknown house '${args[1]}'`); // before Telegram is asked
    // The web's checks: the token's shape, then Telegram (the bot, Threaded Mode), one bot per house by its id.
    const given = { token: values.token ?? (await readStdin()) };
    const { own, also } = await checkFields(knownChannelKinds(), channelChecks(process.env.HOUSEHOLD_TELEGRAM_API), kind, given, { household, house: args[1]! });
    await config.addChannel(args[1]!, { kind, ...own, chat: chat.trim(), pets, default: first, name, note: values.note?.trim() || undefined }, also);
    console.log(`house '${args[1]}' is in chat ${chat} (pets: ${pets?.join(", ") || "none yet"})`);
    return notifyDaemon(paths);
  }
  if (command === "channel" && args[0] === "rm" && args.length === 3) {
    const { removed } = await config.removeChannel(args[1]!, args[2]!);
    console.log(`channel ${channelName(knownChannelKinds(), removed)} (chat ${removed.chat}) removed from house '${args[1]}'`);
    return notifyDaemon(paths);
  }
  if (command === "owner" && args[0] === "rm" && values.note !== undefined) throw new HouseholdError(`--note is for \`owner add\`\n${USAGE}`);
  if (command === "owner" && (args[0] === "add" || args[0] === "rm") && args.length === 4) {
    const [change, house, platform, id] = args as [string, string, string, string];
    await (change === "add" ? config.addOwner(house, platform, id, values.note) : config.removeOwner(house, platform, id));
    console.log(change === "add" ? `${platform} ${id} is an owner of house '${house}'` : `${platform} ${id} is no owner of house '${house}'`);
    return notifyDaemon(paths);
  }
  if (command === "pet" && (args[0] === "add" || args[0] === "set") && args.length === 3) {
    const [change, house, pet] = args as [string, string, string];
    const aliases = values.aliases?.split(",").map((alias) => alias.trim()).filter(Boolean);
    const fields = { title: values.title, emoji: values.emoji, aliases, agent: values.agent, model: values.model, reasoningEffort: values["reasoning-effort"], mode: values.mode, settings: settingsOf(values.setting), key: values.key, ...resources(values.cpus, values.memory) };
    if (change === "add") {
      await config.addPet(house, pet, { lifecycle: DEFAULT_LIFECYCLE, ...fields });
      console.log(`pet '${pet}' added to house '${house}'; it is in no channel yet: list it in a channel's pets`);
    } else {
      await config.updatePet(house, pet, fields);
      console.log(`pet '${pet}' of house '${house}' changed`);
    }
    return notifyDaemon(paths);
  }
  if (command === "pet" && args[0] === "rm" && args.length === 3) {
    await config.removePet(args[1]!, args[2]!);
    console.log(`pet '${args[2]}' removed from house '${args[1]}' and its channels; its files stay on disk`);
    return notifyDaemon(paths);
  }
  if (command === "pet" && args[0] === "send" && args.length >= 4) {
    const [, house, pet, ...words] = args as [string, string, string, ...string[]];
    const result = await callControl<{ activity: string; queued: number }>(paths.socket, "/send", {
      house,
      pet,
      text: words.join(" "),
    });
    if (!result) throw new HouseholdError("daemon not running; start it with `house start`");
    console.log(`queued for ${house}/${pet} (pet is ${result.activity}, ${result.queued} waiting)`);
    return;
  }
  if (command === "pet" && args[0] === "attach" && args.length === 3) {
    process.exitCode = await attachPet(paths, args[1]!, args[2]!);
    return;
  }
  if (await runScouts(paths, command, args, values)) return;
  if (await runMigrate(paths, command, args, values)) return;
  if (await runMore(paths, command, args, values)) return;
  throw new HouseholdError(USAGE);
}

/** A comma list (`--houses a,b`); undefined when not given or empty. */
function listOf(text: string | undefined): string[] | undefined {
  const items = text?.split(",").map((item) => item.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

/** `--cpus` and `--memory` (GiB) as a pet's fields; "" puts back the default. */
/** `--setting k=v` entries as a pet's settings: `k=` removes one; none given: untouched. */
function settingsOf(given: string[] | undefined): Record<string, string | null> | undefined {
  if (given === undefined) return undefined;
  const settings: Record<string, string | null> = {};
  for (const entry of given) {
    const at = entry.indexOf("=");
    if (at <= 0) throw new HouseholdError(`--setting takes key=value (got '${entry}')`);
    settings[entry.slice(0, at).trim()] = entry.slice(at + 1).trim() || null;
  }
  return settings;
}

function resources(cpus: string | undefined, memory: string | undefined): { cpus?: number | null; memoryMiB?: number | null } {
  const number = (flag: string, text: string) => {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value)) throw new HouseholdError(`${flag} takes a number`);
    return value;
  };
  return {
    ...(cpus === undefined ? {} : { cpus: cpus === "" ? null : number("--cpus", cpus) }),
    ...(memory === undefined ? {} : { memoryMiB: memory === "" ? null : Math.round(number("--memory", memory) * 1024) }),
  };
}

main(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof HouseholdError ? error.message : error);
  process.exit(1);
});
