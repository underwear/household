import type { HouseInbox } from "./house-inboxes";
import type { CapabilityDefinition, ScoutAgent, ScoutDefinition, ScoutLimits } from "./scouts";
import type { HouseFeatures, PreviewSettings } from "./house-features";
import type { Place, SenderRef } from "./channel";
import type { ChannelConfig, Platform } from "./channels";
import type { PetEnvironment } from "./environment";
import type { PetLifecycle } from "./lifecycle";
import { DEFAULT_PET_EMOJI } from "./emoji";
import { HouseholdError } from "./errors";
import type { Trust } from "./header";
import type { AgentKey } from "./keys";
import { assertName, assertPetName } from "./names";
import type { NetworkPolicy } from "./network-policy";
import type { Secret } from "./secrets";

export interface Pet {
  /** Runtime-only placement for a helper sharing an existing place. */
  chatPlace?: string;
  /** Runtime-only parent conversation captured when a helper was spawned. */
  originPlace?: string;
  scout?: { gatewaySecrets?: import("./secrets").PlacedSecret[]; /** The capabilities it was made of: its keys must be restricted to one of them. */ capabilities?: string[]; definition: string; parent: string; homePath: string; skillsPath?: string; instructions: string; env?: Record<string, string>; setup?: string; network: NetworkPolicy };
  /** Runtime-only worker identity; workers are persisted separately from configured pets. */
  sideworker?: { parent: string; cwd: string; parentHome?: string; /** Its own git worktree's branch, when it has one. */ branch?: string };
  /** False temporarily stops the pet; omission means enabled. */
  enabled?: boolean;
  cpus?: number;
  memoryMiB?: number;
  name: string;
  /** Optional repeatable setup, saved without executing it or restarting the pet. */
  environment?: PetEnvironment;
  /** Scheduled restarts with their shutdown and wake-up messages (core/lifecycle.ts); none when absent. */
  lifecycle?: PetLifecycle;
  /** Name of the agent adapter that runs this pet; the app's default when absent. */
  agent?: string;
  /** One of its agent's models; the agent's default when absent. */
  model?: string;
  /** Explicit reasoning effort; absent keeps the agent's native default. */
  reasoningEffort?: string;
  /** One of its agent's permission modes; the agent's default when absent. */
  mode?: string;
  /** Its agent's own settings (`AgentAdapter.settings`), by key; each the agent's default when absent. */
  settings?: Record<string, string>;
  /** The key it runs on (one of `Household.keys`, of a provider its agent takes); the only such key when absent. */
  key?: string;
  /** How the pet is called in the chat; its name, capitalised, when absent. */
  title?: string;
  /** Its mark, in front of its title wherever people see it (one emoji); DEFAULT_PET_EMOJI when absent. */
  emoji?: string;
  /** Other names a person may call it by at the start of a message («Sibling, …»), besides its name and title. */
  aliases?: string[];
}

/** An owner, on one platform, by the id it knows them by (`telegram`: a Telegram user id; later a phone number). */
export interface Owner {
  platform: Platform;
  id: string;
  /** The owner's own words about it («my wife's phone»): for the web UI only, never told to a pet or a chat. */
  note?: string;
}

/**
 * Who the house's people are. `owners`: the house's owners, each on a platform (one person on two platforms is
 * two entries); anyone else who writes is a guest (marked, never dropped).
 */
export interface People {
  owners: Owner[];
}

export const sameOwner = (a: Owner, b: Owner) => a.platform === b.platform && a.id === b.id;

/** Owner-approved launch choice; key is a credential reference, never its value. */
export interface SideworkerProfile {
  name: string;
  agent: string;
  key: string;
  model?: string;
  reasoningEffort?: string;
  mode?: string;
}

export interface SideworkerLimits { maxWorkers: number; cpus: number; memoryMiB: number }

export interface House {
  inboxes?: HouseInbox[];
  capabilities?: CapabilityDefinition[];
  scouts?: ScoutDefinition[];
  scoutLimits?: Partial<ScoutLimits> & { maxScouts: number };
  /** The agent of every scout of the house that does not set its own. */
  scoutAgent?: ScoutAgent;
  features?: Partial<HouseFeatures>;
  preview?: PreviewSettings;
  sideworkerLimits?: SideworkerLimits;
  sideworkerProfiles?: SideworkerProfile[];
  name: string;
  network: NetworkPolicy;
  pets: Pet[];
  people: People;
  /** The chats the house is in, each with the pets placed in it (core/channels.ts). */
  channels: ChannelConfig[];
}

export interface Household {
  timezone?: string;
  /** Daemon settings; read at `house start`. */
  daemon: { agentPort?: number; webPort?: number };
  /** The agent-provider keys the pets run on, in the config's order (core/keys.ts). */
  keys: AgentKey[];
  /** The owner's own secrets, each for some houses' pets (core/secrets.ts). */
  secrets: Secret[];
  houses: House[];
}

export function findHouse(household: Household, name: string): House | undefined {
  return household.houses.find((house) => house.name === name);
}

/** How the pet is called: its title, or its name capitalised. */
export const petTitle = (pet: Pet) => pet.title ?? pet.name.charAt(0).toUpperCase() + pet.name.slice(1);

/** How people see the pet named: its emoji and its title ("🦉 Sibling"), in thread titles, notes, cards, the web. */
export const petDisplay = (pet: Pet) => `${pet.emoji ?? DEFAULT_PET_EMOJI} ${petTitle(pet)}`;

/** The pet's place in a channel, titled as people see the pet, under Household's id for it. */
export const petPlace = (pet: Pet, id: string): Place => ({ id, kind: "pet-thread", title: petDisplay(pet) });

/**
 * How far Household trusts a sender, from the config alone: one of the house's owners, as a channel of the house
 * on that owner's platform tells (`isSender`: whether the sender is this owner), is the owner; anyone else is a
 * guest.
 */
export function trustOf(people: People, isSender: (owner: Owner) => boolean): Trust {
  return people.owners.some(isSender) ? "owner" : "guest";
}

export function assertCanCreateHouse(household: Household, name: string): void {
  assertName("house", name);
  if (findHouse(household, name)) throw new HouseholdError(`workspace '${name}' already exists`);
}

export function assertCanAddPet(household: Household, houseName: string, pet: string): void {
  assertPetName(pet);
  const house = findHouse(household, houseName);
  if (!house) throw new HouseholdError(`unknown workspace '${houseName}'`);
  if (house.pets.some((existing) => existing.name === pet)) throw new HouseholdError(`bot '${pet}' already exists in workspace '${houseName}'`);
}

/** A worker has private harness state while the parent home stays at its original path. */
export const effectivePetHome = (pet: { sideworker?: unknown }, agentHome: string) => pet.sideworker ? "/home/worker" : agentHome;
