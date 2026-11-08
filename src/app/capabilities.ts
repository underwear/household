import { HouseholdError } from "../core/errors";
import { capabilityKind, type CapabilityDefinition } from "../core/scouts";
import { NAME_PATTERN } from "../core/names";
import { formatAllowEntry, parseAllowEntry } from "../core/network-policy";
import type { PetIdentity } from "../infra/agent-api";
import type { ConfigStore } from "../infra/config-store";
import { NotFoundError } from "../infra/config-store";
import type { McpTool } from "../infra/mcp-server";
import type { KeyValueStore } from "../infra/sqlite-store";

/** Who made a revision: the owner, or a pet whose draft the owner applied. */
export type RevisionAuthor = { kind: "owner" } | { kind: "pet"; pet: string };
export interface CapabilityRevision {
  rev: number;
  at: number;
  author: RevisionAuthor;
  /** What changed, in words: "install, network". */
  summary: string;
  definition: CapabilityDefinition;
  /** A duplicate's first revision: where it was copied from. */
  from?: { capability: string; rev: number };
}
/** A pet's proposal: the definition it would have, and the key variables it needs (names only, never values). */
export interface CapabilityDraft {
  id: string;
  capability: string;
  pet: string;
  at: number;
  definition: CapabilityDefinition;
  needsKeys: string[];
}

const historyKey = (house: string, name: string) => `capabilities.revisions.v1.${house}.${name}`;
const draftsKey = (house: string) => `capabilities.drafts.v1.${house}`;
const FIELDS: (keyof CapabilityDefinition)[] = ["description", "install", "network", "keys"];

/** The fields that differ between two definitions, as a revision's summary. */
export function changedFields(before: CapabilityDefinition | undefined, after: CapabilityDefinition): string {
  if (!before) return "created";
  const changed = FIELDS.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  return changed.length ? changed.join(", ") : "no change";
}

/**
 * A house's capabilities with their history: the definition in force lives in the config (its source of truth);
 * every change also appends a full snapshot here, so any revision can be restored (as a new one). Pets' drafts wait
 * here until the owner applies or discards them.
 */
export class Capabilities {
  constructor(private readonly config: ConfigStore, private readonly store: KeyValueStore, private readonly applied: () => Promise<unknown>) {}

  private async house(house: string) {
    const found = (await this.config.load()).houses.find(h => h.name === house);
    if (!found) throw new NotFoundError(`unknown house '${house}'`);
    return found;
  }
  async list(house: string) { return (await this.house(house)).capabilities ?? []; }
  history(house: string, name: string): CapabilityRevision[] { return JSON.parse(this.store.get(historyKey(house, name)) ?? "[]"); }
  private record(house: string, name: string, revision: Omit<CapabilityRevision, "rev" | "at">): CapabilityRevision {
    const history = this.history(house, name);
    const next = { ...revision, rev: (history.at(-1)?.rev ?? 0) + 1, at: Date.now() };
    this.store.set(historyKey(house, name), JSON.stringify([...history, next]));
    return next;
  }

  /** Creates or replaces a capability, as a new revision. */
  async save(house: string, definition: CapabilityDefinition, author: RevisionAuthor = { kind: "owner" }, from?: CapabilityRevision["from"]): Promise<CapabilityRevision> {
    const existing = (await this.list(house)).find(capability => capability.name === definition.name);
    if (existing) await this.config.updateCapability(house, definition.name, definition);
    else await this.config.addCapability(house, definition);
    // Read back: the stored form (defaults filled) is what a restore brings back.
    const saved = (await this.list(house)).find(capability => capability.name === definition.name)!;
    const revision = this.record(house, definition.name, { author, summary: changedFields(existing, saved), definition: saved, ...(from ? { from } : {}) });
    await this.applied();
    return revision;
  }
  /** A past revision's content becomes the newest revision; history is never rewritten. */
  async restore(house: string, name: string, rev: number) {
    const found = this.history(house, name).find(revision => revision.rev === rev);
    if (!found) throw new NotFoundError(`unknown revision ${rev} of '${name}'`);
    const current = (await this.list(house)).find(capability => capability.name === name);
    if (!current) throw new NotFoundError(`unknown capability '${name}'`);
    // Keys are added and removed on their own (each a secret): a restore keeps today's, as the admin says.
    const revision = await this.save(house, { ...found.definition, keys: current.keys, ...(current.owner ? { owner: current.owner } : {}) });
    this.store.set(historyKey(house, name), JSON.stringify(this.history(house, name).map(each => each.rev === revision.rev ? { ...each, summary: `restored r${rev}` } : each)));
    return revision;
  }
  /** A copy under a new name, with a history of its own that starts where it was copied from. */
  async duplicate(house: string, name: string, as: string) {
    const source = (await this.list(house)).find(capability => capability.name === name);
    if (!source) throw new NotFoundError(`unknown capability '${name}'`);
    // Keys stay with their capability: a secret is restricted to one capability's name, so the copy starts without.
    return this.save(house, { ...structuredClone(source), name: as, keys: [] }, { kind: "owner" }, { capability: name, rev: this.history(house, name).at(-1)?.rev ?? 0 });
  }
  async remove(house: string, name: string) {
    await this.config.removeCapability(house, name);
    this.store.delete(historyKey(house, name));
    this.discardFor(house, name);
    await this.applied();
  }

  drafts(house: string): CapabilityDraft[] { return JSON.parse(this.store.get(draftsKey(house)) ?? "[]"); }
  private setDrafts(house: string, drafts: CapabilityDraft[]) { this.store.set(draftsKey(house), JSON.stringify(drafts)); }
  private discardFor(house: string, capability: string) { this.setDrafts(house, this.drafts(house).filter(draft => draft.capability !== capability)); }

  /**
   * A pet's draft: a whole definition (new, or a change to one) that only the owner applies. Its keys are kept as
   * they are (a pet never names a secret); the variables it says it needs are names, shown to the owner as missing.
   */
  async draft(caller: PetIdentity, input: { name: unknown; description?: unknown; install?: unknown; network?: unknown; needs_keys?: unknown }) {
    if (typeof input.name !== "string" || !NAME_PATTERN.test(input.name)) throw new HouseholdError("name: lowercase letters, digits and hyphens, starting with a letter");
    const house = await this.house(caller.house);
    if (!house.pets.some(pet => pet.name === caller.pet)) throw new HouseholdError("Only a pet of this house may draft its capabilities");
    const current = (house.capabilities ?? []).find(capability => capability.name === input.name);
    if (current?.owner) throw new HouseholdError(`${input.name} belongs to a scout blueprint; only your human edits it`);
    if (!current && this.drafts(caller.house).filter(each => !(house.capabilities ?? []).some(c => c.name === each.capability)).length >= 10) throw new HouseholdError("Ten new capabilities already wait for your human; ask them to review those first");
    const text = (value: unknown, field: string, max: number, fallback: string) => {
      if (value === undefined) return fallback;
      if (typeof value !== "string" || value.length > max) throw new HouseholdError(`${field} must be text up to ${max} characters`);
      return value;
    };
    const network = input.network === undefined ? current?.network ?? { any: true, allow: [] } : (() => {
      const raw = input.network as { any?: unknown; allow?: unknown };
      if (!raw || typeof raw !== "object" || typeof raw.any !== "boolean" || (raw.allow !== undefined && (!Array.isArray(raw.allow) || raw.allow.length > 64))) throw new HouseholdError("network: {any: boolean, allow?: [\"host\" or \"host:port\"]}");
      const allow = ((raw.allow ?? []) as unknown[]).map(entry => { const parsed = typeof entry === "string" ? parseAllowEntry(entry) : undefined; if (!parsed) throw new HouseholdError(`network.allow: ${String(entry)} is not a host or host:port`); return parsed; });
      if (!raw.any && allow.length === 0) throw new HouseholdError("network: name at least one host, or any: true");
      return { any: raw.any, allow };
    })();
    const needsKeys = input.needs_keys === undefined ? [] : Array.isArray(input.needs_keys) && input.needs_keys.length <= 32 && input.needs_keys.every(key => typeof key === "string" && /^[A-Z_][A-Z0-9_]{0,63}$/.test(key)) ? input.needs_keys as string[] : (() => { throw new HouseholdError("needs_keys: environment variable names only, like DD_API_KEY"); })();
    const definition: CapabilityDefinition = {
      name: input.name,
      description: text(input.description, "description", 1000, current?.description ?? ""),
      install: text(input.install, "install", 100_000, current?.install ?? ""),
      network,
      keys: current?.keys ?? [],
    };
    const draft: CapabilityDraft = { id: crypto.randomUUID(), capability: input.name, pet: caller.pet, at: Date.now(), definition, needsKeys };
    // One draft per capability: a newer one replaces the older.
    this.setDrafts(caller.house, [...this.drafts(caller.house).filter(each => each.capability !== input.name), draft]);
    return { status: "waiting_owner", capability: input.name, changes: changedFields(current, definition), kind: capabilityKind(definition) };
  }
  async applyDraft(house: string, id: string) {
    const draft = this.drafts(house).find(each => each.id === id);
    if (!draft) throw new NotFoundError("unknown draft");
    const current = (await this.list(house)).find(capability => capability.name === draft.capability);
    // Keys are the owner's: the definition's keys at apply time win over what the draft carried.
    const revision = await this.save(house, { ...draft.definition, keys: current?.keys ?? [] }, { kind: "pet", pet: draft.pet });
    this.setDrafts(house, this.drafts(house).filter(each => each.id !== id));
    return revision;
  }
  discard(house: string, id: string) {
    if (!this.drafts(house).some(each => each.id === id)) throw new NotFoundError("unknown draft");
    this.setDrafts(house, this.drafts(house).filter(each => each.id !== id));
  }

  /** What a pet may know: names, descriptions, kinds, hosts and key variables — no secret names, no values. */
  async catalog(caller: PetIdentity, envOf: (secret: string) => string | undefined) {
    return (await this.list(caller.house)).filter(capability => !capability.owner).map(capability => ({
      name: capability.name, description: capability.description, kind: capabilityKind(capability),
      network: capability.network.any ? "any" : capability.network.allow.map(formatAllowEntry),
      key_variables: capability.keys.flatMap(key => { const env = key.via === "vm" ? key.env : envOf(key.secret); return env ? [env] : []; }),
    }));
  }
}

/** A pet's tools for capabilities: read the catalog, draft one. Applying is the owner's, in the admin. */
export function capabilityTools(capabilities: Capabilities, envOf: (house: string, secret: string) => string | undefined, enabled: (caller: PetIdentity) => boolean): McpTool<PetIdentity>[] {
  return [
    {
      name: "capabilities",
      description: "List the house's shared capabilities, the bricks your human builds scouts from: name, description, kind (tool: no network limit; access: a host list or keys), hosts and the environment variables of their keys (names only). You call scouts, not capabilities; this is for drafting one. Read household-capabilities before drafting.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      available: enabled,
      async call(caller) { return JSON.stringify(await capabilities.catalog(caller, secret => envOf(caller.house, secret))); },
    },
    {
      name: "capability_draft",
      description: "Propose a capability, or a change to one (same name): description, a bash install script (runs as root at the start of every scout run; fetch software with package managers, pin versions in the script if needed), network ({any:true} or {any:false, allow:[\"host\",\"host:port\"]}) and needs_keys (environment variable NAMES the owner must supply, never values). Your human reviews, tests and applies it in the admin; nothing changes until then.",
      inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: {
        name: { type: "string" }, description: { type: "string" }, install: { type: "string" },
        network: { type: "object", properties: { any: { type: "boolean" }, allow: { type: "array", items: { type: "string" } } }, required: ["any"], additionalProperties: false },
        needs_keys: { type: "array", items: { type: "string" } },
      } },
      available: enabled,
      async call(caller, args) { return JSON.stringify(await capabilities.draft(caller, args as { name: unknown })); },
    },
  ];
}
