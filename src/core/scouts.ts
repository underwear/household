import { formatAllowEntry, isAllowed, isWholeInternet, type AllowEntry } from "./network-policy";
import { houseFeatures, type HouseFeatures } from "./house-features";
import { block, SCOUTS_TAG, tagFreeJson } from "./tags";

/**
 * What a scout can do: software its install script fetches at the start of every run, skills (a folder of its own),
 * the network it needs, and keys (house secrets restricted to it). The owner defines it; a pet may only draft one.
 */
export interface CapabilityDefinition {
  name: string;
  description: string;
  /** Bash, run as root in each scout VM that has the capability, before the agent starts. */
  install: string;
  /** `any`: the capability does not narrow its scouts' network; else the hosts it needs, and only those. */
  network: { any: boolean; allow: AllowEntry[] };
  /**
   * Where its install script downloads from (apt's mirror, npm…): open to its scouts while their install scripts run,
   * closed before their agent starts. None: its install needs nothing beyond its network.
   */
  installHosts?: AllowEntry[];
  keys: CapabilityKey[];
  /** The scout blueprint it belongs to: such a capability is that blueprint's own, seen and used nowhere else. */
  owner?: string;
}
/** A house secret a capability brings: as a placeholder the gateway fills in (`gateway`), or its value in the VM (`vm`). */
export type CapabilityKey = { secret: string; via: "gateway"; env?: never } | { secret: string; via: "vm"; env: string };

/**
 * A scout (a "blueprint" in code, where a run is a scout too): an owner-defined specialist a pet calls by name. Its
 * own capability (owner: its name) and the shared ones it ticks make it; its agent and resources are the house's
 * unless it sets its own. Never part of a pet's MCP response beyond its name, title and description.
 */
export interface ScoutDefinition {
  name: string;
  title?: string;
  emoji?: string;
  description: string;
  instructions: string;
  /** Shared capability names, in the order their install scripts run (its own one runs last). */
  capabilities: string[];
  /** A repository cloned fresh for every run; the agent starts in it. */
  workspace?: { repo: string; branch?: string };
  /** Its own agent instead of the house's. */
  agent?: ScoutAgent;
  /** Its own CPU or memory instead of the house's (each left out: the house's). */
  resources?: Partial<ScoutResources>;
  /**
   * Bots of its workspace that run it with no Run card and message it with no Pass: the owner's standing trust for
   * low-stakes errands. Only while it reaches listed hosts alone (`routineFor`); never part of a run's definition.
   */
  routine?: string[];
}
/** A run has no time limit: like a sideworker, it runs until it finishes or its pet (or the owner) stops it. */
export interface ScoutResources { cpus: number; memoryMiB: number }
/** The agent a scout runs on: its own, or the house's for scouts that set none. */
export interface ScoutAgent { agent: string; key: string; model?: string; reasoningEffort?: string; mode?: string }
/** Default VM size; maxScouts is accepted only for legacy callers and never enforced. */
export interface ScoutLimits { maxScouts?: number; cpus: number; memoryMiB: number }
export const DEFAULT_SCOUT_LIMITS: ScoutLimits = { cpus: 2, memoryMiB: 2048 };
export const scoutLimits = (house: { scoutLimits?: Partial<ScoutLimits> }): ScoutLimits => ({ cpus: house.scoutLimits?.cpus ?? DEFAULT_SCOUT_LIMITS.cpus, memoryMiB: house.scoutLimits?.memoryMiB ?? DEFAULT_SCOUT_LIMITS.memoryMiB });
/** What one run is: a scout's definition with its agent and resources as of the call. */
export type ScoutRunDefinition = Omit<ScoutDefinition, "agent" | "resources" | "routine"> & ScoutAgent & { resources: ScoutResources };
/** The agent and resources a scout runs on: its own where it sets them, else the house's. */
export function scoutRuntime(house: { scoutAgent?: ScoutAgent; scoutLimits?: Partial<ScoutLimits> }, blueprint?: Pick<ScoutDefinition, "agent" | "resources">): { agent?: ScoutAgent; resources: ScoutResources } {
  const limits = scoutLimits(house);
  const agent = blueprint?.agent ?? house.scoutAgent;
  return { ...(agent ? { agent } : {}), resources: { cpus: limits.cpus, memoryMiB: limits.memoryMiB, ...blueprint?.resources } };
}

/** A blueprint's capabilities, by name: the shared ones it ticks, then its own (if it has one). */
export const blueprintCapabilities = (blueprint: Pick<ScoutDefinition, "name" | "capabilities">, capabilities: readonly CapabilityDefinition[]): string[] =>
  [...blueprint.capabilities, ...capabilities.filter(capability => capability.owner === blueprint.name).map(capability => capability.name)];
/** The capabilities any scout may tick: every one that is no scout's own. */
export const sharedCapabilities = (capabilities: readonly CapabilityDefinition[]) => capabilities.filter(capability => !capability.owner);

/** A capability's kind, as the admin shows it: a host list (or a key) makes it `access`; otherwise it is a `tool`. */
export const capabilityKind = (capability: Pick<CapabilityDefinition, "network" | "keys">): "tool" | "access" =>
  !capability.network.any || capability.keys.length > 0 ? "access" : "tool";

/** The host of a workspace repository, which every run must reach to clone it (HTTPS only). */
export function workspaceHost(workspace: ScoutDefinition["workspace"]): AllowEntry | undefined {
  if (!workspace) return undefined;
  try { const url = new URL(workspace.repo); return url.protocol === "https:" ? { host: url.hostname.toLowerCase(), port: Number(url.port || 443) } : undefined; }
  catch { return undefined; }
}

/**
 * What a scout's network is, from its capabilities: open unless one limits it, then only the union of their hosts.
 * A limit that lists `*` (any public host, on some port or all) is no limit to where data can go: open too.
 */
export interface ScoutNetwork {
  /** It can reach any public host: no capability limits it, or one lists `*`. Everything that weighs its risk asks this. */
  open: boolean;
  allow: AllowEntry[];
  /** The capabilities that limit it (none: open). */
  limitedBy: string[];
}
export function scoutNetwork(scout: Pick<ScoutDefinition, "capabilities" | "workspace">, capabilities: readonly CapabilityDefinition[]): ScoutNetwork {
  const used = scout.capabilities.flatMap(name => capabilities.filter(capability => capability.name === name));
  const limiting = used.filter(capability => !capability.network.any);
  const repo = workspaceHost(scout.workspace);
  const allow = [...limiting.flatMap(capability => capability.network.allow), ...(repo ? [repo] : [])];
  const unique = [...new Map(allow.map(entry => [`${entry.host}:${entry.port}`, entry])).values()];
  // `allow` stays what the VM's proxy gets (a `*:443` keeps its port); `open` says what that means for its data.
  return { open: limiting.length === 0 || unique.some(isWholeInternet), allow: limiting.length === 0 ? (repo ? [repo] : []) : unique, limitedBy: limiting.map(capability => capability.name) };
}

/**
 * What a scout's VM may reach besides its network while its install scripts run: the install hosts of its
 * capabilities, public addresses only. None for a scout on the open internet, which reaches them anyway.
 */
export function scoutInstallHosts(scout: Pick<ScoutDefinition, "capabilities" | "workspace">, capabilities: readonly CapabilityDefinition[]): AllowEntry[] {
  const network = scoutNetwork(scout, capabilities);
  if (network.open) return [];
  const used = scout.capabilities.flatMap(name => capabilities.filter(capability => capability.name === name));
  const reached = { kind: "allowlist" as const, allow: network.allow };
  const extra = used.flatMap(capability => capability.installHosts ?? []).filter(entry => !isAllowed(reached, { host: entry.host, port: entry.port as number }));
  return [...new Map(extra.map(entry => [`${entry.host}:${entry.port}`, { host: entry.host, port: entry.port, reach: "public" as const }])).values()];
}

/**
 * Why a scout on this network cannot be routine, in the owner's terms; undefined when it can. Routine needs exact
 * hosts: an open network lets a bot's errand carry data anywhere, and a wildcard (`*.github.io`) covers hosts anyone
 * can set up, which is no standing limit either. Wildcards stay fine for a scout that asks every time.
 */
export function routineBlocker(network: ScoutNetwork): string | undefined {
  if (network.open) return "Reaches the open internet";
  const wildcard = network.allow.find(entry => entry.host.startsWith("*"));
  return wildcard ? `Reaches ${formatAllowEntry(wildcard)}: routine needs exact hosts` : undefined;
}
/** The install hosts a scout gets from its definition (`scoutInstallHosts`): its ticked capabilities' and its own one's. */
export const blueprintInstallHosts = (scout: Pick<ScoutDefinition, "name" | "capabilities" | "workspace">, capabilities: readonly CapabilityDefinition[]) =>
  scoutInstallHosts({ capabilities: blueprintCapabilities(scout, capabilities), workspace: scout.workspace }, capabilities);
/** The network a scout gets from its definition: its ticked capabilities, its own one, its repository's host. */
export const blueprintNetwork = (scout: Pick<ScoutDefinition, "name" | "capabilities" | "workspace">, capabilities: readonly CapabilityDefinition[]) =>
  scoutNetwork({ capabilities: blueprintCapabilities(scout, capabilities), workspace: scout.workspace }, capabilities);

/**
 * Whether `pet` runs this scout as routine (no Run card, no Pass on its messages): the owner listed it, and the scout
 * reaches exact hosts only (`routineBlocker`). A capability edited since to open it makes every run strict again.
 */
export function routineFor(scout: Pick<ScoutDefinition, "name" | "capabilities" | "workspace" | "routine">, capabilities: readonly CapabilityDefinition[], pet: string): boolean {
  return !!scout.routine?.includes(pet) && !routineBlocker(blueprintNetwork(scout, capabilities));
}

/**
 * What a scout is now, as far as a bot's draft of it may write it: its own fields (without `routine`, and without its
 * repository, harness and size, which an applied draft keeps as they are) and its own setup's install, network and keys;
 * null for one that is not there. A draft made against one base and applied on another would quietly undo the
 * difference. JSON, so that it compares as stored.
 */
export interface ScoutBase {
  scout: Record<string, unknown> | null;
  /** `installHosts` is missing from a base stored before it was part of one: none, then. */
  own: { install: string; network: { any: boolean; allow: string[] }; installHosts?: string[]; keys: CapabilityKey[] } | null;
}
export function scoutBase(house: { scouts?: readonly ScoutDefinition[]; capabilities?: readonly CapabilityDefinition[] }, name: string): ScoutBase {
  const scout = (house.scouts ?? []).find(each => each.name === name), own = (house.capabilities ?? []).find(each => each.owner === name);
  const kept = scout && Object.fromEntries(Object.entries(scout).filter(([field]) => !["routine", "workspace", "agent", "resources"].includes(field)));
  return JSON.parse(JSON.stringify({
    scout: kept ?? null,
    own: own ? { install: own.install, network: { any: own.network.any, allow: own.network.allow.map(formatAllowEntry) }, installHosts: (own.installHosts ?? []).map(formatAllowEntry), keys: own.keys } : null,
  }));
}
/** What changed from one base to another, in the owner's words; none: the same. */
export function scoutBaseChanges(then: ScoutBase, now: ScoutBase, name: string): string[] {
  const changes: string[] = [], same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!then.scout && now.scout) changes.push(`a scout named ${name} was made since`);
  else if (then.scout && !now.scout) changes.push(`scout ${name} was deleted`);
  else if (then.scout && now.scout) for (const field of new Set([...Object.keys(then.scout), ...Object.keys(now.scout)])) if (!same(then.scout[field], now.scout[field])) changes.push(field);
  if (!then.own && now.own) changes.push("own setup (added)");
  else if (then.own && !now.own) changes.push("own setup (removed)");
  else if (then.own && now.own) {
    for (const field of ["install", "network", "keys"] as const) if (!same(then.own[field], now.own[field])) changes.push(`own setup's ${field}`);
    // A base stored before install hosts were part of one: its draft carries none, so applying it undoes none.
    if (then.own.installHosts && !same(then.own.installHosts, now.own.installHosts ?? [])) changes.push("own setup's install hosts");
  }
  return changes;
}
/** Why a draft made against an older base is not applied as it is. */
export const staleDraftMessage = (name: string, changes: readonly string[]) =>
  `Scout ${name} changed since it was drafted: ${changes.join(", ")}. Applying the draft would undo that; review it again, or apply it anyway with force.`;

/**
 * A scout's network in words, for the pet choosing it: "open internet", or "only" its hosts (at most eight named).
 * Facts Household computes, not the owner's description; its keys are never named.
 */
export function scoutNetworkWords(scout: Pick<ScoutDefinition, "name" | "capabilities" | "workspace">, capabilities: readonly CapabilityDefinition[]): string {
  const network = scoutNetwork({ capabilities: blueprintCapabilities(scout, capabilities), workspace: scout.workspace }, capabilities);
  if (network.open) return "open internet";
  const hosts = network.allow.map(formatAllowEntry);
  return `only ${hosts.slice(0, 8).join(", ")}${hosts.length > 8 ? ` and ${hosts.length - 8} more` : ""}`;
}

/** Where a scout's keys go: each with the capability it comes from. */
export const scoutKeys = (scout: Pick<ScoutDefinition, "capabilities">, capabilities: readonly CapabilityDefinition[]) =>
  scout.capabilities.flatMap(name => (capabilities.find(capability => capability.name === name)?.keys ?? []).map(key => ({ ...key, capability: name })));

/**
 * Why a scout cannot be made of these capabilities: an unknown one, or two keys in the same environment variable.
 * `envOf` gives a gateway key's variable (its secret's).
 */
export function scoutProblems(scout: Pick<ScoutDefinition, "capabilities">, capabilities: readonly CapabilityDefinition[], envOf: (secret: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const name of scout.capabilities) if (!capabilities.some(capability => capability.name === name)) problems.push(`unknown capability '${name}'`);
  const seen = new Map<string, string>();
  for (const key of scoutKeys(scout, capabilities)) {
    const env = key.via === "vm" ? key.env : envOf(key.secret);
    if (!env) continue;
    const first = seen.get(env);
    if (first && first !== key.capability) problems.push(`${env} is in both ${first} and ${key.capability}`);
    else if (first) problems.push(`${env} is used twice in ${key.capability}`);
    seen.set(env, key.capability);
  }
  return problems;
}

/** How much of a scout's description the catalog carries; the `scouts` tool has it whole. */
export const SCOUT_CATALOG_DESCRIPTION = 300;

/**
 * The house's scouts as a pet gets them, the way an agent lists its skills: a name to call, a description to choose
 * by and the network it reaches (can it get to the site?); not what it is made of, never its keys. Household sends it
 * at the start of a session, after compaction and when it changes (with the next message), as a block of JSON lines:
 * descriptions are the owner's text, and JSON keeps any tag in them from passing for ours. Empty while scouts are off.
 * `pet`: whose list it is; a scout routine for that pet says so.
 */
export function scoutsBlock(house: { features?: Partial<HouseFeatures>; scouts?: readonly Pick<ScoutDefinition, "name" | "title" | "emoji" | "description" | "capabilities" | "workspace" | "routine">[]; capabilities?: readonly CapabilityDefinition[] }, pet?: string): string {
  if (!houseFeatures(house).scouts) return "";
  const short = (text: string) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > SCOUT_CATALOG_DESCRIPTION ? `${one.slice(0, SCOUT_CATALOG_DESCRIPTION - 1).trimEnd()}…` : one; };
  const note = "The house's scouts now, from Household: specialists for one task each (skill household-scouts). Call one by name with scout_spawn({scout, task}) when its description and network fit the task; prefer the narrowest that fits. A scout limited to some hosts reaches nothing else unless your human allows more for that run. Every run waits for your human's Run, except one marked routine: true, which your human set to start for you without asking (pass it no secrets). If none fits, propose one with scout_draft (your human reviews and applies it). This replaces any older scouts list; the scouts tool has the same.";
  const lines = (house.scouts ?? []).map(scout => tagFreeJson({ name: scout.name, title: `${scout.emoji ? `${scout.emoji} ` : ""}${scout.title ?? scout.name}`, description: short(scout.description), network: scoutNetworkWords(scout, house.capabilities ?? []), ...(pet !== undefined && routineFor(scout, house.capabilities ?? [], pet) ? { routine: true } : {}) }));
  return block(SCOUTS_TAG, [tagFreeJson({ note, count: lines.length }), ...lines]) + "\n";
}
