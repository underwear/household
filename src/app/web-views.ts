import type { HouseFeatures, PreviewSettings } from "../core/house-features";
// The JSON the web UI gets from the daemon's API: types only, so web/ can import them without bundling any code.
import type { AgentModel } from "../core/agent";
import type { ChannelKindSpec, PlatformSpec } from "../core/channels";
import type { Owner, SideworkerLimits, SideworkerProfile } from "../core/household";
import type { Provider } from "../core/keys";
import type { AgentSetting } from "../core/agent";
import type { Allowance } from "../core/allowance";
import type { HostCapacity } from "../core/resources";
import type { TemporaryGrant } from "./network-requests";
import type { PetLifecycle } from "../core/lifecycle";

/** A kind of channel: its platform, label, a line on it, its own fields (a form renders them as they are). */
export type ChannelKindView = ChannelKindSpec;
/** A platform: its label, and what an owner's id there is (a form renders it as it is; the check is the server's). */
export type PlatformView = Omit<PlatformSpec, "valid">;
/** An owner of a house, on a platform; what is wrong with it (an id that is not one of the platform's), or null. */
export type OwnerView = Omit<Owner, "note"> & { note: string | null; problem: string | null };

export interface MeView {
  version: string;
  state: "starting" | "running";
  /** The agents a pet may run, with their models. */
  agents: AgentView[];
  /** The kinds of channel a house may have, with their fields. */
  channelKinds: ChannelKindView[];
  /** The platforms of those kinds (where owners are). */
  platforms: PlatformView[];
  /** The providers a key may be of. */
  providers: readonly Provider[];
  /** How long a note (an owner's, a channel's, a key's) may be. */
  noteMax: number;
  /** The machine's CPUs and memory: the most one pet may be given, and what all of them share. */
  host: HostCapacity;
}

export interface AgentView {
  name: string;
  /** Whether its running pet offers a read-only terminal snapshot. */
  terminal?: boolean;
  models: readonly string[];
  defaultModel: string;
  dynamicModels?: boolean;
  /** Per-model options known without account discovery. */
  modelOptions?: AgentModel[];
  /** Its permission modes with how people call them, and the default (none: it has no modes; the form shows no field). */
  modes: { id: string; label: string; description?: string }[];
  defaultMode: string | null;
  /** Its own settings (a field each, drawn from the description; none: no fields). */
  settings: AgentSetting[];
  /** The providers whose keys it runs on. */
  providers: readonly Provider[];
}

export interface AgentModelsView {
  models: AgentModel[];
  source: "live" | "cache" | "default";
}

/** A key the pets may run on, as the Keys page shows it: its value too (the owner's own screen). */
export interface KeyView {
  name: string;
  provider: Provider;
  /** What kind of key it is (`subscription`, `API key`), as an agent of its provider tells; null when none can. */
  kind: string | null;
  value: string;
  note: string | null;
  /** `house/pet` of each pet that names it. */
  pets: string[];
  /** The houses whose pets may run on it; null: every house. */
  houses: string[] | null;
  /** A subscription's: whether its pets go on past its allowance, billed apart (off: the gateway refuses them until it starts over). */
  allowOverage: boolean;
  /** What its provider last said is left of it (the gateway's meter); null when it never said (an API key, no request yet). */
  allowance: Allowance | null;
}

/** A write to the keys' answer: the keys after it. */
export interface KeysView {
  keys: KeyView[];
}

/** An owner's secret as the web UI shows it (its value too, as the keys'). */
export interface SecretView {
  onlyForCapabilities?: string[];
  name: string;
  value: string;
  hosts: string[];
  header: string;
  env: string;
  /** What its pets hold in its place. */
  placeholder: string;
  /** null: every house. */
  houses: string[] | null;
  note: string | null;
}

export interface PetView {
  sideworker?: { parent: string; cwd: string; parentHome?: string; branch?: string };
  cpus?: number;
  memoryMiB?: number;
  enabled?: boolean;
  name: string;
  /** Its name in the chat. */
  title: string;
  /** The config's title, if it sets one (else the title is the name's). */
  ownTitle: string | null;
  /** How people see it named: its emoji and title ("🐾 Sibling"). */
  display: string;
  /** Its mark before its title (the default when the config sets none). */
  emoji: string;
  /** The config's emoji, if it sets one. */
  ownEmoji: string | null;
  aliases: string[];
  /** Its agent, model and permission mode, the defaults resolved (mode null: its agent has none). */
  agent: string;
  model: string;
  /** Null leaves the native model default unchanged. */
  reasoningEffort?: string | null;
  /** Its agent's own settings the config sets (`AgentView.settings` says which exist). */
  settings: Record<string, string>;
  /** Its scheduled restarts, as configured; null when it has none. */
  lifecycle?: PetLifecycle | null;
  mode: string | null;
  /** The key it names (`pets.<p>.key`); null when it names none (a problem). */
  key: string | null;
  /** What is wrong with its agent, model or key; null when nothing is. */
  problem: string | null;
  /** Docker's state word for its container, or `missing`. */
  state: string;
}

/** A host the house's pets reach: `host` (port 443) or `host:port`. */
export interface AllowView {
  host: string;
  /** Reachable because a pet's agent needs it (Household adds it), not from the allowlist: not removable. */
  byAgent: boolean;
  /** Reachable because this secret of the house's names it (Household adds it): not removable here. */
  bySecret?: string;
  /** Approved for good from a pet's request in chat (`network.granted`): reaches public addresses only. */
  granted?: boolean;
}

/** A chat the house is in, as the config lists it. */
export interface ChannelView {
  kind: string;
  /** Its kind's platform (its icon is the platform's). */
  platform: string;
  /** Its kind's label («Telegram Bot DM (threaded)»). */
  label: string;
  /** The config's name, or its kind's. */
  name: string;
  /** The config's name, if it sets one. */
  ownName: string | null;
  /** The owner's note on it (for them only: never told to a pet). */
  note: string | null;
  /** Its kind's own fields, by key, in the kind's order (its bot token too: the owner's own screen). */
  fields: Record<string, string>;
  /** How its fields that say what they are show (the bot token: its bot's @username), by key; null when not such a value. */
  shown: Record<string, string | null>;
  /** Its chat (its kind's `chat` field): what names it, the API's id for it. */
  chat: string;
  /** Names of the pets placed in it. */
  pets: string[];
  /** The pet that gets what is addressed to none; none for a channel without pets. */
  default: string | null;
  /** Why it is not open (its token not a bot's, …); null when it is. */
  problem: string | null;
}

export interface HouseView {
  features?: HouseFeatures;
  preview?: PreviewSettings;
  sideworkerLimits?: SideworkerLimits;
  sideworkerProfiles?: SideworkerProfile[];
  name: string;
  /** The allowlist, then the hosts its pets' agents add. */
  allow: AllowView[];
  /** Owner-approved short grants, separate from permanent config entries. */
  temporary?: TemporaryGrant[];
  /** The house's owners, each on a platform. */
  owners: OwnerView[];
  channels: ChannelView[];
  pets: PetView[];
}

/** A write's answer: the house after it (not for a delete). */
export interface WriteView {
  house?: HouseView;
}
