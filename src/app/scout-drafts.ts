import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { cardText, html } from "../core/card";
import { HouseholdError } from "../core/errors";
import { assertPlain } from "../core/hidden-text";
import type { House, Household } from "../core/household";
import { houseFeatures } from "../core/house-features";
import { NAME_PATTERN } from "../core/names";
import { blueprintCapabilities, blueprintInstallHosts, blueprintNetwork, routineBlocker, routineFor, scoutBase, scoutBaseChanges, scoutKeys, scoutNetworkWords, scoutProblems, staleDraftMessage, type CapabilityDefinition, type ScoutBase, type ScoutDefinition } from "../core/scouts";
import { formatAllowEntry, isAllowed, type AllowEntry } from "../core/network-policy";
import type { PetIdentity } from "../infra/agent-api";
import { capabilityDefinitionSchema, scoutDefinitionSchema } from "../infra/config-schema";
import { capabilityDefinitionInput, NotFoundError, ScoutRevisionError, scoutDefinitionInput, type ConfigStore } from "../infra/config-store";
import type { McpTool } from "../infra/mcp-server";
import type { KeyValueStore } from "../infra/sqlite-store";
import { draftInstallHosts, draftKeys, draftNetwork, draftText, lineEnds, type Capabilities } from "./capabilities";
import type { PostedNotice } from "./chat";
import { networkFact } from "./scouts";

/** What a bot proposes for a scout: the fields a scout's description and work are made of. Who runs it how is the owner's. */
type DraftedScout = Pick<ScoutDefinition, "name" | "title" | "emoji" | "description" | "instructions" | "capabilities">;
/**
 * A bot's proposal for a whole scout, new or a change to one (same name). Never a routine list: the bot only asks
 * (`wantsRoutine`), and the owner names who runs it without asking when they apply it. Never a secret either: its
 * own setup's keys are the owner's at apply time, and what it needs is variable names.
 */
export interface ScoutDraft {
  id: string;
  scout: string;
  /** The bot that drafted it, and that hears what became of it. */
  pet: string;
  at: number;
  /** The bot's words for the owner: why this scout, why this access. Shown quoted, never as Household's. */
  reason: string;
  definition: DraftedScout;
  /** Its own setup as proposed (keys left to the owner); null: its own setup stays as it is (or it has none). */
  own: CapabilityDefinition | null;
  /** Environment variable names its own setup needs, for the owner to supply. */
  needsKeys: string[];
  wantsRoutine: boolean;
  /** It was drafted as a change to a scout that existed then: once that scout is gone, so is the draft. */
  change: boolean;
  /** What it was made against (`scoutBase`): applied over a scout changed since, it would undo the change. */
  base: ScoutBase;
  /** Its notice in the bot's chat, and that notice's text: rewritten once the owner decides. */
  notice?: PostedNotice & { text: string };
}
/**
 * The owner's word on applying a draft. `routine`: the bots that run it without asking (none: every run asks).
 * `keys`: whether the keys a change puts at stake (`KeyGate`) go along (keep) or its own setup's come off (drop); only
 * when some are. `force`: apply a draft made against a scout that changed since.
 */
export interface ApplyOptions {
  routine?: readonly string[]; keys?: "keep" | "drop"; force?: boolean;
  /** The fingerprint of the review the owner decided on (`reviewed` of the draft's view). */
  reviewed?: string;
}
export interface ScoutDraftDeps {
  config: ConfigStore;
  store: KeyValueStore;
  /** Its own capability's revisions are kept there, as any capability's. */
  capabilities: Capabilities;
  /** The config changed: the daemon applies it (the bots' scouts lists with it). */
  applied(): Promise<unknown>;
  /** A notice of Household's (HTML) in the bot's current chat place; undefined when not posted. */
  announce?(house: string, pet: string, text: string): Promise<PostedNotice | undefined>;
  /** A notice of Household's says `text` (HTML) now. */
  rewrite?(house: string, notice: PostedNotice, text: string): Promise<void>;
  /** An internal Household notice to a bot. */
  send?(house: string, pet: string, text: string): void;
  /** How people call a bot of the workspace (its title). */
  title?(house: string, pet: string): string;
  now?(): number;
}
/** The owner's apply went into the config, but what comes after did not: the scout is there, not yet live. */
export class AppliedNotLiveError extends HouseholdError {}

const draftsKey = (house: string) => `scouts.drafts.v1.${house}`;
/** The workspaces that have drafts: a deleted workspace's go with it, even when one is made again under its name. */
const HOUSES_KEY = "scouts.drafts.v1.houses";
/** Drafts that may wait for the owner at once, per workspace. */
const MAX_DRAFTS = 10;
/** Drafts a bot may save in `RATE_MS`: a bot in a loop neither floods its chat nor keeps the config busy. */
const RATE_COUNT = 6, RATE_MS = 10 * 60_000;
/** How long a script is, for the owner to know what reading it takes. */
const lines = (script: string) => { const count = script.trimEnd().split("\n").length; return `${count} line${count === 1 ? "" : "s"} to read`; };
/** The setup's fields: the same as a capability draft's. */
const SETUP_FIELDS = ["install", "network", "install_hosts", "needs_keys"];
/** A config error said to a bot: what is wrong, never where the owner keeps their config. */
const withoutSource = (message: string) => message.replace(/^invalid config [^\n]*:\n/, "");

/** The shared capabilities a composed scout ticks, as the review lists them. */
function sharedOf(composed: { definition: ScoutDefinition; capabilities: readonly CapabilityDefinition[] }) {
  return composed.definition.capabilities.flatMap(name => composed.capabilities.filter(capability => capability.name === name)).map(capability => ({
    name: capability.name, description: capability.description, hosts: capability.network.any ? null : capability.network.allow.map(formatAllowEntry), installs: !!capability.install.trim(),
  }));
}
const fingerprint = (basis: unknown) => createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
/** What of its own setup's install and network a draft changes (none when it proposes no setup, or there was none). */
function ownChanges(own: CapabilityDefinition | null | undefined, current: CapabilityDefinition | undefined): ("install" | "network")[] {
  if (!own || !current) return [];
  const proposed = capabilityDefinitionInput(own), now = capabilityDefinitionInput(current);
  return (["install", "network"] as const).filter(field => JSON.stringify(proposed[field]) !== JSON.stringify(now[field]));
}
/** A key the resulting scout carries: its variable, where it comes from, how it is delivered; `keptWith`: an own setup's key carried over onto a changed setup. */
export interface DraftKey { env: string | null; secret: string; source: string; via: "gateway" | "vm"; keptWith?: ("install" | "network")[] }
/** Where a key comes from and how it is delivered, in words: "own setup, value in its VM; kept, with a changed install". */
const keyDetail = (key: DraftKey) => `${key.source}, ${key.via === "vm" ? "value in its VM" : "gateway placeholder"}${key.keptWith?.length ? `; kept, with a changed ${key.keptWith.join(" and ")}` : ""}`;
/** A key in words (plain text): "METER_PASSWORD (own setup, value in its VM)". */
export const draftKeyWords = (key: DraftKey) => `${key.env ?? key.secret} (${keyDetail(key)})`;
const keyName = (key: DraftKey) => key.env ?? key.secret;
/**
 * The keys a change to a scout puts at stake, and why: a key whose value is inside its VM can leave with anything the
 * VM sends, so a change that gives the scout a way out it did not have (a host or port, the open internet), changes
 * its own install script, or brings such a key in with a capability, applies only on the owner's word (`choices`).
 * A gateway key goes only to its secret's hosts: it is never at stake. A new scout has no before: it is shown, not gated.
 */
export interface KeyGate {
  keys: DraftKey[];
  reasons: string[];
  /** `drop` takes its own setup's keys off; a shared capability's key comes with the capability: keep it, or untick that. */
  choices: ("keep" | "drop")[];
}
/** A key whose value is inside a scout's VM, plainly: where it can go, and what no check of Household's covers. */
export const VM_KEY_NOTE = "A key whose value is inside the scout's VM can reach every host the scout reaches, not only its own capability's. Household guards where it can go; what the instructions tell the scout to do with it is yours to read.";
/** What the owner's apply did with the scout's keys: the choice made (none asked: null), what it carries, what came off. */
export interface KeysOutcome { choice: "keep" | "drop" | null; kept: string[]; dropped: string[] }

/**
 * Scouts bots propose (`scout_draft`): kept here, per workspace, until the owner applies or discards one in the admin.
 * Nothing a bot writes reaches the config before that; applying writes the scout and its own setup in one edit, with
 * every check of the config, and who runs it without asking only as the owner says then.
 */
export class ScoutDrafts {
  private queue: Promise<unknown> = Promise.resolve();
  /** When each bot saved its last drafts (`RATE_COUNT` in `RATE_MS`). */
  private saves = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(private readonly deps: ScoutDraftDeps) { this.now = deps.now ?? Date.now; }

  /** One change at a time: a draft, an apply and a discard each read the list and write it back. */
  private serial<T>(f: () => Promise<T>) { const p = this.queue.then(f); this.queue = p.catch(() => {}); return p; }
  private async house(name: string): Promise<House> {
    const found = (await this.deps.config.load()).houses.find(house => house.name === name);
    if (!found) throw new NotFoundError(`unknown workspace '${name}'`);
    return found;
  }
  private stored(house: string): ScoutDraft[] { return JSON.parse(this.deps.store.get(draftsKey(house)) ?? "[]"); }
  private houses(): string[] { return JSON.parse(this.deps.store.get(HOUSES_KEY) ?? "[]"); }
  private setDrafts(house: string, drafts: ScoutDraft[]) {
    if (drafts.length) this.deps.store.set(draftsKey(house), JSON.stringify(drafts));
    else this.deps.store.delete(draftsKey(house));
    const houses = this.houses().filter(name => name !== house);
    this.deps.store.set(HOUSES_KEY, JSON.stringify(drafts.length ? [...houses, house] : houses));
  }
  /**
   * The drafts that still stand: a removed bot's go (one made later under its name drafted none of them), and so does
   * a change to a scout that was deleted since (applied, it would bring the scout back).
   */
  private standing(house: House): ScoutDraft[] {
    const all = this.stored(house.name);
    const kept = all.filter(draft => house.pets.some(pet => pet.name === draft.pet) && (!draft.change || (house.scouts ?? []).some(scout => scout.name === draft.scout)));
    if (kept.length !== all.length) this.setDrafts(house.name, kept);
    return kept;
  }
  async list(house: string): Promise<ScoutDraft[]> { return this.standing(await this.house(house)); }
  /** The daemon applies a config: drafts of bots, scouts and workspaces gone from it go now, not when next read. */
  prune(household: Household) {
    for (const name of this.houses()) if (!household.houses.some(house => house.name === name)) this.setDrafts(name, []);
    for (const house of household.houses) this.standing(house);
  }

  /**
   * What applying `draft` would write: the bot's fields, the owner's own (its repository, harness and size as they are
   * now), `routine` only as given here, and its own setup with the keys it has now. `keys: "drop"` takes the keys
   * whose value is in its VM off its own setup (the draft's, or the one it has when the draft leaves it alone).
   * `capabilities`: the workspace's as they would be.
   */
  private compose(house: House, draft: Pick<ScoutDraft, "scout" | "definition" | "own">, options: ApplyOptions = {}) {
    const current = (house.scouts ?? []).find(scout => scout.name === draft.scout);
    const all = house.capabilities ?? [], currentOwn = all.find(capability => capability.owner === draft.scout);
    const definition: ScoutDefinition = {
      ...structuredClone(draft.definition),
      ...(current?.workspace ? { workspace: current.workspace } : {}), ...(current?.agent ? { agent: current.agent } : {}), ...(current?.resources ? { resources: current.resources } : {}),
      ...(options.routine?.length ? { routine: [...options.routine] } : {}),
    };
    const keys = (currentOwn?.keys ?? []).filter(key => options.keys !== "drop" || key.via !== "vm");
    const installHosts = draft.own && "installHosts" in draft.own ? draft.own.installHosts : currentOwn?.installHosts;
    const own = draft.own ? { ...structuredClone(draft.own), name: currentOwn?.name ?? draft.own.name, keys, owner: draft.scout, ...(installHosts ? { installHosts: structuredClone(installHosts) } : {}) }
      : options.keys === "drop" && currentOwn ? { ...structuredClone(currentOwn), keys } : undefined;
    const capabilities = own ? [...all.filter(capability => capability !== currentOwn), own] : all;
    return { current, currentOwn, definition, own, capabilities };
  }
  /** Every key the composed scout carries, with where it comes from; its own setup's marked when carried onto a changed setup. */
  private keys(house: House, composed: ReturnType<ScoutDrafts["compose"]>, changes: ("install" | "network")[]): DraftKey[] {
    const envOf = (secret: string) => (house.secrets ?? []).find(item => item.name === secret)?.env;
    return scoutKeys({ capabilities: blueprintCapabilities(composed.definition, composed.capabilities) }, composed.capabilities).map(key => {
      const own = composed.capabilities.find(capability => capability.name === key.capability)?.owner === composed.definition.name;
      return { env: (key.via === "vm" ? key.env : envOf(key.secret)) ?? null, secret: key.secret, source: own ? "own setup" : key.capability, via: key.via, ...(own && changes.length ? { keptWith: changes } : {}) };
    });
  }

  /** The keys a change puts at stake, and why (`KeyGate`); null when none are, and for a new scout. */
  private gate(house: House, draft: Pick<ScoutDraft, "scout" | "definition" | "own">): KeyGate | null {
    const composed = this.compose(house, draft), { current } = composed;
    if (!current) return null;
    const keys = this.keys(house, composed, ownChanges(draft.own, composed.currentOwn)).filter(key => key.via === "vm");
    if (!keys.length) return null;
    const before = blueprintNetwork(current, house.capabilities ?? []), after = blueprintNetwork(composed.definition, composed.capabilities);
    const reasons: string[] = [];
    // A way out it did not have, from any source: its own setup or a shared capability.
    if (!before.open && after.open) reasons.push("it would reach the open internet");
    else if (!before.open) {
      const had = new Set(before.allow.map(formatAllowEntry)), fresh = after.allow.map(formatAllowEntry).filter(host => !had.has(host));
      if (fresh.length) reasons.push(`it would reach new hosts: ${fresh.join(", ")}`);
    }
    if (ownChanges(draft.own, composed.currentOwn).includes("install")) reasons.push("its own install script changes");
    // Its install scripts run beside the keys: a host they may download from is a way out while they run, unless the
    // scout reached it already (on the open internet, through its network, or while it installed).
    const installedFrom = new Set(blueprintInstallHosts(current, house.capabilities ?? []).map(formatAllowEntry));
    const reachedBefore = (entry: AllowEntry) => before.open || installedFrom.has(formatAllowEntry(entry)) || isAllowed({ kind: "allowlist", allow: before.allow }, { host: entry.host, port: entry.port as number });
    const freshInstalls = blueprintInstallHosts(composed.definition, composed.capabilities).filter(entry => !reachedBefore(entry)).map(formatAllowEntry);
    if (freshInstalls.length) reasons.push(`its install scripts would download from new hosts: ${freshInstalls.join(", ")}`);
    for (const name of composed.definition.capabilities.filter(name => !current.capabilities.includes(name))) {
      const brought = keys.filter(key => key.source === name);
      if (brought.length) reasons.push(`added capability ${name} brings ${brought.map(keyName).join(", ")}`);
      // Its install script runs as root in the VM that holds them, before the scout starts: a way to them of its own.
      else if (composed.capabilities.find(capability => capability.name === name)?.install.trim()) reasons.push(`added capability ${name} runs its install script beside them`);
    }
    return reasons.length ? { keys, reasons, choices: keys.some(key => key.source === "own setup") ? ["keep", "drop"] : ["keep"] } : null;
  }

  /**
   * A bot's draft. Checked as the owner's apply would check it (the scout's and its setup's schemas, the workspace's
   * config with it in), so what is wrong with it is said to the bot now, not found by the owner later. One per scout:
   * a newer one replaces the older. Its notice goes to the bot's chat; the owner decides on the review page.
   */
  draft(caller: PetIdentity, raw: Record<string, unknown>) {
    const input: Record<string, unknown> = { ...raw, ...Object.fromEntries(["description", "instructions", "reason"].filter(field => field in raw).map(field => [field, lineEnds(raw[field])])),
      ...(raw.setup && typeof raw.setup === "object" && !Array.isArray(raw.setup) && "install" in raw.setup ? { setup: { ...raw.setup, install: lineEnds((raw.setup as Record<string, unknown>).install) } } : {}) };
    return this.serial(async () => {
      // Before anything is read: a bot past its rate costs nothing but this answer.
      const rate = `${caller.house}/${caller.pet}`, recent = (this.saves.get(rate) ?? []).filter(at => this.now() - at < RATE_MS);
      this.saves.set(rate, recent);
      if (recent.length >= RATE_COUNT) throw new HouseholdError(`You saved ${RATE_COUNT} scout drafts in the last ${RATE_MS / 60_000} minutes: wait, and let your human review those first`);
      const name = input.name;
      if (typeof name !== "string" || !NAME_PATTERN.test(name)) throw new HouseholdError("name: lowercase letters, digits and hyphens, starting with a letter (at most 31)");
      const house = await this.house(caller.house);
      if (!houseFeatures(house).scouts) throw new HouseholdError("Scouts are off in this workspace");
      if (!house.pets.some(pet => pet.name === caller.pet)) throw new HouseholdError("Only a bot of this workspace may draft its scouts");
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (!reason || reason.length > 500 || reason.split("\n").length > 3) throw new HouseholdError("reason: one or two lines for your human (at most 500 characters): why this scout, why this access, and the worst it could do");
      if (input.routine !== undefined && typeof input.routine !== "boolean") throw new HouseholdError("routine: true to ask to run it without asking, else leave it out");
      for (const field of ["description", "instructions"]) if (typeof input[field] !== "string") throw new HouseholdError(`${field} is required: ${field === "description" ? "when a bot should call this scout" : "how the scout does its task"}`);
      for (const field of ["title", "emoji"]) if (input[field] !== undefined && typeof input[field] !== "string") throw new HouseholdError(`${field} must be text`);
      for (const field of ["description", "instructions", "reason", "title"]) assertPlain(input[field], field);

      const all = house.capabilities ?? [], scouts = house.scouts ?? [], drafts = this.standing(house);
      const current = scouts.find(scout => scout.name === name), currentOwn = all.find(capability => capability.owner === name);
      if (drafts.filter(draft => draft.scout !== name).length >= MAX_DRAFTS) throw new HouseholdError("Ten scout drafts already wait for your human; ask them to review those first");

      // Shared capabilities only, by name: another scout's own setup is no brick for this one.
      const ticked = input.capabilities === undefined ? current?.capabilities ?? [] : input.capabilities;
      if (!Array.isArray(ticked) || ticked.length > 32 || ticked.some(item => typeof item !== "string")) throw new HouseholdError("capabilities: names of shared capabilities (the capabilities tool lists them)");
      for (const item of ticked as string[]) if (!all.some(capability => capability.name === item && !capability.owner)) throw new HouseholdError(`unknown capability '${item}': the capabilities tool lists the shared ones`);

      const title = (input.title as string | undefined) ?? current?.title;
      let own: CapabilityDefinition | undefined, needsKeys: string[] = [];
      if (input.setup !== undefined) {
        const setup = input.setup as Record<string, unknown>;
        if (!setup || typeof setup !== "object" || Array.isArray(setup) || Object.keys(setup).some(key => !SETUP_FIELDS.includes(key))) throw new HouseholdError("setup: {install?, network?, install_hosts?, needs_keys?}, as in capability_draft");
        assertPlain(setup.install, "setup.install");
        // Its own capability is named after it: a shared one by that name is a clash the config would refuse.
        if (!currentOwn && all.some(capability => capability.name === name)) throw new HouseholdError(`A capability is already named ${name}, the name its own setup would take: pick another name for the scout`);
        own = {
          name: currentOwn?.name ?? name, description: currentOwn?.description ?? `${title ?? name}'s own`,
          install: draftText(setup.install, "setup.install", 100_000, currentOwn?.install ?? ""), network: draftNetwork(setup.network, currentOwn?.network),
          keys: currentOwn?.keys ?? [], owner: name,
        };
        // Only what the bot said ([] too): left out, the ones its own setup has when the owner applies it (`compose`).
        if (setup.install_hosts !== undefined) own.installHosts = draftInstallHosts(setup.install_hosts, undefined);
        needsKeys = draftKeys(setup.needs_keys);
      }

      // The real schemas: what they fill in or normalize (an emoji, trimmed text) is what the owner reviews.
      const parsed = scoutDefinitionSchema.safeParse({ name, ...(title !== undefined ? { title } : {}), ...((input.emoji ?? current?.emoji) !== undefined ? { emoji: input.emoji ?? current?.emoji } : {}), description: input.description, instructions: input.instructions, capabilities: ticked });
      if (!parsed.success) throw new HouseholdError(z.prettifyError(parsed.error));
      const definition: DraftedScout = { name, ...(parsed.data.title ? { title: parsed.data.title } : {}), ...(parsed.data.emoji ? { emoji: parsed.data.emoji } : {}), description: parsed.data.description, instructions: parsed.data.instructions, capabilities: parsed.data.capabilities };
      if (own) {
        const setup = capabilityDefinitionSchema.safeParse(capabilityDefinitionInput(own));
        if (!setup.success) throw new HouseholdError(`setup: ${z.prettifyError(setup.error)}`);
        // A list the bot emptied stays said ([]): a draft that names none keeps the current ones (`compose`).
        own = { ...setup.data as CapabilityDefinition, ...(own.installHosts ? { installHosts: own.installHosts } : {}) };
      }
      const composed = this.compose(house, { scout: name, definition, own: own ?? null });
      const envOf = (secret: string) => (house.secrets ?? []).find(item => item.name === secret)?.env;
      const problems = scoutProblems({ capabilities: blueprintCapabilities(composed.definition, composed.capabilities) }, composed.capabilities, envOf);
      if (problems.length) throw new HouseholdError(problems.join("; "));
      // From here on it takes the config's lock and may post to the chat: it counts against the bot's rate.
      this.saves.set(rate, [...recent, this.now()]); // one at a time (serial): `recent` is still the latest
      // The whole config with it in, as the owner's apply will write it: nothing knowable now fails then.
      try { await this.deps.config.putScout(caller.house, composed.definition, composed.own, { dryRun: true }); }
      catch (error) { throw new HouseholdError(`The workspace would not take this scout: ${withoutSource(error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message)}`); }

      // A key it already gets (from a capability it ticks, or its own setup's) is no key to ask for.
      const keys = this.keys(house, composed, ownChanges(own, currentOwn)), provided = new Set(keys.map(key => key.env));
      needsKeys = needsKeys.filter(env => !provided.has(env));
      const network = blueprintNetwork(composed.definition, composed.capabilities), blocker = routineBlocker(network);
      const wantsRoutine = input.routine === true;
      const answer = { status: "waiting_owner", scout: name, proposal: current ? "change" : "new", network: scoutNetworkWords(composed.definition, composed.capabilities),
        ...(needsKeys.length ? { needs_keys: needsKeys } : {}), ...(wantsRoutine ? { routine: blocker ? `not possible: ${blocker}` : "asked: your human decides when they apply it" } : {}) };

      const draft: ScoutDraft = { id: randomUUID(), scout: name, pet: caller.pet, at: this.now(), reason, definition, own: own ?? null, needsKeys, wantsRoutine, change: !!current, base: scoutBase(house, name) };
      // Read again: the dry run awaited the config, and a prune (a bot or scout gone) may have written the list since.
      const latest = this.stored(caller.house), older = latest.find(each => each.scout === name);
      // The same draft again, against the same scout, changes nothing, and says nothing again in the chat.
      const same = (each: ScoutDraft) => JSON.stringify([each.pet, each.reason, each.definition, each.own, each.needsKeys, each.wantsRoutine, each.base]) === JSON.stringify([draft.pet, draft.reason, draft.definition, draft.own, draft.needsKeys, draft.wantsRoutine, draft.base]);
      if (older && same(older)) return answer;
      this.setDrafts(caller.house, [...latest.filter(each => each.scout !== name), draft]);
      if (older) {
        const by = this.deps.title?.(caller.house, caller.pet) ?? caller.pet;
        this.settle(caller.house, older, `Replaced by a newer draft from ${by}.`);
        // Another bot's draft took its place: its bot learns it from Household, not from silence.
        if (older.pet !== caller.pet) this.deps.send?.(caller.house, older.pet, `Household: your draft of scout ${name} was replaced by a newer draft from ${by}; yours is gone and will not be applied. This is an internal notice, not a message from your human.`);
      }
      const text = this.noticeText(house, draft, composed, network, blocker, keys, this.gate(house, draft));
      const notice = await this.deps.announce?.(caller.house, caller.pet, text).catch(() => undefined);
      // Applied or discarded while the notice went up: nothing to keep it for.
      if (notice) this.setDrafts(caller.house, this.stored(caller.house).map(each => each.id === draft.id ? { ...each, notice: { ...notice, text } } : each));
      return answer;
    });
  }

  /**
   * The notice of a new draft, in the drafting bot's chat: who proposes what (the scout's title as the owner set it, or
   * as the bot wrote it, quoted), the bot's reason quoted, then Household's own facts (every key it would carry among
   * them), and where to review it. No button: keys are entered and the install script read on the review page.
   */
  private noticeText(house: House, draft: ScoutDraft, composed: ReturnType<ScoutDrafts["compose"]>, network: Parameters<typeof networkFact>[0], blocker: string | undefined, keys: DraftKey[], gate: KeyGate | null): string {
    const pet = this.deps.title?.(house.name, draft.pet) ?? draft.pet;
    const shown = (scout: Pick<ScoutDefinition, "name" | "title" | "emoji">) => `${scout.emoji ? `${scout.emoji} ` : ""}${scout.title ?? scout.name}`;
    const capabilities = [...composed.definition.capabilities.map(name => `<code>${html(name)}</code>`), ...(composed.own || composed.currentOwn ? ["own setup"] : [])].join(", ") || "none";
    const keyWords = (key: DraftKey) => `<code>${html(key.env ?? key.secret)}</code> (${html(keyDetail(key))})`;
    return cardText({
      title: composed.current ? `${html(pet)} proposes a change to scout ${html(shown(composed.current))}` : `${html(pet)} proposes scout “${html(shown(draft.definition))}”`,
      quote: { label: "Why", text: draft.reason },
      facts: [
        `Capabilities: ${capabilities}`, networkFact(network),
        ...(draft.own ? [`Install script of its own: ${draft.own.install.trim() ? lines(draft.own.install) : "none"}`] : []),
        ...(keys.length ? [`🔑 Keys it would carry: ${keys.map(keyWords).join(", ")}`] : []),
        ...(network.open && keys.length ? ["⚠️ Real secrets on the open internet: a tricked scout can send them anywhere."] : []),
        ...(gate ? [`⚠️ Keys at stake (${gate.keys.map(key => `<code>${html(keyName(key))}</code>`).join(", ")}): ${html(gate.reasons.join("; "))}. You decide whether they go along.`] : []),
        ...(draft.needsKeys.length ? [`Keys it needs: ${draft.needsKeys.map(env => `<code>${html(env)}</code>`).join(", ")}`] : []),
        ...(draft.wantsRoutine ? [blocker ? `Asks to run it without asking; not possible: ${html(blocker)}` : "Asks to run it without asking"] : []),
      ],
      note: `Nothing changes until you apply it. Review it in the admin, ${html(house.name)} → Scouts → Drafts, or with <code>house scout drafts ${html(house.name)}</code>.`,
    });
  }
  /** Its notice says what became of it. */
  private settle(house: string, draft: ScoutDraft, outcome: string) {
    if (draft.notice) void this.deps.rewrite?.(house, draft.notice, `${draft.notice.text}\n\n<b>${html(outcome)}</b>`).catch(() => {});
  }

  /** Everything the owner's review needs: what it would be, against what it is, and what that means for its network and keys. */
  async view(houseName: string, id: string) {
    const house = await this.house(houseName), draft = this.standing(house).find(each => each.id === id);
    if (!draft) throw new NotFoundError("unknown draft");
    return this.present(house, draft);
  }
  async views(houseName: string) {
    const house = await this.house(houseName);
    return this.standing(house).map(draft => this.present(house, draft));
  }
  /**
   * What the owner decides on, as the review shows it: the keys at stake and why, where the result can go, every key it
   * carries, what changed since it was drafted, whether it can be routine, the shared capabilities it ticks. Its
   * fingerprint goes back with the owner's apply: one that no longer matches means they decided on something else.
   */
  private basis(house: House, draft: ScoutDraft) {
    const composed = this.compose(house, draft), network = blueprintNetwork(composed.definition, composed.capabilities);
    return {
      keyGate: this.gate(house, draft), network: { open: network.open, allow: network.allow.map(formatAllowEntry) },
      keys: this.keys(house, composed, ownChanges(draft.own, composed.currentOwn)), changedSince: scoutBaseChanges(draft.base, scoutBase(house, draft.scout), draft.scout),
      // The scout as it is, values and all: a second edit of a field already named, or bots ticked elsewhere, move it too.
      now: scoutBase(house, draft.scout), routine: composed.current?.routine ?? [],
      routineBlocker: routineBlocker(network) ?? null, shared: sharedOf(composed),
    };
  }
  private present(house: House, draft: ScoutDraft) {
    const composed = this.compose(house, draft), names = blueprintCapabilities(composed.definition, composed.capabilities);
    const network = blueprintNetwork(composed.definition, composed.capabilities);
    const currentNetwork = composed.current ? blueprintNetwork(composed.current, house.capabilities ?? []) : null;
    const envOf = (secret: string) => (house.secrets ?? []).find(item => item.name === secret)?.env;
    const changes = ownChanges(draft.own, composed.currentOwn), keys = this.keys(house, composed, changes), since = scoutBaseChanges(draft.base, scoutBase(house, draft.scout), draft.scout);
    return {
      id: draft.id, scout: draft.scout, pet: draft.pet, petTitle: this.deps.title?.(house.name, draft.pet) ?? draft.pet, at: draft.at, reason: draft.reason,
      change: !!composed.current, wantsRoutine: draft.wantsRoutine,
      // Made against a scout that changed since: applying it would undo those changes.
      stale: since.length > 0, changedSince: since,
      definition: scoutDefinitionInput(composed.definition),
      own: composed.own ? capabilityDefinitionInput(composed.own) : null,
      current: composed.current ? scoutDefinitionInput(composed.current) : null,
      currentOwn: composed.currentOwn ? capabilityDefinitionInput(composed.currentOwn) : null,
      /** Every key the scout would carry, from its own setup and from the shared capabilities it ticks. */
      keys,
      /** What the draft changes of its own setup's install and network. */
      ownChanges: changes,
      /** The keys this change puts at stake and why; applying it then needs the owner's choice. Null: none are. */
      keyGate: this.gate(house, draft),
      // What the gate does not do, said wherever the keys are listed: it guards where a key can go, not what it is used for.
      vmKeyNote: keys.some(key => key.via === "vm") ? VM_KEY_NOTE : null,
      // Still missing: one the owner has added since is no longer asked for.
      needsKeys: draft.needsKeys.filter(env => !keys.some(key => key.env === env)),
      network: { open: network.open, allow: network.allow.map(formatAllowEntry), limitedBy: network.limitedBy },
      currentNetwork: currentNetwork && { open: currentNetwork.open, allow: currentNetwork.allow.map(formatAllowEntry), limitedBy: currentNetwork.limitedBy },
      networkWords: scoutNetworkWords(composed.definition, composed.capabilities),
      routineBlocker: routineBlocker(network) ?? null,
      problems: scoutProblems({ capabilities: names }, composed.capabilities, envOf),
      /** The shared capabilities it ticks as the owner has them: their hosts (null: any), whether they install something. */
      shared: sharedOf(composed),
      /** What the owner decides on, fingerprinted: sent back with apply, which refuses when it no longer matches. */
      reviewed: fingerprint(this.basis(house, draft)),
    };
  }

  /**
   * The owner applies a draft: the scout and its own setup in one config edit, its own setup's revision by the bot
   * that drafted it. Who runs it without asking is `routine`, and only that: none given, it asks every time, whatever
   * it did before (a bot that re-drafts hosts or instructions never keeps a standing trust it was given for others).
   * Refused, unless the owner says otherwise, when the scout changed since it was drafted (`force`; checked again under
   * the config's lock), and when the change puts keys at stake (`KeyGate`: keep them, or drop its own setup's). A
   * choice about keys where none is at stake is refused too: it would do nothing, or take keys off unasked. `check`:
   * the caller's own checks on what would be written, before it is.
   */
  apply(houseName: string, id: string, options: ApplyOptions = {}, check?: (composed: ReturnType<ScoutDrafts["compose"]>) => void) {
    return this.serial(async () => {
      const house = await this.house(houseName), draft = this.standing(house).find(each => each.id === id);
      if (!draft) throw new NotFoundError("unknown draft");
      // The owner's choices hold for what they saw: keys at stake, hosts, what changed since, all as the review showed them.
      if (options.reviewed !== undefined && options.reviewed !== fingerprint(this.basis(house, draft))) throw new ScoutRevisionError("What this draft would do changed since you reviewed it: reload it and decide again.");
      const since = scoutBaseChanges(draft.base, scoutBase(house, draft.scout), draft.scout);
      if (since.length && !options.force) throw new ScoutRevisionError(staleDraftMessage(draft.scout, since));
      const gate = this.gate(house, draft);
      if (!gate && options.keys) throw new HouseholdError(`No key is at stake in this draft: apply it without ${options.keys}`);
      if (gate && !options.keys) {
        const drop = gate.choices.includes("drop") ? " or take its own setup's off (drop: the workspace's secrets stay)" : "";
        throw new ScoutRevisionError(`This change puts keys whose value is in the scout's VM at stake (${gate.keys.map(keyName).join(", ")}): ${gate.reasons.join("; ")}. Choose whether they go along (keep)${drop}.`);
      }
      const shared = gate?.keys.filter(key => key.source !== "own setup") ?? [];
      if (gate && options.keys === "drop" && !gate.choices.includes("drop")) {
        const from = [...new Set(shared.map(key => key.source))];
        throw new HouseholdError(`${shared.map(keyName).join(", ")} ${shared.length === 1 ? "comes" : "come"} with ${from.map(name => `capability ${name}`).join(" and ")}: a key of a shared capability cannot be dropped from one scout. Keep it, or untick ${from.join(", ")} instead: discard this draft, or ask its bot for one without ${from.length === 1 ? "it" : "them"}.`);
      }
      const composed = this.compose(house, draft, options), { definition, own, capabilities, current, currentOwn } = composed;
      check?.(composed);
      // Under the config's lock: an edit of the owner's that landed since this was read is never overwritten.
      // With force, over what changed since the draft, as read just now: never over an edit that lands during this apply.
      await this.deps.config.putScout(houseName, definition, own, { expected: options.force ? scoutBase(house, draft.scout) : draft.base }).catch(error => {
        if (options.force && error instanceof ScoutRevisionError) throw new ScoutRevisionError(`Scout ${draft.scout} changed while the draft was being applied; nothing was written. Review it again.`);
        throw error;
      });
      // It is in the config: the draft is done, whatever happens next.
      this.setDrafts(houseName, this.stored(houseName).filter(each => each.id !== id));
      const after = this.keys(house, composed, []).map(keyName), before = this.keys(house, this.compose(house, draft), []).map(keyName);
      const keys: KeysOutcome = { choice: options.keys ?? null, kept: after, dropped: before.filter(name => !after.includes(name)) };
      const failures: string[] = [];
      // Its own setup's revision: the bot's when it drafted that setup, the owner's when only their drop changed it.
      if (own) await this.deps.capabilities.recorded(houseName, own.name, currentOwn, draft.own ? { kind: "pet", pet: draft.pet } : { kind: "owner" }).catch(error => failures.push(`its own setup's revision was not recorded (${(error as Error).message})`));
      let live = true;
      await this.deps.applied().catch(error => { live = false; failures.unshift((error as Error).message); });
      const mine = routineFor(definition, capabilities, draft.pet);
      this.settle(houseName, draft, mine ? "Applied: runs without asking for its bot." : "Applied.");
      this.deps.send?.(houseName, draft.pet, `Household: your human applied your draft of scout ${draft.scout}${current ? " (a change to it)" : ""}. ${mine ? "It is routine for you: its runs start without Run." : `Every run of it waits for your human's Run${draft.wantsRoutine ? "; they did not make it routine for you" : ""}.`} ${live ? "It is in your scouts list from your next message." : "It reaches your scouts list once Household reloads its config."} This is an internal notice, not a message from your human.`);
      if (failures.length) throw new AppliedNotLiveError(live ? `applied; ${failures.join("; ")}` : `applied, not yet live: ${failures.join("; ")}`);
      // With drop, a shared capability's keys at stake still go along: said, not left to be noticed.
      return { scout: draft.scout, routine: definition.routine ?? [], keys: { ...keys, ...(options.keys === "drop" && shared.length ? { sharedStay: shared.map(draftKeyWords) } : {}) } };
    });
  }
  /** The owner declines a draft: it goes, and its bot is told. */
  discard(houseName: string, id: string) {
    return this.serial(async () => {
      const house = await this.house(houseName), draft = this.standing(house).find(each => each.id === id);
      if (!draft) throw new NotFoundError("unknown draft");
      this.setDrafts(houseName, this.stored(houseName).filter(each => each.id !== id));
      this.settle(houseName, draft, "Declined.");
      this.deps.send?.(houseName, draft.pet, `Household: your human declined your draft of scout ${draft.scout}. Nothing changed. This is an internal notice, not a message from your human.`);
    });
  }
}

/**
 * Who may draft capabilities and scouts: a bot of a workspace with scouts on. Never a scout or a sideworker: they work
 * on a task with what it was given, and propose no standing access.
 */
export function mayDraft(houses: () => readonly House[] | undefined, isScout: (caller: PetIdentity) => boolean): (caller: PetIdentity) => boolean {
  return caller => !isScout(caller) && !!houses()?.some(house => house.name === caller.house && houseFeatures(house).scouts && house.pets.some(pet => pet.name === caller.pet && !pet.scout && !pet.sideworker));
}

/** A bot's tool to propose a scout. Applying it is the owner's, in the admin. */
export function scoutDraftTools(drafts: ScoutDrafts, enabled: (caller: PetIdentity) => boolean): McpTool<PetIdentity>[] {
  const network = { type: "object", properties: { any: { type: "boolean" }, allow: { type: "array", items: { type: "string" } } }, required: ["any"], additionalProperties: false };
  return [{
    name: "scout_draft",
    description: "Propose a scout, or a change to one (same name), when no scout fits a task that will recur or needs access you should not hold. Read household-scouts (Drafting a scout) first. name; title, emoji; description (when a bot should call it); instructions (how it does its task); capabilities (names of shared ones, from the capabilities tool); setup: its own install script, network ({any:true} or {any:false, allow:[\"host\",\"host:port\"]}: where it may go while it works), install_hosts (where its install script downloads from, open only while install scripts run) and needs_keys (environment variable NAMES your human supplies, never values), as in capability_draft; routine: true to ask that you may run it without asking (low-stakes errands on exact hosts only); reason: one or two lines for your human, why this scout and this access and the worst it could do. Your human reviews and applies it; nothing changes until then, and you are told the outcome. At most 6 drafts in 10 minutes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "description", "instructions", "reason"], properties: {
      name: { type: "string" }, title: { type: "string" }, emoji: { type: "string" }, description: { type: "string" }, instructions: { type: "string" },
      capabilities: { type: "array", items: { type: "string" } },
      setup: { type: "object", additionalProperties: false, properties: { install: { type: "string" }, network, install_hosts: { type: "array", items: { type: "string" } }, needs_keys: { type: "array", items: { type: "string" } } } },
      routine: { type: "boolean" }, reason: { type: "string" },
    } },
    available: enabled,
    async call(caller, args) { return JSON.stringify(await drafts.draft(caller, args)); },
  }];
}
