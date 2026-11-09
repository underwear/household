import { formatAllowEntry, type AllowEntry } from "./network-policy";
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
export type ScoutRunDefinition = Omit<ScoutDefinition, "agent" | "resources"> & ScoutAgent & { resources: ScoutResources };
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

/** What a scout's network is, from its capabilities: open unless one limits it, then only the union of their hosts. */
export interface ScoutNetwork {
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
  return { open: limiting.length === 0, allow: limiting.length === 0 ? (repo ? [repo] : []) : unique, limitedBy: limiting.map(capability => capability.name) };
}

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
 */
export function scoutsBlock(house: { features?: Partial<HouseFeatures>; scouts?: readonly Pick<ScoutDefinition, "name" | "title" | "emoji" | "description" | "capabilities" | "workspace">[]; capabilities?: readonly CapabilityDefinition[] }): string {
  if (!houseFeatures(house).scouts) return "";
  const short = (text: string) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > SCOUT_CATALOG_DESCRIPTION ? `${one.slice(0, SCOUT_CATALOG_DESCRIPTION - 1).trimEnd()}…` : one; };
  const note = "The house's scouts now, from Household: specialists for one task each (skill household-scouts). Call one by name with scout_spawn({scout, task}) when its description and network fit the task; prefer the narrowest that fits. A scout limited to some hosts reaches nothing else unless your human allows more for that run. Every run waits for your human's Run. If none fits, tell your human what scout you need. This replaces any older scouts list; the scouts tool has the same.";
  const lines = (house.scouts ?? []).map(scout => tagFreeJson({ name: scout.name, title: `${scout.emoji ? `${scout.emoji} ` : ""}${scout.title ?? scout.name}`, description: short(scout.description), network: scoutNetworkWords(scout, house.capabilities ?? []) }));
  return block(SCOUTS_TAG, [tagFreeJson({ note, count: lines.length }), ...lines]) + "\n";
}
