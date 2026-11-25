import { call, type SkillEntry, type SkillFile } from "./api";
import type { ScoutAgent as ScoutHarness, ScoutDefinition, ScoutLimits } from "../src/core/scouts";
export type { ScoutHarness, ScoutDefinition, ScoutLimits };

/** Owner views only. These are never returned through a harness tool. */
export interface ScoutRunView {
  id: string;
  scout: string;
  /** The blueprint it was called from; absent when its bot assembled it. */
  blueprint?: string;
  capabilities: string[];
  parent: string;
  task: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: string;
  threadUrl?: string;
  report?: string;
  /** It started without a Run card: its scout is routine for the bot that called it. */
  routine?: boolean;
}
/** A scout as the admin shows it: its definition, its network as its capabilities make it, keys in its VM, problems. */
export interface ScoutView extends ScoutDefinition {
  /** Its own capability, if it has one (seen and used nowhere else). */
  own: CapabilityView | null;
  network: { open: boolean; allow: string[]; limitedBy: string[] };
  keysInVm: { capability: string; env: string }[];
  problems: string[];
  /** Why its bots cannot run it without asking (open network, a wildcard host); null when they can. */
  routineBlocker?: string | null;
}
export interface CapabilityTestView { at: number; ok: boolean; seconds: number; output: string }
/** A capability's definition (hosts as text) and what the admin shows about it. */
export interface CapabilityView {
  name: string;
  description: string;
  install: string;
  network: { any: boolean; allow: string[] };
  keys: ({ secret: string; via: "gateway" } | { secret: string; via: "vm"; env: string })[];
  kind: "tool" | "access";
  usedBy: string[];
  keyVariables: { secret: string; via: "gateway" | "vm"; env: string }[];
  lastTest: CapabilityTestView | null;
  testing: boolean;
  revisions: number;
  /** The scout it belongs to, for a scout's own setup. */
  owner?: string;
  /** That blueprint's title (its name when it has none). */
  ownerTitle?: string;
  /** Routine scouts it backs, and the bots that run each without asking. */
  routineScouts?: { name: string; title: string; bots: string[] }[];
}
export type CapabilityInput = Pick<CapabilityView, "name" | "description" | "install" | "network">;
export interface CapabilityRevisionView {
  rev: number;
  at: number;
  author: { kind: "owner" } | { kind: "pet"; pet: string };
  summary: string;
  definition: CapabilityInput & { keys: CapabilityView["keys"] };
  from?: { capability: string; rev: number };
}
export interface CapabilityDraftView {
  id: string;
  capability: string;
  pet: string;
  at: number;
  definition: CapabilityInput;
  needsKeys: string[];
}
export interface CapabilityTemplate extends CapabilityInput { label: string }
/** A bot's scout draft as lists show it: who proposed it, new or a change, when, stale, whether it asks to run without asking. */
export interface ScoutDraftSummary { id: string; scout: string; pet: string; petTitle: string; at: number; change: boolean; stale: boolean; wantsRoutine: boolean }
/** A key the drafted scout would carry: its variable, where it comes from, how it is delivered. */
export interface ScoutDraftKey { env: string | null; secret: string; source: string; via: "gateway" | "vm"; keptWith?: ("install" | "network")[] }
type DraftNetwork = { open: boolean; allow: string[]; limitedBy: string[] };
/** Everything the owner's review of a scout draft needs (`GET scout-drafts/:id`). */
export interface ScoutDraftView extends ScoutDraftSummary {
  /** The bot's words for the owner: why this scout, why this access. */
  reason: string;
  /** What it was made against changed since: these fields. Applying it would undo them. */
  changedSince: string[];
  /** The scout it would be (never with a routine list: that is the owner's, given on apply). */
  definition: ScoutDefinition;
  /** Its own setup as proposed; null: its own setup stays as it is (or it has none). */
  own: CapabilityInput | null;
  /** For a change: the scout and its own setup as they are now. */
  current: ScoutDefinition | null;
  currentOwn: (CapabilityInput & { keys: CapabilityView["keys"] }) | null;
  /** Every key the result carries. */
  keys: ScoutDraftKey[];
  ownChanges: ("install" | "network")[];
  /** Said wherever keys are listed when one is inside its VM: where such a key can go, and what no check covers. */
  vmKeyNote: string | null;
  /** Keys in its VM this change puts at stake, and why; applying needs the owner's choice. */
  keyGate: { keys: ScoutDraftKey[]; reasons: string[]; choices: ("keep" | "drop")[] } | null;
  /** Variables still to be provided, by name. */
  needsKeys: string[];
  network: DraftNetwork;
  currentNetwork: DraftNetwork | null;
  routineBlocker: string | null;
  problems: string[];
  /** The shared capabilities it ticks, as the owner has them: their hosts (null: any) and whether they install something. */
  shared: { name: string; description: string; hosts: string[] | null; installs: boolean }[];
  /** The fingerprint of what the owner decides on: sent back with apply, which refuses when it moved since. */
  reviewed: string;
}
/** The owner's word on applying a draft: who runs it without asking, the keys at stake, and applying over changes since. */
export interface ScoutDraftApply { reviewed: string; routine?: string[]; keys?: "keep" | "drop"; force?: true }
export interface ScoutDraftApplied { scout: string; routine: string[]; keys: { choice: "keep" | "drop" | null; kept: string[]; dropped: string[]; sharedStay?: string[] } }
export interface ScoutListView {
  scouts: ScoutView[];
  capabilities: CapabilityView[];
  runs: ScoutRunView[];
  limits: ScoutLimits;
  /** The workspace's harness: scouts that set none of their own run on it. */
  agent: ScoutHarness | null;
  /** Scouts bots proposed, waiting for review. */
  drafts?: ScoutDraftSummary[];
}
export interface ScoutDetailView {
  scout: ScoutView;
  capabilities: CapabilityView[];
  runs: ScoutRunView[];
  /** The workspace's harness and resources: what it runs on unless it sets its own. */
  defaults: { agent: ScoutHarness | null; limits: ScoutLimits };
  /** Drafts of a change to it, waiting for review. */
  drafts?: ScoutDraftSummary[];
}
export interface CapabilityDetailView {
  capability: CapabilityView;
  history: CapabilityRevisionView[];
  drafts: CapabilityDraftView[];
}
export interface ScoutDocument {
  content: string;
  revision: string;
}
/** A key added on a capability: a new secret restricted to it, in its workspace. */
export interface CapabilityKeyInput {
  secret: string;
  value: string;
  hosts: string[];
  via: "gateway" | "vm";
  env: string;
  header?: string | null;
}
const base = (house: string) => `/api/houses/${encodeURIComponent(house)}`;
const at = (house: string, name: string) => `${base(house)}/scouts/${encodeURIComponent(name)}`;
const cap = (house: string, name: string) => `${base(house)}/capabilities/${encodeURIComponent(name)}`;
type ScoutFields = Omit<ScoutDefinition, never>;
export const scoutApi = {
  list: (h: string) => call<ScoutListView>("GET", `${base(h)}/scouts`),
  detail: (h: string, name: string) => call<ScoutDetailView>("GET", at(h, name)),
  create: (h: string, value: ScoutFields) => call<void>("POST", `${base(h)}/scouts`, value),
  /** Optional fields set to undefined are cleared (sent as null). */
  update: (h: string, name: string, value: Partial<ScoutFields>) =>
    call<void>("PATCH", at(h, name), {
      ...value,
      ...Object.fromEntries(["title", "emoji", "workspace", "agent", "resources", "routine"]
        .filter(key => Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === undefined)
        .map(key => [key, null])),
    }),
  remove: (h: string, name: string) => call<void>("DELETE", at(h, name)),
  stop: (h: string, id: string) => call<void>("DELETE", `${base(h)}/scout-runs/${encodeURIComponent(id)}`),
  document: (h: string, name: string) => call<ScoutDocument>("GET", `${at(h, name)}/instructions`),
  saveDocument: (h: string, name: string, value: ScoutDocument) => call<ScoutDocument>("PUT", `${at(h, name)}/instructions`, value),
  /** A scout's own setup (its own capability), created empty; it is edited on its capability page. */
  createOwn: (h: string, name: string) => call<void>("POST", `${at(h, name)}/own`),
  agent: (h: string) => call<ScoutHarness | null>("GET", `${base(h)}/scout-agent`),
  setHarness: (h: string, value: ScoutHarness) => call<ScoutHarness>("PUT", `${base(h)}/scout-agent`, value),
  setLimits: (h: string, value: ScoutLimits) => call<ScoutLimits>("PUT", `${base(h)}/scout-limits`, value),
};
const draft = (house: string, id: string) => `${base(house)}/scout-drafts/${encodeURIComponent(id)}`;
export const scoutDraftApi = {
  view: (h: string, id: string) => call<ScoutDraftView>("GET", draft(h, id)),
  /** Always with the fingerprint of the view the owner decided on; nothing else when they chose nothing (every run asks). */
  apply: (h: string, id: string, body: ScoutDraftApply) => call<ScoutDraftApplied>("POST", `${draft(h, id)}/apply`, body),
  decline: (h: string, id: string) => call<void>("DELETE", draft(h, id)),
};
export const capabilityApi = {
  list: (h: string) => call<{ capabilities: CapabilityView[]; drafts: CapabilityDraftView[] }>("GET", `${base(h)}/capabilities`),
  templates: (h: string) => call<CapabilityTemplate[]>("GET", `${base(h)}/capability-templates`),
  detail: (h: string, name: string) => call<CapabilityDetailView>("GET", cap(h, name)),
  create: (h: string, value: CapabilityInput) => call<CapabilityRevisionView>("POST", `${base(h)}/capabilities`, value),
  save: (h: string, value: CapabilityInput) => call<CapabilityRevisionView>("PUT", cap(h, value.name), value),
  remove: (h: string, name: string) => call<void>("DELETE", cap(h, name)),
  restore: (h: string, name: string, rev: number) => call<CapabilityRevisionView>("POST", `${cap(h, name)}/restore`, { rev }),
  duplicate: (h: string, name: string, as: string) => call<CapabilityRevisionView>("POST", `${cap(h, name)}/duplicate`, { as }),
  test: (h: string, name: string) => call<CapabilityTestView>("POST", `${cap(h, name)}/test`),
  addKey: (h: string, name: string, key: CapabilityKeyInput) => call<void>("POST", `${cap(h, name)}/keys`, key),
  removeKey: (h: string, name: string, secret: string) => call<void>("DELETE", `${cap(h, name)}/keys/${encodeURIComponent(secret)}`),
  applyDraft: (h: string, id: string) => call<CapabilityRevisionView>("POST", `${base(h)}/capability-drafts/${encodeURIComponent(id)}/apply`),
  discardDraft: (h: string, id: string) => call<void>("DELETE", `${base(h)}/capability-drafts/${encodeURIComponent(id)}`),
  skills: (h: string, name: string) => call<SkillEntry[]>("GET", `${cap(h, name)}/skills`),
  skill: (h: string, name: string, path: string) => call<SkillFile>("GET", `${cap(h, name)}/skills/file?path=${encodeURIComponent(path)}`),
  saveSkill: (h: string, name: string, path: string, content: string, revision: string | null) => call<SkillFile>("PUT", `${cap(h, name)}/skills/file`, { path, content, revision }),
  deleteSkill: (h: string, name: string, path: string, revision: string) => call<void>("DELETE", `${cap(h, name)}/skills/file`, { path, revision }),
};
