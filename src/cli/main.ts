#!/usr/bin/env bun
import { normalizeCliArgs, normalizeCommand } from "./terminology";
import { parseArgs } from "node:util";
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
import { connectCodex, importCodex, localCodexLogin } from "./codex-login";
import { onboard } from "./onboard";
import { update } from "./update";
import { consoleTerminal } from "./terminal";
import { firstPrivateContact, getMe } from "../channel-adapters/telegram";
import { hostCapacity } from "../infra/host";
import { MICROSANDBOX_VERSION } from "../infra/microsandbox-runtime";
import { CAPABILITY_USAGE, FEATURES_USAGE, SCOUT_USAGE, groupUsage, runScouts } from "./scouts";
import { MIGRATE_USAGE, runMigrate } from "./migrate";
import { formatHosts } from "../core/secrets";
import { DEFAULT_LIFECYCLE } from "../core/lifecycle";
import { msbCommand } from "../infra/release";
import { HISTORY_PROCESS_COMMAND, runHistoryProcess } from "../infra/history-process";

const USAGE = `usage:
  house --version                Household's version (and the commit, from a git checkout)
  house onboard                  set up a workspace step by step: a key, a Telegram bot, a bot, scouts and sideworkers
  house start                    run the daemon in the foreground (stops on Ctrl-C or SIGTERM)
  house status                   daemon state and network subjects
  house dashboard [--no-open]    sign in to the web UI: prints a one-time link (60 s) and opens it in the browser
  house reload                   check the config, then apply it to the running daemon
  house update [<tag>]           install the newest release (or that one) where install.sh put Household; restart to run it
  house doctor                   check images, microsandbox, openssl, the config, the keys, bots and the daemon
  house ls                       keys, workspaces and bots from the config (no values)
  house key add <name> --provider anthropic|openai [--value <value>] [--note <text>]
                                 a key the bots may run on (its value from stdin when --value is left out:
                                 a command line stays in the shell's history)
  house key codex <name> [--local]
                                 sign in to ChatGPT for Household (its own login: a code for any browser), or with
                                 --local copy the ChatGPT login of the Codex on this machine ($CODEX_HOME or ~/.codex)
  house key rm <name>            remove a key (refused while a bot runs on it)
                                 key add and key set take --workspaces a,b: only those workspaces' bots may run on it
  house key set <name> --allow-overage on|off
                                 a subscription key: whether its bots go on once its allowance is used up, spending
                                 what the provider bills apart (credits); off (the default) refuses them until it resets
  house secret add <workspace> <name> --host h1,h2 --env VAR [--header <name>] [--value <value>] [--note <text>]
                                 your own secret (a GitHub token, …): bots get a placeholder in VAR; the gateway puts
                                 the value in its place only in that header (authorization by default) to those hosts
                                 (exact hosts; the value from stdin when --value is left out)
  house secret set <workspace> <name> [--host …] [--env …] [--header …] [--value …] [--note …]  ("" removes)
  house secret rm <workspace> <name>         remove a secret
  house workspace create <workspace>           add a workspace
  house workspace allow|disallow <workspace> <host>
                                 add or remove an allowlist entry: host, host:port (443 when left out),
                                 '*.example.com' (its subdomains at any depth, not example.com itself), or
                                 '*' / '*:*' (any public host on 443 / any port; never private addresses)
  house channel add <workspace> --kind telegram-private|telegram-group|slack-private [--app-token <xapp-token>] [--token <bot token>] --chat <id> [--bots a,b] [--default a] [--name <name>] [--note <text>]
                                 a chat of the workspace: a private chat with a bot (its token from @BotFather, from
                                 stdin when --token is left out, checked with Telegram as the web UI does; chat:
                                 your Telegram user id), its bots (default: who gets General; needed with two or more)
  house channel rm <workspace> <chat>  remove the workspace's channel of that chat
  house owner add|rm <workspace> <platform> <id> [--note <text>]
                                 an owner of the workspace on a platform, by the id it knows them by
                                 (telegram: a Telegram user id; the note is yours only, never told to a bot)
  house bot add <workspace> <bot> --key <key> [--title <title>] [--emoji <emoji>] [--aliases a,b] [--harness <harness>] [--model <model>] [--reasoning-effort <effort>] [--mode <mode>] [--setting k=v]...
                                 add a bot to a workspace (key: the key it runs on, one of its harness's provider; title:
                                 its name in the chat; emoji: one, before the title wherever people see it, 🤖 when
                                 left out; it is in no channel until one lists it; harness, model and mode: the
                                 defaults when left out; mode: how much it may do without asking, one of its
                                 harness's, e.g. bypassPermissions, acceptEdits, manual; reasoning-effort: optional,
                                 leave out for the harness's native default; setting: one of the harness's own, e.g.
                                 subagentModel=haiku for claude-code-tmux)
  house bot set <workspace> <bot> [--title <title>] [--emoji <emoji>] [--aliases a,b] [--harness <harness>] [--model <model>] [--reasoning-effort <effort>] [--mode <mode>] [--setting k=v]... [--key <key>] [--cpus <n>] [--memory <GiB>]
                                 change a bot ("" removes a setting, --setting k= removes that one); a new harness,
                                 model, reasoning effort, mode or harness setting restarts it;
                                 CPUs (1 up to this host's, 2 by default) and memory in GiB (0.5 up to this host's, in
                                 0.125 steps, 1 by default) apply on its next restart
  house bot rm <workspace> <bot>     remove a bot, also from its channels (its VM goes, its files stay on disk)
  house bot attach <workspace> <bot> open the bot's harness session (detach: Ctrl-b d)
  house bot send <workspace> <bot> <text>  queue a message for the bot (delivered when no dialog is open)
  house export [file]            back up the config (keys and tokens in it), the database and the bots' homes into one .tar.gz
  house import <file> [--force]  restore a backup (daemon stopped); --force moves the config and the database
                                 aside and replaces the bots' homes
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

async function startOnboarding(paths: Paths, config: ConfigStore): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new HouseholdError("house onboard asks questions: run it in a terminal");
  const telegramApi = process.env.HOUSEHOLD_TELEGRAM_API;
  await onboard({
    terminal: consoleTerminal(), config, capacity: hostCapacity(),
    async checkBot(token, household, house, chat) {
      const checked = await checkFields(knownChannelKinds(), channelChecks(telegramApi), "telegram-private", { token }, { household, house, ...(chat ? { chat } : {}) });
      const me = await getMe(checked.own.token ?? token, telegramApi);
      return { ...checked, bot: `@${me.username}` };
    },
    botName: async (token) => `@${(await getMe(token, telegramApi, 3000)).username}`,
    firstContact: (token) => firstPrivateContact(token, { apiBase: telegramApi }),
    codexLogin: (name) => connectCodex(paths, config, name),
    localCodex: () => localCodexLogin(),
    codexImport: async (name) => { await importCodex(paths, config, name); },
    claudeHere: async () => Bun.which("claude") !== null,
    async claudeSetupToken() {
      try { return (await Bun.spawn(["claude", "setup-token"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited) === 0; }
      catch { return false; }
    },
    async missing() {
      const problems: string[] = [];
      const msb = await runCommand([msbCommand(), "--version"]);
      if (msb.stdout.trim() !== `msb ${MICROSANDBOX_VERSION}`) problems.push(`microsandbox ${MICROSANDBOX_VERSION} is not installed: bots cannot start until it is (https://microsandbox.dev)`);
      for (const tool of ["python3", "openssl"]) if (!(await runCommand([tool, "--version"])).ok && !(await runCommand([tool, "version"])).ok) problems.push(`${tool} is not installed: Household needs it to run`);
      return problems;
    },
    daemonUp: async () => (await callControl(paths.socket, "/status")) !== undefined,
    notifyDaemon: () => notifyDaemon(paths),
    startDaemon: () => runDaemon(paths),
  });
}

async function checkUp(paths: Paths, config: ConfigStore): Promise<void> {
  const findings = await doctor({
    paths, config, agents: knownAgents(), run: runCommand, telegramApi: process.env.HOUSEHOLD_TELEGRAM_API,
    released: (tag, contextDir) => releasedImageFor(tag, contextDir),
  });
  for (const { ok, text, warning } of findings) console.log(`${warning ? "!" : ok ? "✓" : "✗"} ${text}`);
  process.exitCode = findings.every((finding) => finding.ok) ? 0 : 1;
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
  for (const key of household.keys) console.log(`key ${key.name}  ${key.provider}  ${keyKind(knownAgents(), key) ?? "unknown kind"}${key.houses ? `  workspaces: ${key.houses.join(", ")}` : ""}${key.note ? `  (${key.note})` : ""}`);
  for (const house of household.houses) for (const secret of house.secrets ?? []) console.log(`secret ${house.name}/${secret.name}  ${secret.env}  ${formatHosts(secret.hosts).join(", ")}${secret.header === "authorization" ? "" : `  header ${secret.header}`}${secret.note ? `  (${secret.note})` : ""}`);
  if (houses.length === 0) console.log("no workspaces");
  for (const house of houses) {
    const allow = house.network.allow.map((entry) => `${formatEndpoint(entry)}${entry.reach ? " (granted in chat)" : ""}`).join(", ");
    const pets = house.pets.map((pet) => `${pet.name} (${pet.agent ?? DEFAULT_AGENT}${pet.model ? ` ${pet.model}` : ""}${pet.key ? `, key ${pet.key}` : ""}, "${petDisplay(pet)}")`).join(", ");
    console.log(`${house.name}  allow: ${allow || "-"}  bots: ${pets || "-"}  owners: ${house.people.owners.map(({ platform, id }) => `${platform} ${id}`).join(", ") || "-"}`);
    house.channels.forEach((channel, index) => {
      const first = defaultPet(channel);
      const placed = channel.pets.map((pet) => (pet === first && channel.pets.length > 1 ? `${pet} (default)` : pet)).join(", ");
      console.log(`  ${index + 1}. ${channelName(knownChannelKinds(), channel)}  ${channel.kind}  chat ${channel.chat}  bots: ${placed || "-"}`);
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
  for (const pet of report.pets) console.log(`bot ${pet.house}/${pet.pet}  ${pet.agent}  ${pet.container}  ${pet.state}`);
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
      "app-token": { type: "string" },
      key: { type: "string" },
      provider: { type: "string" },
      value: { type: "string" },
      note: { type: "string" },
      chat: { type: "string" },
      pets: { type: "string" },
      default: { type: "string" },
      name: { type: "string" },
      force: { type: "boolean" },
      local: { type: "boolean" },
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
      place: { type: "string" },
      placement: { type: "string" },
      wait: { type: "boolean" },
      via: { type: "string" },
    } as const;
    parsed = parseArgs({ args: normalizeCliArgs(argv), allowPositionals: true, options });
  } catch (error) {
    throw new HouseholdError(`${(error as Error).message}\n${USAGE}`);
  }
  if (parsed.values.help) return console.log(groupUsage(parsed.positionals[0]) ?? USAGE);
  if (parsed.values.version) return console.log(`household ${formatVersion(await householdVersion())}`);
  const { positionals, values } = parsed;
  const paths = resolvePaths();
  const config = new ConfigStore(paths.configFile, configCheck(knownAgents()));
  const [givenCommand, ...givenArgs] = positionals;
  const { command, args } = normalizeCommand(givenCommand, givenArgs);

  if (command === "start" && args.length === 0) return runDaemon(paths);
  if (command === "onboard" && args.length === 0) return startOnboarding(paths, config);
  if (command === "update" && args.length <= 1) { await update({ tag: args[0] }); return; }
  if (command === "status" && args.length === 0) return status(paths);
  if (command === "dashboard" && args.length === 0) return dashboard(paths, !values["no-open"]);
  if (command === "doctor" && args.length === 0) return checkUp(paths, config);
  if (command === "reload" && args.length === 0) {
    placePets(knownAgents(), await config.load()); // the daemon would refuse it too, but less plainly
    return notifyDaemon(paths);
  }
  // The old secret files: an agent's key and a bot's token moved into household.yaml.
  if (command === "secret" && !["add", "set", "rm"].includes(args[0] ?? "")) throw new HouseholdError("`house secret add|set|rm` is for your own secrets; a harness's key is `house key add`, a bot's token `house channel add --token`");
  if (command === "key" && args[0] === "add" && args.length === 2 && values.provider) {
    await config.addKey(args[1]!, { provider: values.provider, value: await keyValue(values.value), note: values.note, houses: listOf(values.houses) });
    console.log(`key '${args[1]}' added`);
    return notifyDaemon(paths);
  }
  if (command === "key" && args[0] === "codex" && args.length === 2) {
    if (values.local) {
      const from = await importCodex(paths, config, args[1]!, undefined, values.note);
      console.log(`subscription '${args[1]}' connected: a copy of this machine's Codex login${from.email ? ` (${from.email})` : ""}, refreshed by Household`);
    } else await connectCodex(paths, config, args[1]!, values.note);
    return notifyDaemon(paths);
  }
  if (command === "key" && args[0] === "set" && args.length === 2 && values["allow-overage"] !== undefined) {
    const allowOverage = { on: true, off: false }[values["allow-overage"]];
    if (allowOverage === undefined) throw new HouseholdError("--allow-overage on|off");
    await config.updateKey(args[1]!, { allowOverage });
    console.log(`key '${args[1]}': ${allowOverage ? "its bots go on past its allowance, billed apart" : "its bots stop at its allowance until it resets"}`);
    return notifyDaemon(paths);
  }
  if (command === "key" && args[0] === "set" && args.length === 2 && values.houses !== undefined && values.note === undefined && values.value === undefined) {
    await config.updateKey(args[1]!, { houses: listOf(values.houses) ?? null });
    console.log(`key '${args[1]}' ${values.houses ? `is for ${values.houses}` : "is for every workspace"}`);
    return notifyDaemon(paths);
  }
  if (command === "secret" && values.houses !== undefined) throw new HouseholdError("Secrets belong to one workspace: use house secret add|set|rm <workspace> <name>, without --workspaces");
  if (command === "secret" && args[0] === "add" && args.length === 3 && values.host && values.env) {
    await config.addSecret(args[1]!, args[2]!, { value: await keyValue(values.value), hosts: listOf(values.host)!, env: values.env, header: values.header, note: values.note });
    console.log(`secret '${args[1]}/${args[2]}' added: bots get a placeholder in ${values.env} from their next VM`);
    return notifyDaemon(paths);
  }
  if (command === "secret" && args[0] === "set" && args.length === 3) {
    const blank = (text: string | undefined) => (text === "" ? null : text);
    await config.updateSecret(args[1]!, args[2]!, { value: values.value, hosts: listOf(values.host), env: values.env, header: blank(values.header), note: blank(values.note) });
    console.log(`secret '${args[1]}/${args[2]}' changed`);
    return notifyDaemon(paths);
  }
  if (command === "secret" && args[0] === "rm" && args.length === 3) {
    await config.removeSecret(args[1]!, args[2]!);
    console.log(`secret '${args[1]}/${args[2]}' removed`);
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
    console.log(`workspace '${args[0]}' created`);
    return notifyDaemon(paths);
  }
  if ((command === "allow" || command === "disallow") && args.length === 2) {
    const [house, host] = args as [string, string];
    const { entry, changed } = await (command === "allow" ? config.allowHost(house, host) : config.disallowHost(house, host));
    if (command === "allow") console.log(changed ? `workspace '${house}' allows ${entry}` : `workspace '${house}' already allows ${entry}`);
    else console.log(changed ? `workspace '${house}' no longer allows ${entry}` : `workspace '${house}' has no allowlist entry ${entry}`);
    return changed ? notifyDaemon(paths) : undefined;
  }
  if (command === "channel" && args[0] === "add" && args.length === 2 && values.kind && values.chat) {
    const pets = values.pets?.split(",").map((pet) => pet.trim()).filter(Boolean);
    const { kind, chat, default: first, name } = values;
    const household = await config.load();
    if (!findHouse(household, args[1]!)) throw new HouseholdError(`unknown workspace '${args[1]}'`); // before Telegram is asked
    // The web's checks: the token's shape, then Telegram (the bot, Threaded Mode), one bot per house by its id.
    if (kind === "slack-private" && !values["app-token"]) throw new HouseholdError("Slack requires --app-token (xapp-…). You can also configure it through Channels in the admin.");
    const given = { token: values.token ?? (await readStdin()), ...(kind === "slack-private" ? { appToken: values["app-token"]! } : {}) };
    const { own, also } = await checkFields(knownChannelKinds(), channelChecks(process.env.HOUSEHOLD_TELEGRAM_API), kind, given, { household, house: args[1]! });
    await config.addChannel(args[1]!, { kind, ...own, chat: chat.trim(), pets, default: first, name, note: values.note?.trim() || undefined }, also);
    console.log(`workspace '${args[1]}' is in chat ${chat} (bots: ${pets?.join(", ") || "none yet"})`);
    return notifyDaemon(paths);
  }
  if (command === "channel" && args[0] === "rm" && args.length === 3) {
    const { removed } = await config.removeChannel(args[1]!, args[2]!);
    console.log(`channel ${channelName(knownChannelKinds(), removed)} (chat ${removed.chat}) removed from workspace '${args[1]}'`);
    return notifyDaemon(paths);
  }
  if (command === "owner" && args[0] === "rm" && values.note !== undefined) throw new HouseholdError(`--note is for \`owner add\`\n${USAGE}`);
  if (command === "owner" && (args[0] === "add" || args[0] === "rm") && args.length === 4) {
    const [change, house, platform, id] = args as [string, string, string, string];
    await (change === "add" ? config.addOwner(house, platform, id, values.note) : config.removeOwner(house, platform, id));
    console.log(change === "add" ? `${platform} ${id} is an owner of workspace '${house}'` : `${platform} ${id} is no owner of workspace '${house}'`);
    return notifyDaemon(paths);
  }
  if (command === "pet" && (args[0] === "add" || args[0] === "set") && args.length === 3) {
    const [change, house, pet] = args as [string, string, string];
    const aliases = values.aliases?.split(",").map((alias) => alias.trim()).filter(Boolean);
    const fields = { title: values.title, emoji: values.emoji, aliases, agent: values.agent, model: values.model, reasoningEffort: values["reasoning-effort"], mode: values.mode, settings: settingsOf(values.setting), key: values.key, ...resources(values.cpus, values.memory) };
    if (change === "add") {
      await config.addPet(house, pet, { lifecycle: DEFAULT_LIFECYCLE, ...fields });
      console.log(`bot '${pet}' added to workspace '${house}'; it is in no channel yet: list it in a channel's bots`);
    } else {
      await config.updatePet(house, pet, fields);
      console.log(`bot '${pet}' of workspace '${house}' changed`);
    }
    return notifyDaemon(paths);
  }
  if (command === "pet" && args[0] === "rm" && args.length === 3) {
    await config.removePet(args[1]!, args[2]!);
    console.log(`bot '${args[2]}' removed from workspace '${args[1]}' and its channels; its files stay on disk`);
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
    console.log(`queued for ${house}/${pet} (bot is ${result.activity}, ${result.queued} waiting)`);
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

// A compiled house is also its own history process (infra/history-runner.ts).
if (Bun.argv[2] === HISTORY_PROCESS_COMMAND) runHistoryProcess(Bun.argv[3]!);
else main(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof HouseholdError ? error.message : error);
  process.exit(1);
});
