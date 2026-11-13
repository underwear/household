import { normalizeCommand } from "./terminology";
import { readFileSync } from "node:fs";
import type { ApiAnswer, ApiCall } from "../app/daemon";
import { formatLogLine, formatLogTime, LOG_KINDS, readLog, type LogFilter, type LogKind, type LogPage } from "../app/household-log";
import { isPetLogSource, PET_LOG_SOURCES, type PetLogView } from "../app/pet-logs";
import type { HouseView } from "../app/web-views";
import type { CronJob, CronRun } from "../core/cron";
import { HouseholdError } from "../core/errors";
import type { MemoryEntry, MemoryPage } from "../core/memory";
import type { MetricSample } from "../core/metrics";
import { petResources } from "../core/resources";
import { callControl } from "../infra/control-socket";
import type { Paths } from "../infra/paths";

/*
 * The commands that do what the web UI does, through the daemon's own API (the control socket's `/api`): the same
 * routes, checks and errors as the browser's. Reading the Household log (`house logs`) needs no daemon.
 */

export const MORE_USAGE = `  house workspace show <workspace>             a workspace: its bots and their state, channels, owners, allowlist and temporary access
  house workspace delete <workspace>           remove a workspace (refused while it has bots or channels)
  house workspace revoke <workspace> <host[:port]>  end a bot's temporary access to a host
  house timezone [<zone>]        the Household timezone (IANA, e.g. Europe/Madrid): show it, or set it
  house key set <name> [--note <text>] [--value <value>]
                                 change a key's note or value (the value from stdin when neither is given)
  house channel set <workspace> <chat> [--bots a,b] [--default a] [--name <name>] [--note <text>] [--token <token>] [--app-token <xapp-token>] [--forward-general on|off]
  house owner set <workspace> <platform> <id> --note <text>
  house bot show <workspace> <bot>   a bot: what runs it, its allocation, its state and what it uses now
  house bot enable <workspace> <bot>
  house bot disable <workspace> <bot> [--now]
                                 stop its VM (files and memory stay); it is asked to save its work first, unless --now
  house bot restart <workspace> <bot> [--now]
                                 restart its VM: a fresh harness session; it saves its work first, unless --now
  house bot screen <workspace> <bot>  the harness's terminal screen now (harnesses with one)
  house bot env <workspace> <bot>    its setup and on-start scripts and how they last ran
  house bot env set <workspace> <bot> setup|on-start [<file>]
                                 save a script from a file or stdin (empty: none); saving runs nothing
  house bot env run <workspace> <bot> setup|on-start  run the saved script in the VM now (up to five minutes)
  house bot instructions <workspace> <bot>  its instructions file
  house bot instructions set <workspace> <bot> [<file>]  replace them from a file or stdin
  house bot tasks <workspace> <bot>  its scheduled tasks and their recent runs
  house bot tasks add <workspace> <bot> --name <name> (--at <YYYY-MM-DDTHH:MM> | --cron <expression>) [--text <prompt>]
                                 schedule a prompt (from stdin without --text), in the Household timezone
  house bot tasks set <workspace> <bot> <id> [--name <name>] [--at <time> | --cron <expression>] [--text <prompt>]
  house bot tasks rm <workspace> <bot> <id>
  house bot memory <workspace> <bot> [--grep <words>] [--deleted]  its memory keys, each with the start of its value
  house bot memory get|set|rm <workspace> <bot> <key> [--value <text>]
                                 one entry: show it, write it (from stdin without --value), delete it
  house bot logs <workspace> <bot> [--source setup|on-start|docker|kernel] [-n <lines>] [-f]
                                 a log inside its VM (default: setup); -f follows it
  house skills <workspace>           the workspace's shared skills, file by file
  house skills cat|put|rm <workspace> <path> [<file>]
                                 one skill file: show it, write it (from a file or stdin), delete it
  house logs [--workspace <workspace>] [--bot <bot>] [--kind daemon,harness,network] [--problems] [--grep <words>] [-n <lines>] [-f]
                                 the Household log: the daemon, the bots' harnesses and their network; -f follows it`;

export interface MoreValues {
  note?: string;
  value?: string;
  pets?: string;
  default?: string;
  name?: string;
  token?: string;
  "app-token"?: string;
  "forward-general"?: string;
  now?: boolean;
  at?: string;
  cron?: string;
  text?: string;
  grep?: string;
  deleted?: boolean;
  source?: string;
  lines?: string;
  follow?: boolean;
  house?: string;
  pet?: string;
  kind?: string;
  problems?: boolean;
}

/** Calls the daemon's web API; its error message when it answers with one. */
export async function api<T>(paths: Paths, method: ApiCall["method"], path: string, body?: unknown): Promise<T> {
  const answer = await callControl<ApiAnswer>(paths.socket, "/api", { method, path, ...(body === undefined ? {} : { body }) } satisfies ApiCall);
  if (!answer) throw new HouseholdError("daemon not running; start it with `house start`");
  if (answer.status >= 400) throw new HouseholdError((answer.body as { error?: string } | null)?.error ?? `daemon: HTTP ${answer.status}`);
  return answer.body as T;
}

const enc = encodeURIComponent;
const housePath = (house: string) => `/api/houses/${enc(house)}`;
const petPath = (house: string, pet: string) => `${housePath(house)}/pets/${enc(pet)}`;

/** Text from a file, or else from stdin. */
export async function textFrom(file: string | undefined): Promise<string> {
  if (file && file !== "-") return readFileSync(file, "utf8");
  if (process.stdin.isTTY) console.error("type or paste the text, then Ctrl-D");
  return Bun.stdin.text();
}

export function lineCount(given: string | undefined, fallback: number): number {
  if (given === undefined) return fallback;
  if (!/^\d+$/.test(given)) throw new HouseholdError("-n takes a number of lines");
  return Number(given);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until Ctrl-C; `read` gets the cursor and returns the next. */
export async function follow(cursor: string, read: (cursor: string) => Promise<string>, everyMs: number): Promise<never> {
  for (;;) {
    await sleep(everyMs);
    cursor = await read(cursor);
  }
}

/** «2 vCPU, 2 GiB». */
const allocation = (pet: { cpus?: number | null; memoryMiB?: number | null }) => {
  const { cpus, memoryMiB } = petResources(pet);
  return `${cpus} vCPU, ${memoryMiB / 1024} GiB`;
};
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

async function showHouse(paths: Paths, house: string): Promise<void> {
  const view = await api<HouseView>(paths, "GET", housePath(house));
  console.log(`workspace ${view.name}`);
  for (const pet of view.pets) {
    console.log(`  bot ${pet.name}  "${pet.display}"  ${pet.enabled ? pet.state : "disabled"}  ${pet.agent} ${pet.model}  ${allocation(pet)}${pet.problem ? `  ! ${pet.problem}` : ""}`);
  }
  for (const channel of view.channels) console.log(`  channel ${channel.name}  ${channel.kind}  chat ${channel.chat}  bots: ${channel.pets.join(", ") || "-"}${channel.problem ? `  ! ${channel.problem}` : ""}`);
  for (const owner of view.owners) console.log(`  owner ${owner.platform} ${owner.id}${owner.note ? `  (${owner.note})` : ""}`);
  console.log(`  allow: ${view.allow.map((entry) => entry.host + (entry.byAgent ? " (harness)" : "")).join(", ") || "-"}`);
  for (const grant of view.temporary ?? []) console.log(`  temporary: ${JSON.stringify(grant)}`);
}

/** The guest services a sample saw down: Household restarts them, the owner should know meanwhile. */
const down = (sample: MetricSample) =>
  [sample.services?.docker === "down" ? "  Docker down" : "", sample.services?.proxy === "down" ? "  Docker proxy down" : ""].join("");

async function showPet(paths: Paths, house: string, name: string): Promise<void> {
  const [view, metrics] = await Promise.all([api<HouseView>(paths, "GET", housePath(house)), api<Record<string, MetricSample | null>>(paths, "GET", `${housePath(house)}/metrics`)]);
  const pet = view.pets.find((each) => each.name === name);
  if (!pet) throw new HouseholdError(`workspace '${house}' has no bot '${name}'`);
  const now = metrics[name];
  const channels = view.channels.filter((channel) => channel.pets.includes(name)).map((channel) => channel.name);
  const rows: [string, string][] = [
    ["bot", `${pet.name}  "${pet.display}"${pet.aliases.length ? `  aliases: ${pet.aliases.join(", ")}` : ""}`],
    ["state", pet.enabled ? pet.state : "disabled"],
    ["harness", `${pet.agent}  model ${pet.model}  effort ${pet.reasoningEffort ?? "default"}${pet.mode ? `  mode ${pet.mode}` : ""}${Object.entries(pet.settings).map(([key, value]) => `  ${key} ${value}`).join("")}`],
    ["key", pet.key ?? "-"],
    ["allocation", `${allocation(pet)} RAM (changes apply on the next restart)`],
    ["now", now?.status === "ok" ? `CPU ${now.cpu?.toFixed(1) ?? "?"}%  RAM ${now.memory ? gib(now.memory.used) : "?"}  disk ${now.disks?.system ? `${gib(now.disks.system.used)} of ${gib(now.disks.system.total)}` : "?"}${down(now)}` : "no sample"],
    ["channels", channels.join(", ") || "-"],
  ];
  for (const [label, value] of rows) console.log(`${label.padEnd(11)} ${value}`);
  if (pet.problem) console.log(`problem     ${pet.problem}`);
}

const PHASES = { setup: "setup", "on-start": "onStart" } as const;
function phaseOf(given: string | undefined): "setup" | "onStart" {
  const phase = PHASES[given as keyof typeof PHASES];
  if (!phase) throw new HouseholdError("which script: setup or on-start");
  return phase;
}

interface EnvironmentRun { status: string; logPath: string; statusPath: string }
interface EnvironmentView { setup: string | null; onStart: string | null; lastRun: EnvironmentRun | null; onStartLastRun: EnvironmentRun | null }

async function showEnvironment(paths: Paths, house: string, pet: string): Promise<void> {
  const view = await api<EnvironmentView>(paths, "GET", `${petPath(house, pet)}/environment`);
  for (const [file, script, run] of [["setup.sh", view.setup, view.lastRun], ["on-start.sh", view.onStart, view.onStartLastRun]] as const) {
    console.log(`# ${file}: ${script ? (run ? `last run ${run.status} (log ${run.logPath})` : "not run since the daemon started") : "none"}`);
    if (script) console.log(script.endsWith("\n") ? script.slice(0, -1) : script);
    console.log();
  }
}

async function showTasks(paths: Paths, house: string, pet: string): Promise<void> {
  const view = await api<{ timezone: string; jobs: CronJob[]; runs: CronRun[] }>(paths, "GET", `${petPath(house, pet)}/crons`);
  const live = view.jobs.filter((job) => job.state !== "deleted");
  if (live.length === 0) console.log("no scheduled tasks");
  for (const job of live) console.log(`${job.id}  ${job.state.padEnd(9)}  ${job.cron ? `cron ${job.cron}` : `at ${job.localAt ?? job.at}`}  ${job.name}`);
  if (view.runs.length) console.log(`\nrecent runs (${view.timezone}):`);
  for (const run of view.runs.slice(0, 10)) console.log(`  ${run.queued}  ${run.status.padEnd(11)}  ${run.name}`);
}

async function memoryEntry(paths: Paths, house: string, pet: string, key: string): Promise<MemoryEntry | undefined> {
  try {
    return await api<MemoryEntry>(paths, "GET", `${petPath(house, pet)}/memory/${enc(key)}`);
  } catch (error) {
    if (/not found|no such|unknown/i.test((error as Error).message)) return undefined;
    throw error;
  }
}

async function showLog(paths: Paths, values: MoreValues): Promise<void> {
  const kinds = values.kind?.split(",").map((kind) => (kind.trim() === "harness" ? "agent" : kind.trim())).filter(Boolean);
  if (kinds?.some((kind) => !LOG_KINDS.includes(kind as LogKind))) throw new HouseholdError(`--kind: ${LOG_KINDS.join(", ")}`);
  const filter: LogFilter = { house: values.house, pet: values.pet, kinds: kinds as LogKind[] | undefined, problems: values.problems, query: values.grep };
  const print = (page: LogPage) => {
    if (page.skipped) console.log(`… ${page.skipped} more lines left out`);
    for (const line of page.lines) console.log(formatLogLine(line, !values.follow));
    return page.cursor;
  };
  const first = readLog(paths.eventLog, { limit: lineCount(values.lines, 50), filter });
  if (first.searchedFrom) console.error(`searched back to ${formatLogTime(first.searchedFrom, true)}: older lines were not looked at`);
  const cursor = print(first);
  if (values.follow) await follow(cursor, async (after) => print(readLog(paths.eventLog, { after, limit: 10_000, filter })), 500);
}

async function showPetLog(paths: Paths, house: string, pet: string, values: MoreValues): Promise<void> {
  const source = values.source === "on-start" ? "onStart" : (values.source ?? "setup");
  if (!isPetLogSource(source)) throw new HouseholdError("--source: setup, on-start, docker or kernel");
  // The text as read, byte for byte: a follow-up read can go on in the middle of a line.
  const read = async (query: string) => {
    const view = await api<PetLogView>(paths, "GET", `${petPath(house, pet)}/logs?source=${source}&${query}`);
    if (view.restarted) console.error("… the log started over");
    process.stdout.write(view.text);
    return view;
  };
  const first = await read(`lines=${lineCount(values.lines, 100)}`);
  if (!values.follow) {
    if (first.missing) return console.error(`no ${PET_LOG_SOURCES[source].label.toLowerCase()} log yet`);
    if (first.text && !first.text.endsWith("\n")) process.stdout.write("\n");
    return;
  }
  await follow(first.cursor, async (after) => (await read(`after=${encodeURIComponent(after)}`)).cursor, 2000);
}

/** Runs one of these commands; false when `command` and `args` are none of them. */
export async function runMore(paths: Paths, command: string | undefined, args: string[], values: MoreValues): Promise<boolean> {
  ({ command, args } = normalizeCommand(command, args));
  const [a, b, c, d] = args;
  const say = (text: string) => console.log(text);
  if (command === "logs" && args.length === 0) return showLog(paths, values).then(() => true);
  if (command === "show" && args.length === 1) return showHouse(paths, a!).then(() => true);
  if (command === "delete" && args.length === 1) {
    await api(paths, "DELETE", housePath(a!));
    say(`workspace '${a}' deleted`);
    return true;
  }
  if (command === "revoke" && args.length === 2) {
    const [host, port] = b!.split(":");
    await api(paths, "DELETE", `${housePath(a!)}/temporary/${enc(host!)}${port ? `?port=${enc(port)}` : ""}`);
    say(`workspace '${a}': temporary access to ${b} ended`);
    return true;
  }
  if (command === "timezone" && args.length <= 1) {
    const { timezone } = a ? await api<{ timezone: string }>(paths, "PUT", "/api/timezone", { timezone: a }) : await api<{ timezone: string }>(paths, "GET", "/api/timezone");
    say(a ? `timezone set to ${timezone}` : timezone);
    return true;
  }
  if (command === "key" && a === "set" && args.length === 2) {
    const value = values.value ?? (values.note === undefined ? (await textFrom(undefined)).trim() : undefined);
    await api(paths, "PATCH", `/api/keys/${enc(b!)}`, { ...(value === undefined ? {} : { value }), ...(values.note === undefined ? {} : { note: values.note }) });
    say(`key '${b}' changed`);
    return true;
  }
  if (command === "channel" && a === "set" && args.length === 3) {
    const pets = values.pets?.split(",").map((pet) => pet.trim()).filter(Boolean);
    const forward = values["forward-general"];
    if (forward !== undefined && forward !== "on" && forward !== "off") throw new HouseholdError("--forward-general takes on or off");
    const fields = { pets, default: values.default, name: values.name, note: values.note, token: values.token, appToken: values["app-token"], forwardGeneral: forward === undefined ? undefined : forward === "on" };
    await api(paths, "PATCH", `${housePath(b!)}/channels/${enc(c!)}`, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    say(`workspace '${b}': channel of chat ${c} changed`);
    return true;
  }
  if (command === "owner" && a === "set" && args.length === 4 && values.note !== undefined) {
    await api(paths, "PATCH", `${housePath(b!)}/owners/${enc(c!)}/${enc(d!)}`, { note: values.note || null });
    say(`workspace '${b}': owner ${c} ${d} changed`);
    return true;
  }
  if (command === "skills" && args.length === 1) {
    const entries = await api<{ path: string; kind: string; size: number }[]>(paths, "GET", `${housePath(a!)}/skills`);
    if (entries.length === 0) say("no skills");
    for (const entry of entries) say(entry.kind === "directory" ? `${entry.path}/` : `${entry.path}  ${entry.size} B`);
    return true;
  }
  if (command === "skills" && (a === "cat" || a === "put" || a === "rm") && args.length >= 3 && args.length <= 4) {
    const path = `${housePath(b!)}/skills/file`;
    const current = await api<{ content: string; revision: string }>(paths, "GET", `${path}?path=${enc(c!)}`).catch((error) => {
      if (a === "put" && /not found|no such/i.test((error as Error).message)) return undefined;
      throw error;
    });
    if (a === "cat") process.stdout.write(current!.content);
    if (a === "put") await api(paths, "PUT", path, { path: c, content: await textFrom(d), revision: current?.revision ?? null });
    if (a === "rm") await api(paths, "DELETE", path, { path: c, revision: current!.revision });
    if (a !== "cat") say(`skill file ${c} ${a === "put" ? "saved" : "deleted"}`);
    return true;
  }
  if (command !== "pet") return false;
  // house pet <verb> <house> <pet> …
  const [verb, house, pet, ...rest] = args as [string, string, string, ...string[]];
  if (!house || !pet) return false;
  const at = petPath(house, pet);
  if (verb === "show" && rest.length === 0) return showPet(paths, house, pet).then(() => true);
  if (verb === "enable" && rest.length === 0) {
    await api(paths, "PATCH", at, { enabled: true });
    say(`bot '${pet}' of workspace '${house}' enabled: its VM starts`);
    return true;
  }
  if (verb === "disable" && rest.length === 0) {
    if (!values.now) say("asking the harness to save its work (up to three minutes)…");
    await api(paths, "POST", `${at}/disable`, { mode: values.now ? "now" : "notify" });
    say(`bot '${pet}' of workspace '${house}' disabled: its VM is stopped, its files and memory stay`);
    return true;
  }
  if (verb === "restart" && rest.length === 0) {
    if (!values.now) say("asking the harness to save its work (up to three minutes)…");
    await api(paths, "POST", `${at}/environment/restart`, { mode: values.now ? "now" : "notify" });
    say(`bot '${pet}' of workspace '${house}' restarted`);
    return true;
  }
  if (verb === "screen" && rest.length === 0) {
    process.stdout.write(`${(await api<{ text: string }>(paths, "GET", `${at}/terminal`)).text}\n`);
    return true;
  }
  if (verb === "logs" && rest.length === 0) return showPetLog(paths, house, pet, values).then(() => true);
  // Subcommands: house pet env set <house> <pet> … reads as verb "env", house "set".
  const [sub, subHouse, subPet, ...subRest] = args.slice(1) as [string, string, string, ...string[]];
  const subAt = subHouse && subPet ? petPath(subHouse, subPet) : "";
  if (verb === "env" && rest.length === 0) return showEnvironment(paths, house, pet).then(() => true);
  if (verb === "env" && sub === "set" && subRest.length >= 1 && subRest.length <= 2) {
    const text = await textFrom(subRest[1]);
    await api(paths, "PATCH", `${subAt}/environment`, { [phaseOf(subRest[0])]: text.trim() ? text : null });
    say(`${subRest[0]} script of ${subHouse}/${subPet} ${text.trim() ? "saved" : "removed"}; saving runs nothing`);
    return true;
  }
  if (verb === "env" && sub === "run" && subRest.length === 1) {
    say("running (up to five minutes)…");
    const run = await api<EnvironmentRun>(paths, "POST", `${subAt}/environment/run`, { phase: phaseOf(subRest[0]) });
    say(`${run.status}: log ${run.logPath}, status ${run.statusPath} (read it: house bot logs ${subHouse} ${subPet} --source ${subRest[0]})`);
    process.exitCode = run.status === "failed" ? 1 : 0;
    return true;
  }
  if (verb === "instructions" && rest.length === 0) {
    process.stdout.write((await api<{ content: string }>(paths, "GET", `${at}/instructions`)).content);
    return true;
  }
  if (verb === "instructions" && sub === "set" && subRest.length <= 1) {
    const { revision } = await api<{ revision: string }>(paths, "GET", `${subAt}/instructions`);
    await api(paths, "PUT", `${subAt}/instructions`, { content: await textFrom(subRest[0]), revision });
    say(`instructions of ${subHouse}/${subPet} saved`);
    return true;
  }
  if (verb === "tasks" && rest.length === 0) return showTasks(paths, house, pet).then(() => true);
  if (verb === "tasks" && sub === "add" && subRest.length === 0) {
    if (!values.name || (!values.at && !values.cron)) throw new HouseholdError("a task needs --name and --at or --cron");
    const job = await api<CronJob>(paths, "POST", `${subAt}/crons`, { name: values.name, body: values.text ?? (await textFrom(undefined)), ...(values.at ? { at: values.at } : {}), ...(values.cron ? { cron: values.cron } : {}) });
    say(`task ${job.id} scheduled: ${job.cron ? `cron ${job.cron}` : `at ${job.localAt ?? job.at}`}`);
    return true;
  }
  if (verb === "tasks" && (sub === "set" || sub === "rm") && subRest.length === 1) {
    const view = await api<{ jobs: CronJob[] }>(paths, "GET", `${subAt}/crons`);
    const job = view.jobs.find((each) => each.id === subRest[0]);
    if (!job) throw new HouseholdError(`no task '${subRest[0]}' of ${subHouse}/${subPet}`);
    const path = `${subAt}/crons/${enc(job.id)}`;
    if (sub === "rm") {
      await api(paths, "DELETE", path, { revision: job.revision });
      say(`task ${job.id} deleted`);
      return true;
    }
    const when = values.cron ? { cron: values.cron } : values.at ? { at: values.at } : job.cron ? { cron: job.cron } : { at: job.localAt ?? job.at.slice(0, 16) };
    await api(paths, "PUT", path, { name: values.name ?? job.name, body: values.text ?? job.body, ...when, revision: job.revision });
    say(`task ${job.id} changed`);
    return true;
  }
  if (verb === "memory" && rest.length === 0) {
    const query = new URLSearchParams({ ...(values.grep ? { query: values.grep } : {}), ...(values.deleted ? { deleted: "true" } : {}) });
    const page = await api<MemoryPage>(paths, "GET", `${at}/memory?${query}`);
    if (page.entries.length === 0) say("no memory entries");
    for (const entry of page.entries) say(`${entry.key}${entry.deleted ? " (deleted)" : ""}  ${entry.excerpt}`);
    if (page.next) say("… more: narrow it with --grep");
    return true;
  }
  if (verb === "memory" && (sub === "get" || sub === "set" || sub === "rm") && subRest.length === 1) {
    const key = subRest[0]!;
    const entry = await memoryEntry(paths, subHouse, subPet, key);
    if (sub === "get") {
      if (!entry || entry.value === null) throw new HouseholdError(`no memory entry '${key}'`);
      process.stdout.write(entry.value.endsWith("\n") ? entry.value : `${entry.value}\n`);
      return true;
    }
    if (sub === "set") {
      await api(paths, "PUT", `${subAt}/memory`, { key, value: values.value ?? (await textFrom(undefined)), revision: entry?.revision ?? 0 });
      say(`memory '${key}' saved`);
      return true;
    }
    if (!entry || entry.value === null) throw new HouseholdError(`no memory entry '${key}'`);
    await api(paths, "DELETE", `${subAt}/memory`, { key, revision: entry.revision });
    say(`memory '${key}' deleted`);
    return true;
  }
  return false;
}
