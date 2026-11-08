import { HouseholdError } from "../core/errors";
import { callControl } from "../infra/control-socket";
import type { Paths } from "../infra/paths";
import type { PetLogView } from "../app/pet-logs";
import { api, follow, lineCount, textFrom } from "./commands";

/*
 * Features, capabilities and scouts: what the admin's Scouts pages do, through the daemon's own API (the control
 * socket's `/api`), plus what only the owner does from here: start a scout themself and watch its run (its logs,
 * its agent's screen). `--json` prints what the API answered, for scripts and agents.
 */

export const FEATURES_USAGE = `  house features <house> [scouts|preview|sideworkers=on|off …]
                                 the house's features: show them, or turn some on or off (scouts on for the first
                                 time: the capabilities browser, media, dev and the General scout made of them)`;

export const CAPABILITY_USAGE = `  house capability ls <house>    shared capabilities (kind, network, which scouts use them, last test) and pets' drafts
  house capability templates <house>  the built-in capabilities a new one can start from
  house capability show <house> <name>  one: its install script, network, keys, last test and revisions
  house capability add <house> <name> [--description <text>] [--install <file>|-] [--network any|h1,h2]
  house capability set <house> <name> [--description <text>] [--install <file>|-] [--network any|h1,h2]
                                 install: bash, as root, at the start of every run of a scout that has it; network:
                                 any (a tool) or only these hosts (access: its scouts reach only its hosts; list the
                                 hosts its install downloads from too)
  house capability rm <house> <name>
  house capability test <house> <name>  run its install in a fresh VM now; its log's tail, exit 1 when it failed
  house capability restore <house> <name> <rev>   a revision back, as a new one
  house capability duplicate <house> <name> <new-name>
  house capability key add <house> <name> <secret> --via gateway|vm --host h1,h2 --env VAR [--header <name>] [--value <value>]
                                 a key only its scouts get (value from stdin without --value): gateway puts it in the
                                 header to those hosts, the VM sees a placeholder; vm puts the value itself in VAR
  house capability key rm <house> <name> <secret>
  house capability skills <house> <name>  its skill files, copied into every scout that has it
  house capability skills cat|put|rm <house> <name> <path> [<file>]
  house capability drafts <house>  what pets proposed (capability_draft), waiting for review
  house capability draft show|apply|discard <house> <id>`;

export const SCOUT_USAGE = `  house scout ls <house>         its scouts (capabilities, network, problems), settings and runs under way
  house scout show <house> <name>  one: what it is, its access, what it runs on and its recent runs
  house scout add <house> <name> --description <text> [--title <t>] [--emoji <e>] [--capabilities a,b] [--instructions <file>|-]
                  [--repo <https url> [--branch <b>]] [--agent <a> --key <k> [--model …] [--reasoning-effort …] [--mode …]] [--cpus <n>] [--memory <GiB>]
  house scout set <house> <name> [the same flags]  ("" removes title, emoji, repo, agent, cpus or memory)
                                 description: when a pet should call it; capabilities: shared ones, installed in order
  house scout rm <house> <name>
  house scout own <house> <name> give it a setup of its own (a capability named after it): edit it with house capability set
  house scout instructions <house> <name>  /  house scout instructions set <house> <name> [<file>]
  house scout settings <house> [--max <n>] [--cpus <n>] [--memory <GiB>] [--agent <a> --key <k> [--model …] [--reasoning-effort …] [--mode …]]
                                 how many scouts run at once, and the agent and allocation of scouts that set none
  house scout run <house> <name> [--task <text>] [--pet <pet>] [--wait]
                                 start it yourself, with no Run card (task from stdin without --task); its thread opens
                                 in <pet>'s channel (default: the first pet in one), the pet hears nothing of it;
                                 --wait: until it says it is done or ends, exit 1 unless it succeeded
  house scout runs <house> [<name>]  runs, newest first
  house scout status <house> <run>  a run: status, outcome, setup failure, tools, files, secret and network requests
  house scout logs <house> <run> [--source setup|on-start|docker|kernel] [-n <lines>] [-f]
                                 a log inside its VM while it runs (setup: its capabilities' install scripts)
  house scout screen <house> <run>  its agent's terminal screen now (agents with one)
  house scout send <house> <run> <text>  a message to it, as if you wrote in its thread
  house scout cancel <house> <run>  stop it; its VM is deleted
  (the agent's own log: house logs --pet <run>)`;

export interface ScoutValues {
  json?: boolean;
  description?: string;
  install?: string;
  network?: string;
  capabilities?: string;
  instructions?: string;
  repo?: string;
  branch?: string;
  title?: string;
  emoji?: string;
  agent?: string;
  key?: string;
  model?: string;
  "reasoning-effort"?: string;
  mode?: string;
  cpus?: string;
  memory?: string;
  max?: string;
  task?: string;
  pet?: string;
  wait?: boolean;
  via?: string;
  env?: string;
  header?: string;
  host?: string;
  value?: string;
  source?: string;
  lines?: string;
  follow?: boolean;
}

interface CapabilityView {
  name: string; description: string; install: string; network: { any: boolean; allow: string[] }; owner?: string; ownerTitle?: string;
  keys: unknown[]; kind: string; usedBy: string[]; keyVariables: { secret: string; via: string; env: string }[];
  lastTest: { at: number; ok: boolean; seconds: number; output: string } | null; testing: boolean; revisions: number;
}
interface RevisionView { rev: number; at: number; author: unknown; summary: string; from?: { capability: string; rev: number } }
interface DraftView { id: string; capability: string; pet: string; at: number; definition: { description: string; install: string; network: { any: boolean; allow: string[] } }; needsKeys: string[] }
interface ScoutAgent { agent: string; key: string; model?: string; reasoningEffort?: string; mode?: string }
interface ScoutView {
  name: string; title?: string; emoji?: string; description: string; instructions: string; capabilities: string[];
  workspace?: { repo: string; branch?: string }; agent?: ScoutAgent; resources?: { cpus?: number; memoryMiB?: number };
  own: CapabilityView | null; network: { open: boolean; allow: string[]; limitedBy: string[] }; keysInVm: { capability: string; env: string }[]; problems: string[];
}
interface Limits { maxScouts: number; cpus: number; memoryMiB: number }
interface RunView {
  id: string; scout: string; blueprint?: string; number?: number; byOwner?: boolean; capabilities: string[]; parent: string; task: string;
  status: string; steps: number; startedAt?: string; endedAt?: string; outcome?: string; report?: string; setupFailure?: string;
}
interface RunDetail extends RunView {
  createdAt: string; runtime?: string; tools: Record<string, number>; files: { id: string; type: string; size: number }[];
  secretRequests: { key: string; status: string }[]; networkRequests: { domain: string; status: string }[];
}

const enc = encodeURIComponent;
const house = (name: string) => `/api/houses/${enc(name)}`;
const ENDED = ["done", "failed", "cancelled"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A comma list; [] for "" (none), undefined when not given. */
function list(text: string | undefined): string[] | undefined {
  return text === undefined ? undefined : text.split(",").map((item) => item.trim()).filter(Boolean);
}

/** `--network any` or `--network h1,h2`. */
function network(text: string | undefined): { any: boolean; allow: string[] } | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === "any") return { any: true, allow: [] };
  const allow = list(text)!;
  if (allow.length === 0) throw new HouseholdError("--network: any, or the hosts it may reach (h1,h2)");
  return { any: false, allow };
}

function number(flag: string, text: string): number {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value)) throw new HouseholdError(`${flag} takes a number`);
  return value;
}

const gib = (mib: number) => `${Math.round((mib / 1024) * 1000) / 1000} GiB`;
const agentWords = (agent: ScoutAgent | null | undefined) =>
  agent ? [agent.agent, agent.model && `model ${agent.model}`, agent.reasoningEffort && `effort ${agent.reasoningEffort}`, agent.mode && `mode ${agent.mode}`, `key ${agent.key}`].filter(Boolean).join("  ") : "none chosen";
const networkWords = (net: { any?: boolean; open?: boolean; allow: string[] }) => (net.any ?? net.open ? "any host" : `only ${net.allow.join(", ")}`);
const firstLine = (text: string, max = 80) => {
  const line = text.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const runName = (run: RunView) => `${run.blueprint ?? run.scout}${run.number ? ` #${run.number}` : ""}`;
const time = (iso: string | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "-");

/** The agent flags as a scout's or the house's agent: undefined when none given, null for `--agent ""`. */
function agentOf(values: ScoutValues, current: ScoutAgent | undefined): ScoutAgent | null | undefined {
  const given = ["agent", "key", "model", "reasoning-effort", "mode"].some((flag) => values[flag as keyof ScoutValues] !== undefined);
  if (!given) return undefined;
  if (values.agent === "") return null;
  const merged: Record<string, string | undefined> = { ...current, ...(values.agent ? { agent: values.agent } : {}), ...(values.key ? { key: values.key } : {}) };
  for (const [flag, field] of [["model", "model"], ["reasoning-effort", "reasoningEffort"], ["mode", "mode"]] as const) {
    const value = values[flag];
    if (value === undefined) continue;
    if (value === "") delete merged[field];
    else merged[field] = value;
  }
  if (!merged.agent || !merged.key) throw new HouseholdError("an agent needs --agent and --key (the key it runs on)");
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as unknown as ScoutAgent;
}

/** `--cpus` and `--memory` (GiB) as a scout's resources: undefined when neither is given; "" leaves one to the house. */
function resourcesOf(values: ScoutValues, current: { cpus?: number; memoryMiB?: number } | undefined): { cpus?: number; memoryMiB?: number } | null | undefined {
  if (values.cpus === undefined && values.memory === undefined) return undefined;
  const merged = { ...current };
  if (values.cpus !== undefined) {
    if (values.cpus === "") delete merged.cpus;
    else merged.cpus = number("--cpus", values.cpus);
  }
  if (values.memory !== undefined) {
    if (values.memory === "") delete merged.memoryMiB;
    else merged.memoryMiB = Math.round(number("--memory", values.memory) * 1024);
  }
  return Object.keys(merged).length ? merged : null;
}

/** Prints `data` as JSON with --json, else the human form. */
function out(values: ScoutValues, data: unknown, human: () => void): true {
  if (values.json) console.log(JSON.stringify(data, null, 2));
  else human();
  return true;
}

function usage(text: string, problem?: string): never {
  throw new HouseholdError(`${problem ? `${problem}\n` : ""}usage:\n${text}`);
}

/** The usage of a command group (`house scout --help`); undefined for the others. */
export function groupUsage(command: string | undefined): string | undefined {
  if (command === "features") return `usage:\n${FEATURES_USAGE}`;
  if (command === "capability" || command === "capabilities") return `usage:\n${CAPABILITY_USAGE}`;
  if (command === "scout" || command === "scouts") return `usage:\n${SCOUT_USAGE}`;
  return undefined;
}

/** Runs one of these commands; false when `command` is none of them. */
export async function runScouts(paths: Paths, command: string | undefined, args: string[], values: ScoutValues): Promise<boolean> {
  if (command === "features") return features(paths, args, values);
  if (command === "capability" || command === "capabilities") return capability(paths, args, values);
  if (command === "scout" || command === "scouts") return scout(paths, args, values);
  return false;
}

async function features(paths: Paths, args: string[], values: ScoutValues): Promise<boolean> {
  const [name, ...changes] = args;
  if (!name) usage(FEATURES_USAGE);
  const view = await api<{ features: Record<string, boolean>; preview: unknown }>(paths, "GET", house(name));
  if (changes.length === 0) return out(values, view.features, () => Object.entries(view.features).forEach(([feature, on]) => console.log(`${feature.padEnd(12)} ${on ? "on" : "off"}`)));
  const wanted = { ...view.features };
  for (const change of changes) {
    const [feature, state] = change.split("=");
    if (!feature || !(feature in wanted) || (state !== "on" && state !== "off")) usage(FEATURES_USAGE, `not a feature change: '${change}' (${Object.keys(wanted).join(", ")}=on|off)`);
    wanted[feature] = state === "on";
  }
  await api(paths, "PUT", `${house(name)}/features`, { features: wanted, preview: view.preview });
  return out(values, wanted, () => console.log(`house '${name}': ${Object.entries(wanted).map(([feature, on]) => `${feature} ${on ? "on" : "off"}`).join(", ")}`));
}

async function capability(paths: Paths, args: string[], values: ScoutValues): Promise<boolean> {
  const [verb, h, name, ...rest] = args;
  if (!verb || !h) usage(CAPABILITY_USAGE);
  const at = (capability: string) => `${house(h)}/capabilities/${enc(capability)}`;
  const say = (text: string) => console.log(text);

  if (verb === "ls" && !name) {
    const view = await api<{ capabilities: CapabilityView[]; drafts: DraftView[] }>(paths, "GET", `${house(h)}/capabilities`);
    return out(values, view, () => {
      if (view.capabilities.length === 0) say("no capabilities");
      for (const c of view.capabilities) {
        const test = c.testing ? "testing…" : c.lastTest ? `test ${c.lastTest.ok ? "ok" : "FAILED"} ${time(new Date(c.lastTest.at).toISOString())}` : "never tested";
        say(`${c.name}  ${c.kind}  network: ${networkWords(c.network)}  keys: ${c.keyVariables.map((key) => key.secret).join(", ") || "-"}  used by: ${c.usedBy.join(", ") || "-"}  ${test}`);
      }
      if (view.drafts.length) say(`\n${view.drafts.length} draft(s) from pets wait for review: house capability drafts ${h}`);
    });
  }
  if (verb === "templates" && !name) {
    const templates = await api<{ name: string; label?: string; description: string; network: { any: boolean; allow: string[] } }[]>(paths, "GET", `${house(h)}/capability-templates`);
    return out(values, templates, () => templates.forEach((t) => say(`${t.name}  network: ${networkWords(t.network)}  ${firstLine(t.description, 100)}`)));
  }
  if (verb === "drafts" && !name) {
    const drafts = await api<DraftView[]>(paths, "GET", `${house(h)}/capability-drafts`);
    return out(values, drafts, () => {
      if (drafts.length === 0) say("no drafts");
      for (const d of drafts) say(`${d.id}  ${d.capability}  by ${d.pet}  ${time(new Date(d.at).toISOString())}  network: ${networkWords(d.definition.network)}${d.needsKeys.length ? `  needs keys: ${d.needsKeys.join(", ")}` : ""}`);
    });
  }
  // house capability draft show|apply|discard <house> <id>: reads as verb "draft", h the action.
  if (verb === "draft" && name && rest.length === 1) {
    const [action, houseName, id] = [h, name, rest[0]!];
    if (action === "show") {
      const draft = (await api<DraftView[]>(paths, "GET", `${house(houseName)}/capability-drafts`)).find((d) => d.id === id);
      if (!draft) throw new HouseholdError(`no draft '${id}' in house '${houseName}'`);
      return out(values, draft, () => {
        say(`draft ${draft.id}: capability ${draft.capability}, by ${draft.pet}`);
        say(`description  ${draft.definition.description || "-"}`);
        say(`network      ${networkWords(draft.definition.network)}`);
        if (draft.needsKeys.length) say(`needs keys   ${draft.needsKeys.join(", ")}`);
        say(`# install\n${draft.definition.install || "(none)"}`);
      });
    }
    if (action === "apply") {
      const result = await api(paths, "POST", `${house(houseName)}/capability-drafts/${enc(id)}/apply`);
      return out(values, result, () => say(`draft ${id} applied`));
    }
    if (action === "discard") {
      await api(paths, "DELETE", `${house(houseName)}/capability-drafts/${enc(id)}`);
      return out(values, { ok: true }, () => say(`draft ${id} discarded`));
    }
  }
  // house capability key add|rm <house> <name> <secret>
  if (verb === "key" && (h === "add" || h === "rm") && name && rest.length === 2) {
    const [houseName, capabilityName, secret] = [name, rest[0]!, rest[1]!];
    const path = `${house(houseName)}/capabilities/${enc(capabilityName)}/keys`;
    if (h === "rm") {
      await api(paths, "DELETE", `${path}/${enc(secret)}`);
      return out(values, { ok: true }, () => say(`key ${secret} removed from capability '${capabilityName}' (its secret is deleted)`));
    }
    if (values.via !== "gateway" && values.via !== "vm") usage(CAPABILITY_USAGE, "--via gateway|vm");
    if (!values.host || !values.env) usage(CAPABILITY_USAGE, "a key needs --host and --env");
    const value = (values.value ?? (await textFrom(undefined))).trim();
    if (!value) throw new HouseholdError("no value given (--value, or on stdin); nothing saved");
    await api(paths, "POST", path, { secret, value, hosts: list(values.host), via: values.via, env: values.env, ...(values.header ? { header: values.header } : {}) });
    return out(values, { ok: true }, () => say(`key ${secret} added to capability '${capabilityName}' (${values.via === "vm" ? `its value in $${values.env} inside the VM` : `the gateway puts it in for ${values.host}`})`));
  }
  // house capability skills cat|put|rm <house> <name> <path> [<file>]
  if (verb === "skills" && (h === "cat" || h === "put" || h === "rm") && name && rest.length >= 2 && rest.length <= 3) {
    const [action, houseName, capabilityName, path, file] = [h, name, rest[0]!, rest[1]!, rest[2]];
    const at = `${house(houseName)}/capabilities/${enc(capabilityName)}/skills/file`;
    const current = await api<{ content: string; revision: string }>(paths, "GET", `${at}?path=${enc(path)}`).catch((error) => {
      if (action === "put" && /not found|no such/i.test((error as Error).message)) return undefined;
      throw error;
    });
    if (action === "cat") {
      if (values.json) return out(values, current, () => {});
      process.stdout.write(current!.content);
      return true;
    }
    if (action === "put") await api(paths, "PUT", at, { path, content: await textFrom(file), revision: current?.revision ?? null });
    else await api(paths, "DELETE", at, { path, revision: current!.revision });
    return out(values, { ok: true }, () => say(`skill file ${path} of capability '${capabilityName}' ${action === "put" ? "saved" : "deleted"}`));
  }
  if (!name) usage(CAPABILITY_USAGE, `unknown command or missing arguments: house capability ${args.join(" ")}`);

  if (verb === "show" && rest.length === 0) {
    const view = await api<{ capability: CapabilityView; history: RevisionView[]; drafts: DraftView[] }>(paths, "GET", at(name));
    const c = view.capability;
    return out(values, view, () => {
      say(`capability   ${c.name}${c.owner ? `  (own setup of scout ${c.ownerTitle ?? c.owner})` : ""}`);
      say(`description  ${c.description || "-"}`);
      say(`kind         ${c.kind}`);
      say(`network      ${networkWords(c.network)}`);
      say(`keys         ${c.keyVariables.map((key) => `${key.secret} (${key.via}${key.env ? `, $${key.env}` : ""})`).join(", ") || "-"}`);
      say(`used by      ${c.usedBy.join(", ") || "-"}`);
      say(`last test    ${c.testing ? "running now" : c.lastTest ? `${c.lastTest.ok ? "ok" : "FAILED"} in ${c.lastTest.seconds} s, ${time(new Date(c.lastTest.at).toISOString())}` : "never"}`);
      if (view.drafts.length) say(`drafts       ${view.drafts.map((d) => `${d.id} by ${d.pet}`).join(", ")}`);
      say(`revisions    ${view.history.slice(0, 5).map((r) => `r${r.rev} ${r.summary}`).join("; ")}`);
      say(`# install\n${c.install || "(none)"}`);
      if (c.lastTest && !c.lastTest.ok) say(`# last test's log (tail)\n${c.lastTest.output.split("\n").slice(-30).join("\n")}`);
    });
  }
  if ((verb === "add" || verb === "set") && rest.length === 0) {
    const install = values.install === undefined ? undefined : await textFrom(values.install);
    if (verb === "add") {
      const body = { name, ...(values.description !== undefined ? { description: values.description } : {}), ...(install !== undefined ? { install } : {}), ...(values.network !== undefined ? { network: network(values.network) } : {}) };
      const saved = await api(paths, "POST", `${house(h)}/capabilities`, body);
      return out(values, saved, () => say(`capability '${name}' added to house '${h}'; try its install: house capability test ${h} ${name}`));
    }
    const { capability: c } = await api<{ capability: CapabilityView }>(paths, "GET", at(name));
    const body = {
      name, description: values.description ?? c.description, install: install ?? c.install, network: network(values.network) ?? c.network, keys: c.keys,
      ...(c.owner ? { owner: c.owner } : {}),
    };
    const saved = await api(paths, "PUT", at(name), body);
    return out(values, saved, () => say(`capability '${name}' saved (a new revision)${install !== undefined ? `; try it: house capability test ${h} ${name}` : ""}`));
  }
  if (verb === "rm" && rest.length === 0) {
    await api(paths, "DELETE", at(name));
    return out(values, { ok: true }, () => say(`capability '${name}' removed`));
  }
  if (verb === "test" && rest.length === 0) {
    if (!values.json) console.error("installing in a fresh VM (minutes for a big install)…");
    const result = await api<{ at: number; ok: boolean; seconds: number; output: string }>(paths, "POST", `${at(name)}/test`);
    process.exitCode = result.ok ? 0 : 1;
    return out(values, result, () => {
      say(`${result.ok ? "ok" : "FAILED"} in ${result.seconds} s`);
      if (result.output) say(result.output.endsWith("\n") ? result.output.slice(0, -1) : result.output);
    });
  }
  if (verb === "restore" && rest.length === 1) {
    const rev = Number(rest[0]!.replace(/^r/, ""));
    if (!Number.isInteger(rev) || rev < 1) usage(CAPABILITY_USAGE, "restore takes a revision number");
    const saved = await api(paths, "POST", `${at(name)}/restore`, { rev });
    return out(values, saved, () => say(`capability '${name}' restored to r${rev} (as a new revision)`));
  }
  if (verb === "duplicate" && rest.length === 1) {
    const saved = await api(paths, "POST", `${at(name)}/duplicate`, { as: rest[0] });
    return out(values, saved, () => say(`capability '${name}' copied as '${rest[0]}'`));
  }
  if (verb === "skills" && rest.length === 0) {
    const entries = await api<{ path: string; kind: string; size: number }[]>(paths, "GET", `${at(name)}/skills`);
    return out(values, entries, () => {
      if (entries.length === 0) say("no skills");
      for (const entry of entries) say(entry.kind === "directory" ? `${entry.path}/` : `${entry.path}  ${entry.size} B`);
    });
  }
  usage(CAPABILITY_USAGE, `unknown command or missing arguments: house capability ${args.join(" ")}`);
}

async function scout(paths: Paths, args: string[], values: ScoutValues): Promise<boolean> {
  const [verb, h, name, ...rest] = args;
  if (!verb || !h) usage(SCOUT_USAGE);
  const at = (scoutName: string) => `${house(h)}/scouts/${enc(scoutName)}`;
  const run = (id: string) => `${house(h)}/scout-runs/${enc(id)}`;
  const say = (text: string) => console.log(text);

  if (verb === "ls" && !name) {
    const view = await api<{ scouts: ScoutView[]; runs: RunView[]; limits: Limits; agent: ScoutAgent | null }>(paths, "GET", `${house(h)}/scouts`);
    return out(values, view, () => {
      if (view.scouts.length === 0) say("no scouts (turn them on: house features <house> scouts=on)");
      for (const s of view.scouts) {
        say(`${s.name}${s.title ? `  "${s.emoji ?? "🧭"} ${s.title}"` : ""}  capabilities: ${s.capabilities.join(", ") || "-"}${s.own ? " + own setup" : ""}  network: ${networkWords(s.network)}${s.problems.length ? `  ! ${s.problems.join("; ")}` : ""}`);
        say(`  ${firstLine(s.description, 110)}`);
      }
      say(`\nsettings: up to ${view.limits.maxScouts} at once, ${view.limits.cpus} vCPU, ${gib(view.limits.memoryMiB)} each; agent: ${agentWords(view.agent)}`);
      const live = view.runs.filter((r) => !ENDED.includes(r.status));
      if (live.length) say(`running: ${live.map((r) => `${r.id} (${runName(r)}, ${r.status})`).join(", ")}`);
    });
  }
  if (verb === "settings" && !name) {
    const [limits, agent] = await Promise.all([api<Limits>(paths, "GET", `${house(h)}/scout-limits`), api<ScoutAgent | null>(paths, "GET", `${house(h)}/scout-agent`)]);
    const changed = { limits: false, agent: false };
    if (values.max !== undefined || values.cpus !== undefined || values.memory !== undefined) {
      const next = { ...limits, ...(values.max !== undefined ? { maxScouts: number("--max", values.max) } : {}), ...resourcesOf(values, limits) };
      Object.assign(limits, await api<Limits>(paths, "PUT", `${house(h)}/scout-limits`, next));
      changed.limits = true;
    }
    const nextAgent = agentOf(values, agent ?? undefined);
    if (nextAgent === null) usage(SCOUT_USAGE, "the house's scouts need an agent: --agent <a> --key <k>");
    let shownAgent = agent;
    if (nextAgent) {
      shownAgent = await api<ScoutAgent>(paths, "PUT", `${house(h)}/scout-agent`, nextAgent);
      changed.agent = true;
    }
    return out(values, { limits, agent: shownAgent }, () => {
      say(`at once     ${limits.maxScouts}`);
      say(`each        ${limits.cpus} vCPU, ${gib(limits.memoryMiB)} (unless a scout sets its own)`);
      say(`agent       ${agentWords(shownAgent)}`);
      if (changed.limits || changed.agent) say("saved; runs under way keep what they started with");
    });
  }
  if (verb === "runs" && rest.length === 0) {
    const runs = (await api<RunView[]>(paths, "GET", `${house(h)}/scout-runs`)).filter((r) => !name || (r.blueprint ?? r.scout) === name).reverse();
    return out(values, runs, () => {
      if (runs.length === 0) say("no runs");
      for (const r of runs) say(`${r.id}  ${runName(r).padEnd(14)} ${r.status.padEnd(16)} ${(r.outcome ?? "").padEnd(8)} ${time(r.startedAt)}  ${r.byOwner ? "by you" : `for ${r.parent}`}  ${firstLine(r.task, 60)}`);
    });
  }
  // house instructions set <house> <name> [<file>]: reads as verb "instructions", h "set".
  if (verb === "instructions" && h === "set" && name && rest.length <= 2) {
    const [houseName, scoutName, file] = [name, rest[0], rest[1]];
    if (!scoutName) usage(SCOUT_USAGE);
    const path = `${house(houseName)}/scouts/${enc(scoutName)}/instructions`;
    const { revision } = await api<{ revision: string }>(paths, "GET", path);
    await api(paths, "PUT", path, { content: await textFrom(file), revision });
    return out(values, { ok: true }, () => say(`instructions of scout '${scoutName}' saved; runs under way keep the ones they started with`));
  }
  if (!name) usage(SCOUT_USAGE, `unknown command or missing arguments: house scout ${args.join(" ")}`);

  if (verb === "show" && rest.length === 0) {
    const view = await api<{ scout: ScoutView; runs: RunView[]; defaults: { agent: ScoutAgent | null; limits: Limits } }>(paths, "GET", at(name));
    const s = view.scout;
    return out(values, view, () => {
      say(`scout        ${s.name}${s.title ? `  "${s.emoji ?? "🧭"} ${s.title}"` : ""}`);
      say(`description  ${s.description}`);
      say(`capabilities ${s.capabilities.join(", ") || "-"}${s.own ? `  + own setup (house capability show ${h} ${s.own.name})` : ""}`);
      say(`network      ${networkWords(s.network)}${s.network.limitedBy.length ? `  (limited by ${s.network.limitedBy.join(", ")})` : ""}`);
      if (s.keysInVm.length) say(`keys in VM   ${s.keysInVm.map((k) => `$${k.env} (${k.capability})`).join(", ")}`);
      if (s.workspace) say(`workspace    ${s.workspace.repo}${s.workspace.branch ? ` @ ${s.workspace.branch}` : ""}`);
      say(`agent        ${s.agent ? agentWords(s.agent) : `the house's: ${agentWords(view.defaults.agent)}`}`);
      const cpus = s.resources?.cpus ?? view.defaults.limits.cpus, memory = s.resources?.memoryMiB ?? view.defaults.limits.memoryMiB;
      say(`allocation   ${cpus} vCPU, ${gib(memory)}${s.resources ? "" : " (the house's)"}`);
      say(`instructions ${s.instructions.trim() ? `${s.instructions.length} characters (house scout instructions ${h} ${s.name})` : "none"}`);
      if (s.problems.length) say(`problems     ${s.problems.join("; ")}`);
      const runs = view.runs.slice(-5).reverse();
      if (runs.length) say(`runs         ${runs.map((r) => `${r.id} ${r.status}${r.outcome ? `/${r.outcome}` : ""}`).join(", ")}`);
    });
  }
  if ((verb === "add" || verb === "set") && rest.length === 0) {
    const instructions = values.instructions === undefined ? undefined : await textFrom(values.instructions);
    const current = verb === "set" ? (await api<{ scout: ScoutView }>(paths, "GET", at(name))).scout : undefined;
    const workspace = values.repo === undefined ? (values.branch !== undefined && current?.workspace ? { ...current.workspace, ...(values.branch ? { branch: values.branch } : {}) } : undefined)
      : values.repo === "" ? null : { repo: values.repo, ...(values.branch ? { branch: values.branch } : {}) };
    const fields: Record<string, unknown> = {
      ...(values.title !== undefined ? { title: values.title || null } : {}),
      ...(values.emoji !== undefined ? { emoji: values.emoji || null } : {}),
      ...(values.description !== undefined ? { description: values.description } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      ...(values.capabilities !== undefined ? { capabilities: list(values.capabilities) } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
    const agent = agentOf(values, current?.agent), resources = resourcesOf(values, current?.resources);
    if (agent !== undefined) fields.agent = agent;
    if (resources !== undefined) fields.resources = resources;
    if (verb === "add") {
      if (!values.description) usage(SCOUT_USAGE, "a scout needs --description: when a pet should call it");
      const body = Object.fromEntries(Object.entries({ name, ...fields }).filter(([, value]) => value !== null));
      const saved = await api(paths, "POST", `${house(h)}/scouts`, body);
      return out(values, saved, () => say(`scout '${name}' added to house '${h}'; pets see it with their next message`));
    }
    if (Object.keys(fields).length === 0) usage(SCOUT_USAGE, "nothing to change");
    const saved = await api(paths, "PATCH", at(name), fields);
    return out(values, saved, () => say(`scout '${name}' changed; runs under way keep what they started with`));
  }
  if (verb === "rm" && rest.length === 0) {
    await api(paths, "DELETE", at(name));
    return out(values, { ok: true }, () => say(`scout '${name}' removed (its own setup with it)`));
  }
  if (verb === "own" && rest.length === 0) {
    const saved = await api<{ name: string }>(paths, "POST", `${at(name)}/own`);
    return out(values, saved, () => say(`scout '${name}' has a setup of its own: capability '${saved.name}' (house capability set ${h} ${saved.name} --install <file> --network …)`));
  }
  if (verb === "instructions" && rest.length === 0) {
    const document = await api<{ content: string; revision: string }>(paths, "GET", `${at(name)}/instructions`);
    if (values.json) return out(values, document, () => {});
    process.stdout.write(document.content.endsWith("\n") || !document.content ? document.content : `${document.content}\n`);
    return true;
  }
  if (verb === "run" && rest.length === 0) {
    const task = values.task ?? (await textFrom(undefined));
    if (!task.trim()) usage(SCOUT_USAGE, "a run needs a task: --task, or on stdin");
    const started = await api<{ id: string; status: string }>(paths, "POST", `${at(name)}/runs`, { task, ...(values.pet ? { pet: values.pet } : {}) });
    if (!values.json) {
      say(`scout '${name}' started: run ${started.id}`);
      say(`  follow its setup: house scout logs ${h} ${started.id} -f    its state: house scout status ${h} ${started.id}`);
    }
    if (!values.wait) return out(values, started, () => {});
    const ended = await waitFor(paths, run(started.id), values.json ? undefined : say);
    process.exitCode = (ended.outcome ? ended.outcome === "success" : ended.status === "done") ? 0 : 1;
    return out(values, ended, () => {
      if (ended.setupFailure) say(ended.setupFailure);
      if (ended.report) say(`its last message:\n${ended.report}`);
    });
  }

  // A run's commands: <name> is a run id.
  if (verb === "status" && rest.length === 0) {
    const r = await api<RunDetail>(paths, "GET", run(name));
    return out(values, r, () => {
      say(`run          ${r.id}  ${runName(r)}  ${r.byOwner ? "started by you" : `called by ${r.parent}`}`);
      say(`status       ${r.status}${r.outcome ? `  outcome ${r.outcome}` : ""}`);
      say(`times        created ${time(r.createdAt)}  started ${time(r.startedAt)}  ended ${time(r.endedAt)}`);
      say(`capabilities ${r.capabilities.join(", ") || "-"}${r.runtime ? `  runs on ${r.runtime}` : ""}`);
      say(`steps        ${r.steps}  ${Object.entries(r.tools).map(([tool, count]) => `${tool} ${count}`).join(", ")}`);
      if (r.files.length) say(`files        ${r.files.map((f) => `${f.id} (${f.type}, ${f.size} B)`).join(", ")}`);
      if (r.secretRequests.length) say(`secrets      ${r.secretRequests.map((q) => `${q.key} ${q.status}`).join(", ")}`);
      if (r.networkRequests.length) say(`network asks ${r.networkRequests.map((q) => `${q.domain} ${q.status}`).join(", ")}`);
      say(`task         ${r.task}`);
      if (r.setupFailure) say(`# setup failed\n${r.setupFailure}`);
      if (r.report) say(`# its last message\n${r.report}`);
    });
  }
  if (verb === "logs" && rest.length === 0) {
    const source = values.source === "on-start" ? "onStart" : (values.source ?? "setup");
    const read = async (query: string) => {
      const view = await api<PetLogView>(paths, "GET", `${run(name)}/logs?source=${enc(source)}&${query}`);
      if (view.restarted) console.error("… the log started over");
      process.stdout.write(view.text);
      return view;
    };
    let first: PetLogView;
    try {
      first = await read(`lines=${lineCount(values.lines, 100)}`);
    } catch (error) {
      // Its VM is gone: what the daemon kept of a failed setup is all there is.
      const r = await api<RunDetail>(paths, "GET", run(name)).catch(() => undefined);
      if (r?.setupFailure) {
        console.error(`${(error as Error).message}; what was kept of its setup:`);
        say(r.setupFailure);
        return true;
      }
      throw error;
    }
    if (!values.follow) {
      if (first.missing) console.error(`no ${values.source ?? "setup"} log yet`);
      else if (first.text && !first.text.endsWith("\n")) process.stdout.write("\n");
      return true;
    }
    await follow(first.cursor, async (after) => (await read(`after=${enc(after)}`)).cursor, 2000);
  }
  if (verb === "screen" && rest.length === 0) {
    const screen = await api<{ text: string }>(paths, "GET", `${run(name)}/screen`);
    return out(values, screen, () => process.stdout.write(`${screen.text}\n`));
  }
  if (verb === "send" && rest.length >= 1) {
    const r = await api<RunDetail>(paths, "GET", run(name));
    if (ENDED.includes(r.status)) throw new HouseholdError(`run ${name} has ended (${r.status})`);
    const result = await callControl<{ activity: string; queued: number }>(paths.socket, "/send", { house: h, pet: name, text: rest.join(" ") });
    if (!result) throw new HouseholdError("daemon not running; start it with `house start`");
    return out(values, result, () => say(`queued for ${name} (it is ${result.activity}, ${result.queued} waiting)`));
  }
  if (verb === "cancel" && rest.length === 0) {
    await api(paths, "DELETE", run(name));
    return out(values, { ok: true }, () => say(`run ${name} stopped; its VM is deleted`));
  }
  usage(SCOUT_USAGE, `unknown command or missing arguments: house scout ${args.join(" ")}`);
}

/** Polls a run until it says it is done (an outcome) or ends; says each change of its status. */
async function waitFor(paths: Paths, path: string, say: ((text: string) => void) | undefined): Promise<RunDetail> {
  let last = "";
  for (;;) {
    const r = await api<RunDetail>(paths, "GET", path);
    const now = `${r.status}${r.outcome ? ` (says it is done: ${r.outcome})` : ""}`;
    if (now !== last) say?.(`${new Date().toISOString().slice(11, 19)}  ${now}`);
    last = now;
    if (ENDED.includes(r.status) || r.outcome) return r;
    await sleep(3000);
  }
}
