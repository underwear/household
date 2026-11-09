import { houseInboxSchema, type HouseInbox } from "../core/house-inboxes";
import type { CapabilityDefinition, ScoutAgent, ScoutDefinition, ScoutLimits } from "../core/scouts";
import { CAPABILITY_TEMPLATES, GENERAL_SCOUT } from "../builtin-capabilities";
import { houseFeatureSettingsSchema, type HouseFeatures, type PreviewSettings } from "../core/house-features";
import { DEFAULT_WORKSPACE_RESOURCES, workspaceBudget, workspaceResourcesSchema, type ResourceAllocation, type PetResources, sideworkerLimitsSchema } from "../core/resources";
import type { SideworkerLimits, SideworkerProfile } from "../core/household";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isMap, isNode, isScalar, isSeq, Pair, parseDocument, Scalar, type Document } from "yaml";
import { normalLifecycle, type PetLifecycle } from "../core/lifecycle";
import { emojiOf } from "../core/emoji";
import { HouseholdError } from "../core/errors";
import { joining, PLATFORMS, type ChannelConfig } from "../core/channels";
import { assertCanAddPet, assertCanCreateHouse, findHouse, sameOwner, type House, type Household, type Owner } from "../core/household";
import { PROVIDERS, type Provider } from "../core/keys";
import { assertName } from "../core/names";
import { DEFAULT_SECRET_HEADER } from "../core/secrets";
import { allowEntryError, formatAllowEntry, parseAllowEntry, parseEndpoint, sameEndpoint, type AllowEntry } from "../core/network-policy";
import { ownerIdOf, parseHousehold, sideworkerProfilesSchema, scoutDefinitionSchema, scoutLimitsSchema, scoutAgentSchema, capabilityDefinitionSchema } from "./config-schema";
import { withFileLock } from "./file-lock";
import { CONFIG_MIGRATIONS, CONFIG_VERSION, type ConfigMigration } from "./config-migrations";
import { configVersionOf, setConfigVersion, setIn } from "./yaml-doc";

/** An edit named something the config does not have: a house, a pet, a channel. */
export class NotFoundError extends HouseholdError {}
export class ScoutRevisionError extends HouseholdError {}

/** A pet's settings as an edit gives them: a field left out stays as it is; null, "" or no aliases removes it. */
export interface PetFields {
  cpus?: number | null;
  memoryMiB?: number | null;
  enabled?: boolean;
  environment?: PetEnvironmentFields | null;
  /** Its scheduled restarts; null removes them. */
  lifecycle?: PetLifecycle | null;
  title?: string | null;
  emoji?: string | null;
  aliases?: string[] | null;
  agent?: string | null;
  model?: string | null;
  /** Explicit reasoning effort; null restores the native default. */
  reasoningEffort?: string | null;
  /** Its permission mode (one of its agent's). */
  mode?: string | null;
  /** Its agent's own settings: a key left out stays as it is; null or "" removes one; null for the whole map removes them all. */
  settings?: Record<string, string | null> | null;
  /** The key it runs on (by name): every pet names one. */
  key?: string | null;
}

/** Omitted setup stays as it is; null or an empty string removes it. Script whitespace is significant. */
export interface PetEnvironmentFields {
  setup?: string | null;
  onStart?: string | null;
}

/** A key's settings as an edit gives them: a field left out stays as it is; null or "" removes the note. */
export interface KeyFields {
  provider?: string;
  value?: string;
  note?: string | null;
  /** The houses whose pets may run on it; null or none: every house. */
  houses?: string[] | null;
  /** A subscription's: keep sending past its allowance (billed apart); false or null: refuse (the default). */
  allowOverage?: boolean | null;
}

/** An owner's secret as a form or the CLI gives it (core/secrets.ts); null removes an optional field. */
export interface SecretFields {
  onlyForCapabilities?: string[] | null;
  value?: string;
  hosts?: string[];
  header?: string | null;
  env?: string;
  note?: string | null;
}

/** Another channel of the house changed in the same edit (its bot's new token, say). */
export interface AlsoChannel {
  chat: string;
  fields: ChannelFields;
}

/**
 * A channel's settings as an edit gives them: a field left out stays as it is; null or "" removes `name` or
 * `default`. Its chat is what names it: a channel of another chat is another channel (removed, then added).
 */
export interface ChannelFields {
  name?: string | null;
  pets?: string[];
  default?: string | null;
  /** Its kind's own fields (Telegram's `bot`, `chat`): strings, checked by the config's rules. */
  [own: string]: string | string[] | null | undefined;
}

/**
 * household.yaml is the source of truth; the CLI and the daemon's web UI are its editors.
 * Edits go through the yaml Document API so hand-written comments and ordering survive, one at a time
 * (a lock file next to the config), so two editors never lose each other's change. Each edit resolves to the
 * household it wrote, written whole (a temp file renamed over it), so a reader never sees half of it. `check`
 * finds what the schema cannot tell (the app's: a pet's agent or model unknown), one line each: an edit that adds
 * such a problem is not written; one already there (typed in by hand) does not stop loading or other edits, so
 * the web UI still shows the house and can fix it (the daemon's reload refuses it).
 */
export class ConfigStore {
  resourceAllocations?: (house: string) => ResourceAllocation[];

  constructor(
    private readonly path: string,
    private readonly check: (household: Household) => string[] = () => [],
  ) {}

  /** The config, read under the lock: never an edit half done. */
  async load(): Promise<Household> {
    if (!existsSync(dirname(this.path))) return (await this.read()).household;
    return withFileLock(this.path, async () => (await this.read()).household);
  }

  async putInbox(house: string, input: HouseInbox, create = false): Promise<Household> {
    const inbox = houseInboxSchema.parse(input);
    return this.edit((doc, household) => {
      const h = knownHouse(household, house);
      const current = h.inboxes ?? [];
      const exists = current.some(item => item.name === inbox.name);
      if (create && exists) throw new HouseholdError("An inbox with this name already exists");
      if (!create && !exists) throw new NotFoundError("Inbox not found");
      const channel = h.channels.find(c => c.chat === inbox.channel);
      if (!channel) throw new HouseholdError("Choose a channel in this workspace");
      if (inbox.pets.some(name => !h.pets.some(p => p.name === name && !p.scout && !p.sideworker) || !channel.pets.includes(name))) throw new HouseholdError("Subscribers must be bots placed in the selected channel");
      setIn(doc, ["houses", house, "inboxes"], doc.createNode(exists ? current.map(i => i.name === inbox.name ? inbox : i) : [...current, inbox]));
    });
  }

  /** One pet's subscription to an inbox, from its own page: subscribed or not, and quiet (history only) or woken. */
  async setInboxSubscriber(house: string, name: string, pet: string, { subscribed, quiet }: { subscribed: boolean; quiet: boolean }): Promise<Household> {
    return this.edit((doc, household) => {
      const h = knownHouse(household, house);
      const current = h.inboxes ?? [];
      const inbox = current.find(i => i.name === name);
      if (!inbox) throw new NotFoundError("Inbox not found");
      const others = inbox.pets.filter(p => p !== pet);
      const pets = subscribed ? (inbox.pets.includes(pet) ? inbox.pets : [...others, pet]) : others;
      const next = { ...inbox, pets, quiet: (inbox.quiet ?? []).filter(p => p !== pet).concat(subscribed && quiet ? [pet] : []) };
      if (subscribed && !inbox.pets.includes(pet)) {
        const channel = h.channels.find(c => c.chat === inbox.channel);
        if (!h.pets.some(p => p.name === pet && !p.scout && !p.sideworker) || !channel?.pets.includes(pet)) throw new HouseholdError("Place the bot in the inbox's channel first");
      }
      const parsed = houseInboxSchema.safeParse(next);
      if (!parsed.success) throw new HouseholdError(parsed.error.issues[0]?.message ?? "Invalid inbox");
      setIn(doc, ["houses", house, "inboxes"], doc.createNode(current.map(i => i.name === name ? parsed.data : i)));
    });
  }

  async removeInbox(house: string, name: string): Promise<Household> {
    return this.edit((doc, household) => {
      const current = knownHouse(household, house).inboxes ?? [];
      if (!current.some(i => i.name === name)) throw new NotFoundError("Inbox not found");
      setIn(doc, ["houses", house, "inboxes"], doc.createNode(current.filter(i => i.name !== name)));
    });
  }

  async setTimezone(timezone: string): Promise<Household> {
    return this.edit((doc) => { setIn(doc, ["timezone"], doc.createNode(timezone)); });
  }

  async setHouseFeatures(name: string, settings: { features: Partial<HouseFeatures>; preview: PreviewSettings }): Promise<Household> {
    const value = houseFeatureSettingsSchema.parse(settings);
    return this.edit((doc, household) => {
      const house = knownHouse(household, name);
      setIn(doc, ["houses", name, "features"], doc.createNode(value.features));
      setIn(doc, ["houses", name, "preview"], doc.createNode(value.preview));
      // Scouts turned on for the first time: the open tools and the General scout made of them, on a pet's agent.
      if (value.features.scouts && !house.capabilities?.length && !house.scouts?.length) {
        const tools = CAPABILITY_TEMPLATES.filter(template => GENERAL_SCOUT.capabilities.includes(template.name));
        setIn(doc, ["houses", name, "capabilities"], doc.createNode(tools.map(({ label: _label, ...template }) => capabilityDefinitionInput({ ...template, keys: [] }))));
        setIn(doc, ["houses", name, "scouts"], doc.createNode([scoutDefinitionInput({ ...GENERAL_SCOUT, capabilities: tools.map(tool => tool.name) })]));
        const pet = house.pets.find(each => each.agent && each.key);
        // The house's scout agent starts as a pet's: the owner changes it in Scouts → Settings.
        if (pet && !house.scoutAgent) setIn(doc, ["houses", name, "scoutAgent"], doc.createNode({ agent: pet.agent, key: pet.key, ...(pet.model ? { model: pet.model } : {}) }));
      }
    });
  }

  async setWorkspaceResources(name: string, resources: PetResources): Promise<Household> {
    const value = workspaceResourcesSchema.parse(resources);
    return this.edit((doc, household) => {
      knownHouse(household, name);
      setIn(doc, ["houses", name, "resources"], doc.createNode(value));
    });
  }

  async setSideworkerLimits(name: string, limits: SideworkerLimits): Promise<Household> {
    const value = sideworkerLimitsSchema.parse(limits);
    return this.edit((doc, household) => {
      knownHouse(household, name);
      setIn(doc, ["houses", name, "sideworkerLimits"], doc.createNode(value));
    });
  }

  async setSideworkerProfiles(name: string, profiles: SideworkerProfile[]): Promise<Household> {
    const value = sideworkerProfilesSchema.parse(profiles);
    return this.edit((doc, household) => {
      knownHouse(household, name);
      setIn(doc, ["houses", name, "sideworkerProfiles"], doc.createNode(value));
    });
  }

  /** The agent every scout of the house runs on (a pet's key it may use is checked when the config loads). */
  async setScoutAgent(house: string, agent: ScoutAgent): Promise<Household> {
    const value = scoutAgentSchema.parse(agent);
    return this.edit((doc, household) => {
      knownHouse(household, house);
      setIn(doc, ["houses", house, "scoutAgent"], doc.createNode(value));
    });
  }

  async setScoutLimits(house: string, limits: Partial<ScoutLimits>): Promise<Household> {
    const value = scoutLimitsSchema.parse(limits);
    return this.edit((doc, household) => {
      knownHouse(household, house);
      setIn(doc, ["houses", house, "scoutLimits"], doc.createNode(value));
    });
  }

  async addScout(house: string, definition: ScoutDefinition): Promise<Household> {
    const raw = scoutDefinitionInput(definition);
    scoutDefinitionSchema.parse(raw);
    return this.edit((doc, household) => {
      if (knownHouse(household, house).scouts?.some(scout => scout.name === definition.name)) throw new HouseholdError(`scout '${definition.name}' already exists`);
      append(doc, ["houses", house, "scouts"], raw);
    });
  }

  /** Full owner-edited definition. Identity is immutable; scripts retain their exact whitespace. */
  async updateScout(house: string, name: string, definition: ScoutDefinition): Promise<Household> {
    if (definition.name !== name) throw new HouseholdError("A scout's name cannot be changed");
    const raw = scoutDefinitionInput(definition);
    scoutDefinitionSchema.parse(raw);
    return this.edit((doc, household) => {
      const index = knownHouse(household, house).scouts?.findIndex(scout => scout.name === name) ?? -1;
      if (index < 0) throw new NotFoundError(`unknown scout '${house}/${name}'`);
      doc.setIn(["houses", house, "scouts", index], doc.createNode(raw));
    });
  }

  async updateScoutDocument(house: string, name: string, kind: "instructions", content: string, revision: string): Promise<Household> {
    return this.edit((doc, household) => {
      const scouts = knownHouse(household, house).scouts ?? [];
      const index = scouts.findIndex(scout => scout.name === name);
      if (index < 0) throw new NotFoundError(`unknown scout '${house}/${name}'`);
      if (createHash("sha256").update(scouts[index]![kind]).digest("hex") !== revision) throw new ScoutRevisionError("This document changed. Reload it before saving.");
      doc.setIn(["houses", house, "scouts", index, kind], doc.createNode(content));
    });
  }

  async addCapability(house: string, definition: CapabilityDefinition): Promise<Household> {
    const raw = capabilityDefinitionInput(definition);
    capabilityDefinitionSchema.parse(raw);
    return this.edit((doc, household) => {
      if (knownHouse(household, house).capabilities?.some(capability => capability.name === definition.name)) throw new HouseholdError(`capability '${definition.name}' already exists`);
      append(doc, ["houses", house, "capabilities"], raw);
    });
  }

  /** The whole definition (its name never changes); the caller keeps the revision history. */
  async updateCapability(house: string, name: string, definition: CapabilityDefinition): Promise<Household> {
    if (definition.name !== name) throw new HouseholdError("A capability's name cannot be changed");
    const raw = capabilityDefinitionInput(definition);
    capabilityDefinitionSchema.parse(raw);
    return this.edit((doc, household) => {
      const index = knownHouse(household, house).capabilities?.findIndex(capability => capability.name === name) ?? -1;
      if (index < 0) throw new NotFoundError(`unknown capability '${house}/${name}'`);
      doc.setIn(["houses", house, "capabilities", index], doc.createNode(raw));
    });
  }

  /** Refused while a scout uses it. Its keys keep their restriction: they never become the pets'. */
  async removeCapability(house: string, name: string): Promise<Household> {
    return this.edit((doc, household) => {
      const found = knownHouse(household, house);
      const index = found.capabilities?.findIndex(capability => capability.name === name) ?? -1;
      if (index < 0) throw new NotFoundError(`unknown capability '${house}/${name}'`);
      const users = (found.scouts ?? []).filter(scout => scout.capabilities.includes(name)).map(scout => scout.name);
      if (users.length) throw new HouseholdError(`capability '${name}' is used by ${users.join(", ")}`);
      doc.deleteIn(["houses", house, "capabilities", index]);
    });
  }

  async removeScout(house: string, name: string): Promise<Household> {
    return this.edit((doc, household) => {
      const index = knownHouse(household, house).scouts?.findIndex(scout => scout.name === name) ?? -1;
      if (index < 0) throw new NotFoundError(`unknown scout '${house}/${name}'`);
      doc.deleteIn(["houses", house, "scouts", index]);
      // Keep any secret restriction: deleting a scout must never expose its keys to pets.
    });
  }

  async createHouse(name: string): Promise<Household> {
    return this.edit((doc, household) => {
      assertCanCreateHouse(household, name);
      // Nothing beyond what its pets' agents need (the app adds those hosts); the owner extends `allow`.
      setIn(doc, ["houses", name], doc.createNode({ resources: DEFAULT_WORKSPACE_RESOURCES, network: { allow: [] } }));
    });
  }

  /** Removes the house with its pets from the config (their containers go on the next reload). */
  async deleteHouse(name: string): Promise<Household> {
    return this.edit((doc, household) => {
      knownHouse(household, name);
      doc.deleteIn(["houses", name]);
    });
  }

  /** Adds a key the pets may run on (`keys.<name>`, before the houses); its value is written as given (trimmed). */
  async addKey(name: string, { provider, value, note, houses, allowOverage }: KeyFields): Promise<Household> {
    return this.edit((doc, household) => {
      assertName("key", name);
      if (household.keys.some((key) => key.name === name)) throw new HouseholdError(`key '${name}' already exists`);
      if (!provider || !value?.trim()) throw new HouseholdError("a key needs a provider and a value");
      keysFirst(doc);
      setIn(doc, ["keys", name], doc.createNode({ provider: providerOf(provider), value: value.trim() }));
      setFields(doc, ["keys", name], { note, houses: housesOf(household, houses), allowOverage: allowOverage || null });
    });
  }

  /** Changes a key's provider, value or note (the pets on it run on the new value from their next request). */
  async updateKey(name: string, { provider, value, note, houses, allowOverage }: KeyFields): Promise<Household> {
    return this.edit((doc, household) => {
      knownKey(household, name);
      if (value !== undefined && !value.trim()) throw new HouseholdError("a key's value cannot be empty: remove the key instead");
      // Off is the default: written only when on.
      setFields(doc, ["keys", name], { provider: provider === undefined ? undefined : providerOf(provider), value, note, houses: housesOf(household, houses), allowOverage: allowOverage === undefined ? undefined : allowOverage || null });
    });
  }

  /** Adds an owner's secret (`houses.<house>.secrets.<name>`); its pets get its placeholder from their next VM. */
  async addSecret(houseName: string, name: string, fields: SecretFields): Promise<Household> {
    return this.edit((doc, household) => {
      assertName("secret", name);
      if ((knownHouse(household, houseName).secrets ?? []).some((secret) => secret.name === name)) throw new HouseholdError(`secret '${name}' already exists`);
      if (!fields.value?.trim() || !fields.hosts?.length || !fields.env) throw new HouseholdError("a secret needs a value, at least one host and a variable");
      setIn(doc, ["houses", houseName, "secrets", name], doc.createNode({ value: fields.value.trim(), hosts: fields.hosts.map((host) => host.trim()), env: fields.env.trim() }));
      setFields(doc, ["houses", houseName, "secrets", name], { header: fields.header?.trim().toLowerCase() === DEFAULT_SECRET_HEADER ? null : fields.header, note: fields.note, onlyForCapabilities: fields.onlyForCapabilities });
    });
  }

  /** Changes a secret; a new value reaches the gateway at once, a new variable on the pets' next VM. */
  async updateSecret(houseName: string, name: string, fields: SecretFields): Promise<Household> {
    return this.edit((doc, household) => {
      if (!(knownHouse(household, houseName).secrets ?? []).some((secret) => secret.name === name)) throw new NotFoundError(`unknown secret '${name}'`);
      if (fields.value !== undefined && !fields.value.trim()) throw new HouseholdError("a secret's value cannot be empty: remove the secret instead");
      if (fields.hosts !== undefined && fields.hosts.length === 0) throw new HouseholdError("a secret needs at least one host");
      setFields(doc, ["houses", houseName, "secrets", name], {
        value: fields.value?.trim(),
        hosts: fields.hosts?.map((host) => host.trim()),
        env: fields.env?.trim(),
        header: fields.header === undefined ? undefined : fields.header?.trim().toLowerCase() === DEFAULT_SECRET_HEADER ? null : fields.header,
        note: fields.note,
        onlyForCapabilities: fields.onlyForCapabilities,
      });
    });
  }

  async removeSecret(houseName: string, name: string): Promise<Household> {
    return this.edit((doc, household) => {
      if (!(knownHouse(household, houseName).secrets ?? []).some((secret) => secret.name === name)) throw new NotFoundError(`unknown secret '${name}'`);
      const users = [knownHouse(household, houseName)].flatMap(house => (house.capabilities ?? []).filter(capability => capability.keys.some(key => key.secret === name)).map(capability => `${house.name}/${capability.name}`));
      if (users.length) throw new HouseholdError(`secret '${name}' is in use by ${users.join(", ")}`);
      doc.deleteIn(["houses", houseName, "secrets", name]);
    });
  }

  /** Removes a key; refused while a pet names it (every pet names its key). */
  async removeKey(name: string): Promise<Household> {
    return this.edit((doc, household) => {
      knownKey(household, name);
      const users = household.houses.flatMap((house) => [
        ...(house.scoutAgent?.key === name ? [`${house.name}/scouts`] : []),
        ...(house.scouts ?? []).filter(scout => scout.agent?.key === name).map(scout => `${house.name}/scout:${scout.name}`),
        ...house.pets.filter((pet) => pet.key === name).map((pet) => `${house.name}/${pet.name}`),
        ...(house.sideworkerProfiles ?? []).filter(profile => profile.key === name).map(profile => `${house.name}/sideworker-profile:${profile.name}`),
      ]);
      if (users.length > 0) throw new HouseholdError(`key '${name}' is in use by ${users.join(", ")}: give ${users.length > 1 ? "them" : "it"} another key first`);
      doc.deleteIn(["keys", name]);
    });
  }

  /**
   * Adds a pet; only the fields given are written. It joins the house's channels of `chats` in the same edit (each
   * keeps its default: core's `joining`), so the reload that starts it already has it in them; else it is in none.
   */
  async addPet(house: string, pet: string, fields: PetFields = {}, chats: string[] = []): Promise<Household> {
    return this.edit((doc, household) => {
      assertCanAddPet(household, house, pet);
      setIn(doc, ["houses", house, "pets", pet], doc.createNode({}));
      const { enabled, cpus, memoryMiB, environment, lifecycle, agent, model, reasoningEffort, mode, settings, key, title, emoji, aliases } = petFields(fields);
      setFields(doc, ["houses", house, "pets", pet], { enabled, cpus, memoryMiB, agent, model, reasoningEffort, mode, key, title, emoji, aliases });
      setPetSettings(doc, ["houses", house, "pets", pet], settings);
      setPetLifecycle(doc, ["houses", house, "pets", pet], lifecycle);
      setPetEnvironment(doc, ["houses", house, "pets", pet], environment);
      for (const chat of chats) {
        const index = channelIndex(household, house, chat);
        setFields(doc, ["houses", house, "channels", index], joining(knownHouse(household, house).channels[index]!, pet));
      }
    });
  }

  /** Changes a pet's settings (on reload, another agent recreates its VM; model, reasoning effort or mode restart it). */
  async updatePet(house: string, pet: string, fields: PetFields): Promise<Household> {
    return this.edit((doc, household) => {
      knownPet(household, house, pet);
      const path = ["houses", house, "pets", pet];
      const node = doc.getIn(path, true);
      if (!isMap(node)) {
        // `sibling:` (null) becomes a map; a comment it had goes on top of it.
        const map = doc.createNode({});
        map.commentBefore = isScalar(node) ? node.comment : undefined;
        doc.setIn(path, map);
      }
      const { environment, lifecycle, settings, ...plain } = petFields(fields);
      setFields(doc, path, plain);
      setPetSettings(doc, path, settings);
      setPetEnvironment(doc, path, environment);
      setPetLifecycle(doc, path, lifecycle);
    });
  }

  /** Saves setup only. Applying it is a separate runtime operation; saving never executes shell code. */
  async updatePetEnvironment(house: string, pet: string, fields: PetEnvironmentFields): Promise<Household> {
    return this.updatePet(house, pet, { environment: fields });
  }

  /**
   * Removes a pet from the house and from every channel it is placed in (and as its default). Refused when it is
   * the default of a channel that keeps two pets or more: which one is the default then is the owner's choice.
   */
  async removePet(house: string, pet: string): Promise<Household> {
    return this.edit((doc, household) => {
      const { channels } = knownPet(household, house, pet);
      channels.forEach((channel, index) => {
        if (!channel.pets.includes(pet)) return;
        const path = ["houses", house, "channels", index];
        if (channel.default === pet) {
          if (channel.pets.length > 2) {
            throw new HouseholdError(`${pet} is the default of channel ${channel.name ?? channel.kind} (chat ${channel.chat}), which has other bots: make another one its default first`);
          }
          doc.deleteIn([...path, "default"]);
        }
        removeItems(doc, [...path, "pets"], (item) => item === pet);
      });
      doc.deleteIn(["houses", house, "pets", pet]);
    });
  }

  /**
   * Adds a channel at the end of the house's list (and changes the house's channels `also` names, in the same
   * edit); the config's rules check it (core/channels.ts).
   */
  async addChannel(house: string, { kind, name, pets, default: first, ...own }: ChannelFields & { kind: string }, also: AlsoChannel[] = [], newOwner?: { platform: string; id: string }): Promise<Household> {
    return this.edit((doc, household) => {
      if (newOwner) {
        const owner = ownerOf(newOwner.platform, newOwner.id);
        if (!knownHouse(household, house).people.owners.some(other => sameOwner(other, owner))) {
          const path = ["houses", house, "people", "owners", owner.platform];
          ownerList(doc, path);
          append(doc, path, ownerItem(owner.id));
        }
      }
      const { channels } = knownHouse(household, house);
      for (const other of also) setFields(doc, ["houses", house, "channels", channelIndex(household, house, other.chat)], other.fields);
      append(doc, ["houses", house, "channels"], { kind });
      // Its chat as Telegram has it: a number (YAML's), when it is one.
      const fields = Object.fromEntries(Object.entries(own).map(([key, value]) => [key, key === "chat" && typeof value === "string" ? idValue(value.trim()) : value]));
      setFields(doc, ["houses", house, "channels", channels.length], { name, ...fields, pets, default: first });
    });
  }

  /** Changes the house's channel of chat `chat` (not its chat), and those `also` names; the config's rules check the result. */
  async updateChannel(house: string, chat: string, fields: ChannelFields, also: AlsoChannel[] = []): Promise<Household> {
    return this.edit((doc, household) => {
      for (const each of [{ chat, fields }, ...also]) setFields(doc, ["houses", house, "channels", channelIndex(household, house, each.chat)], each.fields);
    });
  }

  /** Removes the house's channel of chat `chat`. Resolves to the household written and the channel removed. */
  async removeChannel(house: string, chat: string): Promise<{ household: Household; removed: ChannelConfig }> {
    let removed: ChannelConfig | undefined;
    const household = await this.edit((doc, read) => {
      const index = channelIndex(read, house, chat);
      removed = knownHouse(read, house).channels[index];
      doc.deleteIn(["houses", house, "channels", index]);
    });
    return { household, removed: removed! };
  }

  /**
   * Adds an owner of the house on a platform, by the id it knows them by (to `owners.<platform>`); one it has
   * already keeps its place, and a note given becomes its note. Whether the id is one of the platform's is the app's check.
   */
  async addOwner(house: string, platform: string, id: string, note?: string | null): Promise<Household> {
    const owner = ownerOf(platform, id);
    return this.edit((doc, household) => {
      const path = ["houses", house, "people", "owners", owner.platform];
      if (knownHouse(household, house).people.owners.some((other) => sameOwner(other, owner))) {
        if (note?.trim()) setOwnerNote(doc, path, owner, note, house);
        return;
      }
      ownerList(doc, path);
      append(doc, path, ownerItem(owner.id, note));
    });
  }

  /**
   * Sets or (null, "") removes the note of an owner of the house: one written `{id, note}` keeps its other keys'
   * comments; a bare id becomes `{id, note}` only when a note is set.
   */
  async updateOwner(house: string, platform: string, id: string, note: string | null): Promise<Household> {
    const owner = ownerOf(platform, id);
    return this.edit((doc, household) => {
      knownHouse(household, house);
      setOwnerNote(doc, ["houses", house, "people", "owners", owner.platform], owner, note, house);
    });
  }

  /** Removes an owner of the house on a platform (its id read as the schema reads it); one it lacks: nothing. */
  async removeOwner(house: string, platform: string, id: string): Promise<Household> {
    const owner = ownerOf(platform, id);
    return this.edit((doc, household) => {
      knownHouse(household, house);
      const path = ["houses", house, "people", "owners", owner.platform];
      ownerList(doc, path);
      removeItems(doc, path, (item) => itemOwnerId(item) === owner.id);
    });
  }

  /**
   * Adds an allowlist entry (`host`, `host:port`, a wildcard) at the end of the house's allowlist, written as
   * `entry` says it (the one spelling the CLI and the web UI echo); one it has stays as it is (`changed` false).
   * A grant of the same endpoint (`grantHost`) becomes the owner's own entry: it may then reach a private address.
   */
  async allowHost(house: string, host: string): Promise<AllowlistEdit> {
    const { text, endpoint } = allowEntry(host);
    let changed = false;
    const household = await this.edit((doc, household) => {
      if (ownEntries(knownHouse(household, house)).some((entry) => sameEndpoint(entry, endpoint))) return;
      changed = true;
      dropEndpoint(doc, networkList(house, "granted"), endpoint);
      appendItem(doc, networkList(house, "allow"), text);
    });
    return { household, entry: text, changed };
  }

  /** Adds a previewed set in one locked write; invalid entries leave the entire set unchanged. */
  async allowHosts(house: string, hosts: readonly string[]): Promise<{ household: Household; added: string[] }> {
    const entries = hosts.map(allowEntry); // validate the entire batch before editing
    const added: string[] = [];
    const household = await this.edit((doc, household) => {
      const existing = ownEntries(knownHouse(household, house));
      for (const { text, endpoint } of entries) {
        if (existing.some((entry) => sameEndpoint(entry, endpoint))) continue;
        dropEndpoint(doc, networkList(house, "granted"), endpoint);
        appendItem(doc, networkList(house, "allow"), text);
        existing.push(endpoint);
        added.push(text);
      }
    });
    return { household, added };
  }

  /**
   * Records what the owner approved for good from a pet's request in chat, under the house's `network.granted`:
   * unlike `allow`, which the owner writes on purpose, it reaches public addresses only, wherever its name leads
   * later. One exact `host` or `host:port`; an endpoint the house already lists stays as it is.
   */
  async grantHost(house: string, host: string): Promise<AllowlistEdit> {
    const endpoint = parseEndpoint(host.trim());
    if (!endpoint) throw new HouseholdError(`'${host}' is not host or host:port: a grant names one exact host`);
    const text = formatAllowEntry(endpoint);
    let changed = false;
    const household = await this.edit((doc, household) => {
      if (knownHouse(household, house).network.allow.some((entry) => sameEndpoint(entry, endpoint))) return;
      changed = true;
      appendItem(doc, networkList(house, "granted"), text);
    });
    return { household, entry: text, changed };
  }

  /** Removes the entry from the house's allowlist and its grants (the other entries keep their comments); one it lacks: `changed` false. */
  async disallowHost(house: string, host: string): Promise<AllowlistEdit> {
    const { text, endpoint } = allowEntry(host);
    let changed = false;
    const household = await this.edit((doc, household) => {
      knownHouse(household, house);
      for (const list of ["allow", "granted"] as const) if (dropEndpoint(doc, networkList(house, list), endpoint)) changed = true;
    });
    return { household, entry: text, changed };
  }

  private async read(): Promise<{ doc: Document; household: Household }> {
    const file = Bun.file(this.path);
    const doc = parseDocument((await file.exists()) ? await file.text() : "");
    // Its first line only: the rest quotes the file, and the file holds tokens and keys.
    if (doc.errors.length > 0) throw new HouseholdError(`invalid YAML in ${this.path}: ${doc.errors[0]!.message.split("\n")[0]}${wildcardHint(doc.errors[0]!.message)}`);
    const version = configVersionOf(doc);
    if (version > CONFIG_VERSION) throw new HouseholdError(`${this.path} is from a newer Household (config version ${version}, this one knows up to ${CONFIG_VERSION}): update Household, or restore the backup taken before it migrated (house migrate backups)`);
    return { doc, household: parseHousehold(plainOf(doc, this.path), this.path) };
  }

  /** The config's version: the last config migration it has had (0: none yet, or no config at all). */
  async version(): Promise<number> {
    if (!existsSync(this.path)) return CONFIG_VERSION; // nothing to migrate: a new one is written at the latest
    return configVersionOf((await withFileLock(this.path, () => this.read())).doc);
  }

  /**
   * Runs one config migration and records it as the config's version, unless the config has had it: the document as
   * it rewrites it must still be a valid config. Resolves to whether it ran.
   */
  async applyMigration(migration: ConfigMigration): Promise<boolean> {
    if (!existsSync(this.path)) return false;
    return withFileLock(this.path, async () => {
      const { doc } = await this.read();
      if (configVersionOf(doc) >= migration.id) return false;
      migration.change(doc);
      setConfigVersion(doc, migration.id);
      parseHousehold(doc.toJS(), this.path);
      await writeWhole(this.path, doc.toString());
      return true;
    });
  }

  /** Runs the config migrations it has not had, in order (the daemon runs them with the state's: app/migrations.ts). */
  async migrate(): Promise<ConfigMigration[]> {
    const ran: ConfigMigration[] = [];
    for (const migration of CONFIG_MIGRATIONS) if (await this.applyMigration(migration)) ran.push(migration);
    return ran;
  }

  /** Why `after` takes a workspace further over its CPU/RAM budget than `before` was, with the helpers running now. */
  private overBudget(before: Household, after: Household): string | undefined {
    for (const house of after.houses) {
      const allocations = this.resourceAllocations?.(house.name);
      const previous = before.houses.find(h => h.name === house.name);
      const was = previous && workspaceBudget(previous, allocations), budget = workspaceBudget(house, allocations);
      for (const key of ["cpus", "memoryMiB"] as const) {
        const excess = budget.reserved[key] + budget.helpers[key] - budget.total[key];
        const oldExcess = was ? was.reserved[key] + was.helpers[key] - was.total[key] : 0;
        if (excess > Math.max(0, oldExcess)) return `Workspace '${house.name}' has allocated ${budget.reserved[key] + budget.helpers[key]} ${key}; close helpers or increase the budget before changing reservations.`;
      }
    }
    return undefined;
  }

  private async edit(change: (doc: Document, household: Household) => void): Promise<Household> {
    await mkdir(dirname(this.path), { recursive: true });
    const fresh = !existsSync(this.path);
    return withFileLock(this.path, async () => {
      const { doc, household } = await this.read();
      if (doc.hasIn(["secrets"])) throw new HouseholdError("Legacy secrets need migration before editing: run house migrate apply, or start Household to migrate with a backup");
      if (fresh) setConfigVersion(doc, CONFIG_VERSION); // a new config is written at the latest: nothing to migrate
      const before = new Set(this.check(household));
      change(doc, household);
      const written = parseHousehold(doc.toJS(), this.path); // an edit that breaks the config is not written
      if (configVersionOf(doc) < 4 && written.houses.some(house => house.secrets?.length)) throw new HouseholdError("Workspace secrets need config migration first: run house migrate apply, or start Household to migrate with a backup");
      const problem = this.overBudget(household, written);
      if (problem) throw new HouseholdError(problem);
      const added = this.check(written).filter((problem) => !before.has(problem));
      if (added.length > 0) throw new HouseholdError(added.join("\n"));
      const previousText = existsSync(this.path) ? await Bun.file(this.path).text() : undefined;
      await writeWhole(this.path, doc.toString());
      // A helper admitted against the old file while this one was written: the check above could not see it. Put the
      // old file back rather than leave the workspace over its budget.
      const late = this.overBudget(household, written);
      if (late) {
        if (previousText !== undefined) await writeWhole(this.path, previousText);
        throw new HouseholdError(late);
      }
      return written;
    });
  }
}

function knownHouse(household: Household, name: string): House {
  const house = findHouse(household, name);
  if (!house) throw new NotFoundError(`unknown workspace '${name}'`);
  return house;
}

/**
 * Writes the file whole: a temp file next to the real one (a symlinked config stays a symlink), mode 600 always
 * (it holds the keys and bot tokens), renamed over it, so a reader sees the old file or the new one, never half of it.
 */
async function writeWhole(path: string, text: string): Promise<void> {
  const real = await realpath(path).catch(() => path);
  const temp = join(dirname(real), `.${basename(real)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await chmod(temp, 0o600); // past the umask
    await rename(temp, real);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * A pet's fields as written: a title or emoji of only spaces, or no aliases, is none (the key goes); an emoji fully
 * qualified (❤ → ❤️; one that is not an emoji is written as given, and the schema says what is wrong).
 */
function petFields(fields: PetFields): PetFields {
  const cleared = (text: string | null | undefined) => (typeof text === "string" ? text.trim() || null : text);
  const emoji = cleared(fields.emoji);
  return {
    ...fields,
    ...("title" in fields ? { title: cleared(fields.title) } : {}),
    ...("emoji" in fields ? { emoji: emoji ? (emojiOf(emoji) ?? emoji) : emoji } : {}),
    ...(fields.aliases?.length === 0 ? { aliases: null } : {}),
  };
}

/**
 * A pet's agent settings as written (`settings:`): null removes the map; else each key given is set, or removed
 * for null or ""; a map left empty goes. Which keys and values are right the agents say (the config check).
 */
function setPetSettings(doc: Document, path: (string | number)[], settings: PetFields["settings"]): void {
  if (settings === undefined) return;
  if (settings === null) return void doc.deleteIn([...path, "settings"]);
  if (!isMap(doc.getIn([...path, "settings"], true))) doc.setIn([...path, "settings"], doc.createNode({}));
  setFields(doc, [...path, "settings"], settings);
  const node = doc.getIn([...path, "settings"], true);
  if (isMap(node) && node.items.length === 0) doc.deleteIn([...path, "settings"]);
}

/** A provider key's houses as written: each one known; null (every house) for none. */
function housesOf(household: Household, houses: string[] | null | undefined): string[] | null | undefined {
  if (houses === undefined || houses === null) return houses;
  const names = [...new Set(houses.map((house) => house.trim()).filter(Boolean))];
  for (const house of names) knownHouse(household, house);
  return names.length > 0 ? names : null;
}

function knownKey(household: Household, name: string): void {
  if (!household.keys.some((key) => key.name === name)) throw new NotFoundError(`unknown key '${name}'`);
}

function providerOf(text: string): Provider {
  const known = PROVIDERS.find((each) => each === text.trim());
  if (!known) throw new HouseholdError(`unknown provider '${text}' (known: ${PROVIDERS.join(", ")})`);
  return known;
}

/** A config without `keys:` gets it on top, so the keys come before the houses that use them. */
function keysFirst(doc: Document): void {
  if (doc.contents === null) doc.contents = doc.createNode({}) as never;
  const top = doc.contents;
  if (!isMap(top) || top.has("keys")) return;
  const key = new Scalar("keys");
  // A comment on top of the file stays on top.
  const first = top.items[0]?.key;
  if (isScalar(first) && first.commentBefore) [key.commentBefore, first.commentBefore] = [first.commentBefore, undefined];
  top.items.unshift(new Pair(key, doc.createNode({})));
}

function knownPet(household: Household, house: string, pet: string): House {
  const found = knownHouse(household, house);
  if (!found.pets.some(({ name }) => name === pet)) throw new NotFoundError(`workspace '${house}' has no bot '${pet}'`);
  return found;
}

/** Where in the house's list its channel of chat `chat` is. */
function channelIndex(household: Household, house: string, chat: string): number {
  const { channels } = knownHouse(household, house);
  const index = channels.findIndex((channel) => channel.chat === chat.trim());
  if (index < 0) throw new NotFoundError(`workspace '${house}' has no channel of chat '${chat}' (its chats: ${channels.map((channel) => channel.chat).join(", ") || "none"})`);
  return index;
}

/**
 * Sets the given fields of the map at `path` (its other keys and comments kept); null or "" removes one. A list
 * that keeps the order of the one there (some items gone, new ones at the end) is changed item by item, so the
 * items that stay keep their comments and style.
 */
function setFields(doc: Document, path: (string | number)[], fields: object): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null || value === "") {
      doc.deleteIn([...path, key]);
      continue;
    }
    const node = doc.getIn([...path, key], true);
    if (Array.isArray(value) && isSeq(node)) {
      const kept = node.items.filter((item) => value.includes(isScalar(item) ? item.value : item));
      const keptValues = kept.map((item) => (isScalar(item) ? item.value : item));
      const added = value.filter((item) => !keptValues.includes(item));
      if (JSON.stringify([...keptValues, ...added]) === JSON.stringify(value)) {
        node.items = [...kept, ...added.map((item) => doc.createNode(item))];
        continue;
      }
    }
    doc.setIn([...path, key], doc.createNode(typeof value === "string" ? value.trim() : value));
  }
}

/** A lifecycle replaces the one written whole (null removes it); a long message is written as a block. */
function setPetLifecycle(doc: Document, path: string[], lifecycle: PetLifecycle | null | undefined): void {
  if (lifecycle === undefined) return;
  const lifecyclePath = [...path, "lifecycle"];
  if (lifecycle === null) {
    doc.deleteIn(lifecyclePath);
    return;
  }
  const node = doc.createNode(normalLifecycle(lifecycle));
  for (const item of isMap(node) ? node.items : []) if (isScalar(item.value) && typeof item.value.value === "string" && item.value.value.includes("\n")) item.value.type = Scalar.BLOCK_LITERAL;
  setIn(doc, lifecyclePath, node);
}

/** Setup is literal shell source: never trim it or interpret it as YAML. */
function setPetEnvironment(doc: Document, path: string[], fields: PetEnvironmentFields | null | undefined): void {
  if (fields === undefined) return;
  const environmentPath = [...path, "environment"];
  if (fields === null) {
    doc.deleteIn(environmentPath);
    return;
  }
  for (const key of ["setup", "onStart"] as const) {
    const script = fields[key];
    if (script === undefined) continue;
    if (script === null || script === "") {
      doc.deleteIn([...environmentPath, key]);
    } else {
      const node = doc.createNode(script);
      if (script.includes("\n")) node.type = Scalar.BLOCK_LITERAL;
      setIn(doc, [...environmentPath, key], node);
    }
  }
  const node = doc.getIn(environmentPath, true);
  if (isMap(node) && node.items.length === 0) doc.deleteIn(environmentPath);
}

/** The document as plain data. */
function plainOf(doc: Document, path: string): unknown {
  try {
    return doc.toJS();
  } catch (error) {
    const message = (error as Error).message;
    throw new HouseholdError(`invalid YAML in ${path}: ${message.split("\n")[0]}${wildcardHint(message)}`);
  }
}

/** An unquoted `*.example.com`, `*` or `*:*` is a YAML alias (of `.example.com`, nothing, `:*`): it says to quote it. */
function wildcardHint(message: string): string {
  const wildcard = /^Alias cannot be an empty string|^Unresolved alias \(.*?\): ?(?:[.:]|$)/m.test(message);
  return wildcard ? ' (a wildcard host is quoted: "*.example.com", "*")' : "";
}

/** Drops the items of the list at `path` (by their value) that `drop` picks; the others keep their comments. */
function removeItems(doc: Document, path: (string | number)[], drop: (value: unknown) => boolean): void {
  const node = doc.getIn(path, true);
  if (isSeq(node)) node.items = node.items.filter((item) => !drop(isScalar(item) ? item.value : item));
}

/** Where a house's allowlist (`allow`, the owner's) or its grants from chat (`granted`) are written. */
const networkList = (house: string, list: "allow" | "granted") => ["houses", house, "network", list];

/** The entries the owner wrote (`allow`), not the grants approved from chat. */
const ownEntries = (house: House): AllowEntry[] => house.network.allow.filter((entry) => entry.reach === undefined);

function appendItem(doc: Document, path: string[], text: string): void {
  const node = doc.getIn(path, true);
  if (isSeq(node)) node.items.push(doc.createNode(text));
  else setIn(doc, path, doc.createNode([text]));
}

/** Drops the list's entries for `endpoint`; whether there were any. */
function dropEndpoint(doc: Document, path: string[], endpoint: AllowEntry): boolean {
  const node = doc.getIn(path, true);
  if (!isSeq(node)) return false;
  const before = node.items.length;
  node.items = node.items.filter((item) => {
    // An alias (`*github`) is the value it stands for.
    const listed = parseAllowEntry(String(isNode(item) ? item.toJS(doc) : item).trim());
    return !listed || !sameEndpoint(listed, endpoint);
  });
  return node.items.length < before;
}

/** What an edit of the allowlist did: the entry as it is written (`formatAllowEntry`), and whether anything changed. */
export interface AllowlistEdit {
  household: Household;
  entry: string;
  changed: boolean;
}

/** An allowlist entry and how it is written; the schema's rule for it. */
function allowEntry(raw: string): { text: string; endpoint: AllowEntry } {
  const endpoint = parseAllowEntry(raw.trim());
  if (!endpoint) throw new HouseholdError(allowEntryError(raw));
  return { text: formatAllowEntry(endpoint), endpoint };
}

function ownerOf(platform: string, raw: string): Owner {
  const id = raw.trim();
  if (!id || id.length > 64) throw new HouseholdError(`'${raw}' is not a person's id (a Telegram user id, …)`);
  const known = PLATFORMS.find((each) => each === platform.trim());
  if (!known) throw new HouseholdError(`unknown platform '${platform}' (known: ${PLATFORMS.join(", ")})`);
  return { platform: known, id };
}

/** An owner's id in the config's list (a bare id, or `{id, note}`), read as the schema reads it. */
function itemOwnerId(item: unknown): string | undefined {
  const value = isMap(item) ? item.get("id") : isScalar(item) ? item.value : item;
  const found = ownerIdOf(value);
  return "id" in found ? found.id : undefined;
}

/** A platform's owners written as one bare item (`telegram: 777`) become a list of it, its comment kept, so it can be edited as one. */
function ownerList(doc: Document, path: string[]): void {
  const node = doc.getIn(path, true);
  if (node === undefined || node === null || isSeq(node) || (isScalar(node) && node.value === null)) return;
  const list = doc.createNode([]);
  list.items.push(node as never);
  doc.setIn(path, list);
}

/** Sets or (null, "") removes an owner's note in place: a map keeps its other keys and comments; a bare id becomes a map only for a note. */
function setOwnerNote(doc: Document, path: string[], owner: Owner, note: string | null, house: string): void {
  ownerList(doc, path);
  const list = doc.getIn(path, true);
  const index = isSeq(list) ? list.items.findIndex((item) => itemOwnerId(item) === owner.id) : -1;
  if (!isSeq(list) || index < 0) throw new NotFoundError(`workspace '${house}' has no owner ${owner.platform} ${owner.id}`);
  const item = list.items[index];
  const said = note?.trim();
  if (isMap(item)) {
    if (said) item.set("note", said);
    else item.delete("note");
    return;
  }
  if (!said) return;
  const before = item as { commentBefore?: string | null; comment?: string | null };
  const next = doc.createNode(ownerItem(owner.id, said)) as typeof before;
  next.commentBefore = before.commentBefore;
  next.comment = before.comment;
  list.items[index] = next as never;
}

/** An owner as the list keeps it: its id bare, or with a note (trimmed; none when empty). */
function ownerItem(id: string, note?: string | null): unknown {
  const said = note?.trim();
  return said ? { id: idValue(id), note: said } : idValue(id);
}

/** An id as YAML keeps it: digits as a number (a Telegram id), anything else as a string. */
const idValue = (id: string): number | string => (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : id);

/** Appends to the list at `path` (comments of the other items kept), making the list if there is none. */
function append(doc: Document, path: string[], value: unknown): void {
  const node = doc.getIn(path, true);
  if (isSeq(node)) node.items.push(doc.createNode(value));
  else setIn(doc, path, doc.createNode([value]));
}

/** The domain network has parsed endpoints; YAML and HTTP inputs use their familiar host:port spelling. */
export function scoutDefinitionInput(scout: ScoutDefinition) {
  return { ...scout };
}

/** The domain network has parsed endpoints; YAML and HTTP inputs use their host:port spelling. */
export function capabilityDefinitionInput(capability: CapabilityDefinition) {
  return { ...capability, network: { any: capability.network.any, allow: capability.network.allow.map(formatAllowEntry) } };
}
