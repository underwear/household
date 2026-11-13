import { houseFeatures } from "../core/house-features";
import { systemPrompt, type PromptRole } from "../core/prompts";
import { codexAppServer } from "../agent-adapters/codex-app-server";
import { claudeCodeTmux } from "../agent-adapters/claude-code-tmux";
import { placedKeyUse, type AgentAdapter, type KeyUse } from "../core/agent";
import type { PetEnvironment } from "../core/environment";
import { HouseholdError } from "../core/errors";
import type { House, Household, Pet } from "../core/household";
import { keyFor, type AgentKey } from "../core/keys";
import { sameEndpoint, type Endpoint } from "../core/network-policy";
import { houseSecrets, type PlacedSecret } from "../core/secrets";
import { volumesOf, type Volume } from "../core/volumes";

export type Agents = ReadonlyMap<string, AgentAdapter>;

/** The agent of a pet whose config does not name one. */
export const DEFAULT_AGENT = claudeCodeTmux.name;

/** The adapters this build knows. A new agent kind is one more entry here. */
export function knownAgents(): Agents {
  return new Map([[claudeCodeTmux.name, claudeCodeTmux], [codexAppServer.name, codexAppServer]]);
}

/**
 * A pet from the config together with the adapter that runs it, the model it runs (one of the adapter's) and the
 * key it runs on: its name and how the agent uses it (never its value).
 */
export interface PlacedPet {
  /** Household's system prompt for its role (pet, sideworker or scout), in its house; none in tests that need none. */
  instructions?: string;
  sideworker?: Pet["sideworker"];
  scout?: Pet["scout"];
  enabled?: boolean;
  cpus?: number;
  memoryMiB?: number;
  house: string;
  pet: string;
  /** Config-owned script, independent of the VM identity and agent launch settings. */
  environment?: PetEnvironment;
  agent: AgentAdapter;
  model: string;
  /** Explicit effort only; absent preserves the native agent default. */
  reasoningEffort?: string;
  /** One of the agent's modes (undefined for an agent without modes). */
  mode?: string;
  /** The agent's own settings the config sets, each checked against `AgentAdapter.settings`; absent when none. */
  settings?: Readonly<Record<string, string>>;
  key: string;
  keyUse: KeyUse;
  /** Its house's secrets: their placeholders go into its VM, their hosts are opened for it. */
  secrets?: PlacedSecret[];
  /** The host folders mounted for it at /volumes/<name> (its parent's, for a sideworker). */
  volumes?: Pick<Volume, "name" | "path" | "access">[];
}

/**
 * Resolves every pet's agent, model and key. Unknown agents and models, and a key that is missing, ambiguous or
 * not the agent's, are a config error, reported for all such pets at once, before any container is touched, so a
 * typo leaves everything running as it was.
 */
export function placePets(agents: Agents, { houses, keys }: Pick<Household, "houses" | "keys">): PlacedPet[] {
  const unknown: string[] = [];
  const placed = houses.flatMap((house) =>
    house.pets.flatMap((pet) => {
      const secrets = house.secrets ?? [];
      const found = agentOf(agents, pet, keys, house.name);
      if ("problem" in found) unknown.push(`bot ${house.name}/${pet.name}: ${found.problem}`);
      if ("problem" in found) return [];
      const mode = found.mode === undefined ? {} : { mode: found.mode };
      const role: PromptRole = pet.scout ? { kind: "scout", name: pet.scout.definition, parent: pet.scout.parent, house: house.name, instructions: pet.scout.instructions }
        : pet.sideworker ? { kind: "sideworker", name: pet.name, parent: pet.sideworker.parent, house: house.name, cwd: pet.sideworker.cwd, ...(pet.sideworker.branch ? { branch: pet.sideworker.branch } : {}) }
        : { kind: "pet" };
      const volumes = volumesOf(house, pet).map(({ name, path, access }) => ({ name, path, access }));
      return [{ instructions: systemPrompt({ role, features: houseFeatures(house), volumes, ...(role.kind === "pet" && pet.lifecycle ? { lifecycle: pet.lifecycle } : {}) }), house: house.name, pet: pet.name, ...(volumes.length ? { volumes } : {}), ...(pet.sideworker ? { sideworker: pet.sideworker } : {}), ...(pet.scout ? { scout: pet.scout } : {}), ...(pet.enabled === undefined ? {} : { enabled: pet.enabled }), ...(pet.cpus === undefined ? {} : { cpus: pet.cpus }), ...(pet.memoryMiB === undefined ? {} : { memoryMiB: pet.memoryMiB }), ...(pet.environment === undefined ? {} : { environment: pet.environment }), agent: found.agent, model: found.model, ...(found.reasoningEffort === undefined ? {} : { reasoningEffort: found.reasoningEffort }), ...mode, ...(found.settings === undefined ? {} : { settings: found.settings }), key: found.key.name, keyUse: placedKeyUse(found.use, found.agent, found.settings, !!pet.scout), secrets: pet.scout ? (pet.scout.gatewaySecrets ?? []).filter(selected => secrets.some(secret => secret.name === selected.name && !!secret.onlyForCapabilities?.some(capability => pet.scout!.capabilities?.includes(capability)))) : houseSecrets(secrets) }];
    }),
  );
  if (unknown.length > 0) throw new HouseholdError(unknown.join("\n"));
  return placed;
}

/** A pet's agent, model, mode and key, the defaults resolved; or what is wrong with them (naming what would do). */
export function agentOf(agents: Agents, pet: Pet, keys: AgentKey[], house?: string): { agent: AgentAdapter; model: string; reasoningEffort?: string; mode?: string; settings?: Record<string, string>; key: AgentKey; use: KeyUse } | { problem: string } {
  const name = pet.agent ?? DEFAULT_AGENT;
  const agent = agents.get(name);
  if (!agent) return { problem: `unknown harness '${name}' (known harnesses: ${[...agents.keys()].join(", ")})` };
  const model = pet.model ?? agent.defaultModel;
  if (!agent.models.includes(model) && !agent.acceptsModel?.(model)) return { problem: `unknown model '${model}' for harness ${name} (its models: ${agent.models.join(", ")})` };
  const reasoningEffort = pet.reasoningEffort;
  if (reasoningEffort !== undefined && !agent.acceptsReasoningEffort?.(model, reasoningEffort)) {
    const options = agent.modelOptions?.(model)?.supportedReasoningEfforts?.map(({ reasoningEffort }) => reasoningEffort) ?? [];
    return { problem: `unsupported reasoning effort '${reasoningEffort}' for model '${model}' of harness ${name}${options.length ? ` (its efforts: ${options.join(", ")})` : ": leave reasoningEffort out"}` };
  }
  const namedMode = pet.mode ?? agent.modes?.default;
  const mode = namedMode === undefined ? undefined : agent.modes?.aliases?.[namedMode] ?? namedMode;
  const modes = agent.modes?.options.map(({ id }) => id) ?? [];
  if (pet.mode !== undefined && (mode === undefined || !modes.includes(mode))) {
    return { problem: modes.length === 0 ? `harness ${name} has no permission modes: leave mode out` : `unknown mode '${pet.mode}' for harness ${name} (its modes: ${modes.join(", ")})` };
  }
  const settings = settingsOf(agent, pet.settings);
  if ("problem" in settings) return settings;
  const key = keyFor(keys, pet.key, agent.providers, name, house);
  if ("problem" in key) return key;
  const use = agent.useKey(key.provider, key.value);
  if ("problem" in use) return { problem: `key '${key.name}': ${use.problem}` };
  return { agent, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(mode === undefined ? {} : { mode }), ...settings, key, use };
}

/**
 * The agent's own settings the config sets, each one the agent has, with one of its options; or what is wrong
 * with them (naming what would do). `{}`: none set.
 */
function settingsOf(agent: AgentAdapter, given: Pet["settings"]): { settings?: Record<string, string> } | { problem: string } {
  const entries = Object.entries(given ?? {});
  if (entries.length === 0) return {};
  const known = agent.settings ?? [];
  if (known.length === 0) return { problem: `harness ${agent.name} has no settings: leave settings out` };
  for (const [key, value] of entries) {
    const setting = known.find((each) => each.key === key);
    if (!setting) return { problem: `unknown setting '${key}' for harness ${agent.name} (its settings: ${known.map((each) => each.key).join(", ")})` };
    if (!setting.options.some((option) => option.id === value)) return { problem: `unknown value '${value}' for setting '${key}' of harness ${agent.name} (its values: ${setting.options.map((option) => option.id).join(", ")})` };
  }
  return { settings: Object.fromEntries(entries) };
}

/** What the config check that needs the agents finds (a pet's agent, model or key wrong), one line each: for the ConfigStore. */
export const agentCheck = (agents: Agents) => (household: Household) =>
  household.houses.flatMap((house) => [
    ...house.pets.flatMap((pet) => {
      const found = agentOf(agents, pet, household.keys, house.name);
      return "problem" in found ? [`bot ${house.name}/${pet.name}: ${found.problem}`] : [];
    }),
    ...sideworkerProfileProblems(agents, house, household.keys),
    // A scout with its own agent.
    ...(house.scouts ?? []).flatMap(scout => { if (!scout.agent) return []; const found = agentOf(agents, { name: scout.name, ...scout.agent }, household.keys, house.name); return "problem" in found ? [`scout ${house.name}/${scout.name}: ${found.problem}`] : []; }),
    // The house's scout agent (every scout's without its own).
    ...(house.scoutAgent ? (() => { const found = agentOf(agents, { name: "scouts", ...house.scoutAgent }, household.keys, house.name); return "problem" in found ? [`scouts of ${house.name}: ${found.problem}`] : []; })() : []),
  ]);

/** Profiles are validated through precisely the same adapter and credential contract as pets. */
export const sideworkerProfileProblems = (agents: Agents, house: House, keys: AgentKey[]): string[] =>
  (house.sideworkerProfiles ?? []).flatMap(profile => {
    const found = agentOf(agents, profile, keys, house.name);
    return "problem" in found ? [`sideworker profile ${house.name}/${profile.name}: ${found.problem}`] : [];
  });

/**
 * The hosts a house's pets send their keys to (their keys' wire: the daemon adds them to its policy, so they are
 * reachable whatever its allowlist says), each once; a pet whose agent, model or key is wrong adds none.
 */
export function agentHosts(agents: Agents, house: House, keys: AgentKey[]): Endpoint[] {
  const hosts: Endpoint[] = [];
  for (const pet of house.pets) {
    const found = agentOf(agents, pet, keys, house.name);
    for (const { target } of "problem" in found ? [] : found.use.wire) {
      if (!hosts.some((host) => sameEndpoint(host, target))) hosts.push(target);
    }
  }
  return hosts;
}

/** What kind of key a value is (`subscription`, `API key`), as the first agent of its provider tells; undefined when none can. */
export function keyKind(agents: Agents, key: AgentKey): string | undefined {
  for (const agent of agents.values()) {
    if (!agent.providers.includes(key.provider)) continue;
    const use = agent.useKey(key.provider, key.value);
    if (!("problem" in use)) return use.kind;
  }
  return undefined;
}

/** Each run has its own exact subject; the house allowlist never grants a scout access. */
export function scoutSubjects(pets: PlacedPet[]): import("./gateway").SubjectSpec[] {
  return pets.filter(pet => pet.scout).map(pet => {
    const intercept = [...pet.keyUse.wire.map(wire => wire.target), ...(pet.secrets ?? []).flatMap(secret => secret.hosts)];
    return { subject: { kind: "scout" as const, name: pet.house, pet: pet.pet }, policy: { kind: "allowlist" as const, allow: [...pet.scout!.network.allow, ...pet.keyUse.wire.map(wire => wire.target)] }, intercept };
  });
}