import type { SlackConnectionView, SlackConnectorsView } from "../src/core/slack-connectors";
export type { SlackConnectionView, SlackConnectorsView };
import type { GoogleConnectorsView, GoogleConnectionView, GoogleService } from "../src/core/google-connectors";
export type { GoogleConnectorsView, GoogleConnectionView, GoogleService };
import type { HouseInbox as WorkspaceInbox, InboxView } from "../src/core/house-inboxes";
export type { WorkspaceInbox, InboxView };
export interface PreviewView { id: string; house: string; pet: string; port: number; title: string; status: "pending" | "opening" | "active"; url?: string; expires_at?: string; requested_at: string }
import type { HouseFeatures as WorkspaceFeatures, PreviewSettings } from "../src/core/house-features";
import type { PetLifecycle as BotLifecycle } from "../src/core/lifecycle";
import type { SideworkerRecord } from "../src/app/sideworkers";
import type { SideworkerLimits, SideworkerProfile } from "../src/core/household";
import type { MetricSample, MetricsView } from "../src/core/metrics";
import type { LogKind, LogLine, LogPage } from "../src/app/household-log";
import type { PetLogSource as BotLogSource, PetLogView as BotLogView } from "../src/app/pet-logs";
export type { LogKind, LogLine, LogPage, BotLogSource, BotLogView };
import type { InstructionFile } from "../src/infra/pet-instructions";
export type { InstructionFile };
import type { MemoryEntry, MemoryPage, MemorySummary } from "../src/core/memory";
export type { MemoryEntry, MemoryPage, MemorySummary };
import type { CronFields, CronJob, CronView } from "../src/core/cron";
export type { CronFields, CronJob, CronView };
import type { BuiltinSkill, SkillEntry, SkillFile } from "../src/infra/house-skills";
export type { BuiltinSkill, SkillEntry, SkillFile };
import type { EnvironmentView } from "../src/app/environment";
import type { EnvironmentSetupResult } from "../src/infra/environment-setup";
export type { EnvironmentView };
// The web UI's only way to the daemon: its JSON API. The types are the server's (type-only: nothing of it is bundled).
import type { AgentModelsView as HarnessModelsView, AgentView as HarnessView, AllowView, ChannelKindView, ChannelView, HouseView as WorkspaceView, KeysView, KeyView, MeView, OwnerView, PetView as BotView, PlatformView, SecretView, WriteView } from "../src/app/web-views";

export type { HarnessModelsView, HarnessView, AllowView, ChannelKindView, ChannelView, WorkspaceView, KeysView, KeyView, MeView, OwnerView, BotView, PlatformView, SecretView, WriteView };

/**
 * A channel as the forms send it: its chat (when it is added), its kind's own fields (by the kind's keys), and
 * the fields every channel has (`name` and `default` null for none).
 */
export interface ChannelFields {
  slackMember?: string;
  /** Its chat: only when it is added (it names the channel). */
  chat?: string;
  own: Record<string, string>;
  name: string | null;
  /** The owner's own words about it; null for none. */
  note: string | null;
  pets: string[];
  default: string | null;
}

/** A pet's settings as the forms send them: `title` null for its name's. */
export interface BotFields {
  cpus?: number | null;
  memoryMiB?: number | null;
  enabled?: boolean;
  title: string | null;
  /** One emoji; null for the default. */
  emoji: string | null;
  aliases: string[];
  agent: string;
  model: string;
  /** Null leaves the native model default unchanged. */
  reasoningEffort?: string | null;
  /** One of its agent's permission modes; null for an agent without modes. */
  mode: string | null;
  /** Its agent's own settings (`HarnessView.settings`): null for a setting's Default; left out: untouched. */
  settings?: Record<string, string | null> | null;
  /** The key it runs on; null for the only one that fits. */
  key: string | null;
  /** Its scheduled restarts; null removes them. */
  lifecycle?: BotLifecycle | null;
}

/** A key as the forms send it: `note` null for none. */
export interface KeyFields {
  provider: string;
  value: string;
  note: string | null;
  /** null: every house. */
  houses: string[] | null;
  /** A subscription's: go on past its allowance, billed apart; left out: untouched. */
  allowOverage?: boolean;
}

/** An owner's secret as its form sends it. */
export interface SecretFields {
  onlyForCapabilities?: string[] | null;
  value: string;
  hosts: string[];
  header: string | null;
  env: string;
  note: string | null;
}

/** The session is gone (expired, signed out elsewhere, never was). */
export class SignedOut extends Error {}

/** A write the daemon saved in household.yaml but could not apply (its log says why): done, with a warning. */
export class NotApplied extends Error {}

let onSignedOut = () => {};

/** Called whenever the API answers 401, so the app can show the sign-in screen. */
export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler;
}

export async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    onSignedOut();
    throw new SignedOut("not signed in");
  }
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const error = (data as { error?: string } | undefined)?.error ?? `the daemon answered ${response.status}`;
  if (response.status === 500 && error.startsWith("saved in household.yaml")) throw new NotApplied(error);
  if (!response.ok) throw new Error(error);
  return data as T;
}

const housePath = (name: string) => `/api/houses/${encodeURIComponent(name)}`;
const under = (house: string, what: string, id: string) => `${housePath(house)}/${what}/${encodeURIComponent(id)}`;

export const api = {
  sideworkers: (house: string) => call<SideworkerRecord[]>("GET", `${housePath(house)}/sideworkers`),
  closeSideworker: (house: string, name: string) => call<void>("DELETE", `${housePath(house)}/sideworkers/${encodeURIComponent(name)}`),
  previews: (house: string, pet: string) => call<PreviewView[]>("GET", `${housePath(house)}/pets/${encodeURIComponent(pet)}/previews`),
  closePreview: (house: string, pet: string, id: string) => call<{ ok: boolean }>("DELETE", `${housePath(house)}/pets/${encodeURIComponent(pet)}/previews/${encodeURIComponent(id)}`),
  setWorkspaceFeatures: (house: string, settings: { features: WorkspaceFeatures; preview: PreviewSettings }) => call<WriteView>("PUT", `${housePath(house)}/features`, settings),
  setSideworkerProfiles: (house: string, profiles: SideworkerProfile[]) => call<WriteView>("PUT", `${housePath(house)}/sideworker-profiles`, { profiles }),
  setSideworkerLimits: (house: string, limits: SideworkerLimits) => call<WriteView>("PUT", `${housePath(house)}/sideworker-limits`, limits),
  instructions: (house: string, pet: string) => call<InstructionFile>("GET", `${under(house, "pets", pet)}/instructions`),
  saveInstructions: (house: string, pet: string, content: string, revision: string) => call<InstructionFile>("PUT", `${under(house, "pets", pet)}/instructions`, {content, revision}),
  timezone: () => call<{timezone:string}>("GET", "/api/timezone"),
  setTimezone: (timezone:string) => call<{timezone:string}>("PUT", "/api/timezone",{timezone}),
  memories: (house: string, pet: string, options: {query?:string;deleted?:boolean;after?:string} = {}) => {
    const q=new URLSearchParams(); if(options.query)q.set("query",options.query); if(options.deleted)q.set("deleted","true"); if(options.after)q.set("after",options.after);
    return call<MemoryPage>("GET", `${under(house,"pets",pet)}/memory?${q}`);
  },
  memory: (house:string,pet:string,key:string)=>call<MemoryEntry>("GET",`${under(house,"pets",pet)}/memory/${encodeURIComponent(key)}`),
  saveMemory: (house:string,pet:string,key:string,value:string,revision:number)=>call<MemoryEntry>("PUT",`${under(house,"pets",pet)}/memory`,{key,value,revision}),
  deleteMemory: (house:string,pet:string,key:string,revision:number)=>call<MemoryEntry>("DELETE",`${under(house,"pets",pet)}/memory`,{key,revision}),
  memoryHistory: (house:string,pet:string,key:string,before?:number)=>call<MemoryEntry[]>("GET",`${under(house,"pets",pet)}/memory/${encodeURIComponent(key)}/history${before===undefined?"":`?before=${before}`}`),
  crons: (house: string, pet: string) => call<CronView>("GET", `${under(house, "pets", pet)}/crons`),
  createCron: (house: string, pet: string, fields: CronFields) => call<CronJob>("POST", `${under(house, "pets", pet)}/crons`, fields),
  updateCron: (house: string, pet: string, id: string, revision: number, fields: CronFields) => call<CronJob>("PUT", `${under(house, "pets", pet)}/crons/${encodeURIComponent(id)}`, {...fields, revision}),
  deleteCron: (house: string, pet: string, id: string, revision: number) => call<CronJob>("DELETE", `${under(house, "pets", pet)}/crons/${encodeURIComponent(id)}`, {revision}),
  petSkills: (house: string, pet: string) => call<{ path: string; entries: SkillEntry[] }>("GET", `${under(house, "pets", pet)}/skills`),
  petSkillFile: (house: string, pet: string, path: string) => call<SkillFile>("GET", `${under(house, "pets", pet)}/skills/file?path=${encodeURIComponent(path)}`),
  saveBotSkillFile: (house: string, pet: string, path: string, content: string, revision: string | null) => call<SkillFile>("PUT", `${under(house, "pets", pet)}/skills/file`, { path, content, revision }),
  deleteBotSkillFile: (house: string, pet: string, path: string, revision: string) => call<void>("DELETE", `${under(house, "pets", pet)}/skills/file`, { path, revision }),
  skills: (house: string) => call<SkillEntry[]>("GET", `${housePath(house)}/skills`),
  builtinSkills: () => call<BuiltinSkill[]>("GET", "/api/builtin-skills"),
  skillFile: (house: string, path: string) => call<SkillFile>("GET", `${housePath(house)}/skills/file?path=${encodeURIComponent(path)}`),
  saveSkillFile: (house: string, path: string, content: string, revision: string | null) => call<SkillFile>("PUT", `${housePath(house)}/skills/file`, { path, content, revision }),
  deleteSkillFile: (house: string, path: string, revision: string) => call<void>("DELETE", `${housePath(house)}/skills/file`, { path, revision }),
  terminal: (house: string, pet: string, signal?: AbortSignal) => call<{ text: string }>("GET", `${under(house, "pets", pet)}/terminal`, undefined, signal),
  /** The Household log: the last lines that fit, or with `after` what came since. */
  logs: (query: { house?: string; pet?: string; kinds?: LogKind[]; problems?: boolean; q?: string; after?: string; limit?: number }, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== "" && value !== false) params.set(name, Array.isArray(value) ? value.join(",") : String(value));
    return call<LogPage>("GET", `/api/logs?${params}`, undefined, signal);
  },
  petLog: (house: string, pet: string, source: BotLogSource, read: { lines?: number; after?: string }, signal?: AbortSignal) =>
    call<BotLogView>("GET", `${under(house, "pets", pet)}/logs?source=${source}${read.after === undefined ? `&lines=${read.lines ?? 300}` : `&after=${encodeURIComponent(read.after)}`}`, undefined, signal),
  houseMetrics: (house: string) => call<Record<string, MetricSample | null>>("GET", `${housePath(house)}/metrics`),
  metrics: (house: string, pet: string, range: "1h" | "24h" | "7d") => call<MetricsView>("GET", `${under(house, "pets", pet)}/metrics?range=${range}`),
  environment: (house: string, pet: string) => call<EnvironmentView>("GET", `${under(house, "pets", pet)}/environment`),
  updateEnvironment: (house: string, pet: string, fields: { setup?: string | null; onStart?: string | null }) => call<EnvironmentView>("PATCH", `${under(house, "pets", pet)}/environment`, fields),
  disableBot: (house: string, pet: string, mode: "now" | "notify") => call<void>("POST", `${under(house, "pets", pet)}/disable`, { mode }),
  restartEnvironment: (house: string, pet: string, mode: "now" | "notify" = "now") => call<void>("POST", `${under(house, "pets", pet)}/environment/restart`, { mode }),
  runEnvironment: (house: string, pet: string, phase: "setup" | "onStart" = "setup") => call<EnvironmentSetupResult>("POST", `${under(house, "pets", pet)}/environment/run`, { phase }),
  agentModels: (agent: string, key: string) => call<HarnessModelsView>("GET", `/api/agents/${encodeURIComponent(agent)}/models?key=${encodeURIComponent(key)}`),
  me: () => call<MeView>("GET", "/api/me"),
  houses: () => call<WorkspaceView[]>("GET", "/api/houses"),
  createWorkspace: (name: string) => call<WriteView>("POST", "/api/houses", { name }),
  deleteWorkspace: (name: string) => call<WriteView>("DELETE", housePath(name)),
  // One host at a time, so a tab showing an old list cannot undo what another changed.
  allowHost: (name: string, host: string) => call<WriteView>("POST", `${housePath(name)}/allow`, { host }),
  allowHosts: (name: string, hosts: readonly string[]) => call<WriteView>("POST", `${housePath(name)}/allow/bulk`, { hosts }),
  disallowHost: (name: string, host: string) => call<WriteView>("DELETE", `${housePath(name)}/allow/${encodeURIComponent(host)}`),
  revokeTemporary: (name: string, pet: string, domain: string, port = 443) => call<WriteView>("DELETE", `${housePath(name)}/temporary/${encodeURIComponent(domain)}?port=${port}&pet=${encodeURIComponent(pet)}`),
  authorizeSlack: (house: string, pets: string[], allowWrite = false) => call<{ url: string }>("POST", `${housePath(house)}/connectors/slack/authorize`, { pets, allowWrite }),
  slackConnections: (house: string) => call<SlackConnectorsView>("GET", `${housePath(house)}/connectors/slack`),
  completeSlack: (house: string, url: string) => call<{ ok: boolean }>("POST", `${housePath(house)}/connectors/slack/complete`, { url }),
  connectSlack: (house: string, token: string, pets: string[], allowWrite = false) => call<SlackConnectionView>("POST", `${housePath(house)}/connectors/slack/connect`, { token, pets, allowWrite }),
  shareSlack: (house: string, id: string, pets: string[]) => call<SlackConnectionView>("PATCH", `${housePath(house)}/connectors/slack/${encodeURIComponent(id)}`, { pets }),
  disconnectSlack: (house: string, id: string) => call<{ ok: boolean }>("DELETE", `${housePath(house)}/connectors/slack/${encodeURIComponent(id)}`),
  googleConnections: (house: string) => call<GoogleConnectorsView>("GET", `${housePath(house)}/connectors/google`),
  connectGoogle: (house: string, services: GoogleService[], pets: string[], write: boolean) => call<{ url: string }>("POST", `${housePath(house)}/connectors/google/connect`, { services, pets, write }),
  shareGoogle: (house: string, id: string, pets: string[]) => call<GoogleConnectionView>("PATCH", `${housePath(house)}/connectors/google/${encodeURIComponent(id)}`, { pets }),
  disconnectGoogle: (house: string, id: string) => call<{ ok: boolean }>("DELETE", `${housePath(house)}/connectors/google/${encodeURIComponent(id)}`),
  inboxes: (house: string) => call<InboxView[]>("GET", `${housePath(house)}/inboxes`),
  testInbox: (house: string, inbox: WorkspaceInbox) => call<{ count: number; message: string }>("POST", `${housePath(house)}/inboxes/test`, inbox),
  addInbox: (house: string, inbox: WorkspaceInbox) => call<WriteView>("POST", `${housePath(house)}/inboxes`, inbox),
  updateInbox: (house: string, inbox: WorkspaceInbox) => call<WriteView>("PUT", under(house, "inboxes", inbox.name), inbox),
  subscribeInbox: (house: string, name: string, pet: string, subscriber: { subscribed: boolean; quiet: boolean }) => call<WriteView>("PUT", `${under(house, "inboxes", name)}/subscribers/${encodeURIComponent(pet)}`, subscriber),
  removeInbox: (house: string, name: string) => call<WriteView>("DELETE", under(house, "inboxes", name)),
  pollInbox: (house: string, name: string) => call<InboxView>("POST", `${under(house, "inboxes", name)}/poll`),
  resolveSlack: (house: string, token: string, appToken: string, member: string) => call<{ chat: string; owner: string; url: string }>("POST", `${housePath(house)}/slack/resolve`, { token, appToken, member }),
  addChannel: (house: string, kind: string, { own, ...common }: ChannelFields) => call<WriteView>("POST", `${housePath(house)}/channels`, { kind, ...own, ...common }),
  updateChannel: (house: string, chat: string, { own, ...common }: ChannelFields) => call<WriteView>("PATCH", under(house, "channels", chat), { ...own, ...common }),
  /** Who is in a channel and who gets what is addressed to none, the rest of it as it is. */
  placeBots: (house: string, chat: string, pets: string[], first: string | null) => call<WriteView>("PATCH", under(house, "channels", chat), { pets, default: first }),
  removeChannel: (house: string, chat: string) => call<WriteView>("DELETE", under(house, "channels", chat)),
  addOwner: (house: string, platform: string, id: string, note?: string | null) => call<WriteView>("POST", `${housePath(house)}/owners`, { platform, id, note }),
  updateOwner: (house: string, platform: string, id: string, note: string | null) => call<WriteView>("PATCH", `${under(house, "owners", platform)}/${encodeURIComponent(id)}`, { note }),
  removeOwner: (house: string, platform: string, id: string) => call<WriteView>("DELETE", `${under(house, "owners", platform)}/${encodeURIComponent(id)}`),
  /** A new pet, in the house's channels of `channels` (their chats) from the start. */
  addBot: (house: string, name: string, pet: BotFields, channels: string[] = []) => call<WriteView>("POST", `${housePath(house)}/pets`, { name, ...pet, channels }),
  updateBot: (house: string, name: string, pet: Partial<BotFields>) => call<WriteView>("PATCH", under(house, "pets", name), pet),
  removeBot: (house: string, name: string) => call<WriteView>("DELETE", under(house, "pets", name)),
  keys: () => call<KeyView[]>("GET", "/api/keys"),
  addKey: (name: string, key: KeyFields) => call<KeysView>("POST", "/api/keys", { name, ...key }),
  updateKey: (name: string, key: KeyFields) => call<KeysView>("PATCH", `/api/keys/${encodeURIComponent(name)}`, key),
  removeKey: (name: string) => call<KeysView>("DELETE", `/api/keys/${encodeURIComponent(name)}`),
  secrets: (house: string) => call<SecretView[]>("GET", `/api/houses/${encodeURIComponent(house)}/secrets`),
  addSecret: (house: string, name: string, secret: SecretFields) => call<{ secrets: SecretView[] }>("POST", `/api/houses/${encodeURIComponent(house)}/secrets`, { name, ...secret }),
  updateSecret: (house: string, name: string, secret: Partial<SecretFields>) => call<{ secrets: SecretView[] }>("PATCH", `/api/houses/${encodeURIComponent(house)}/secrets/${encodeURIComponent(name)}`, secret),
  removeSecret: (house: string, name: string) => call<{ secrets: SecretView[] }>("DELETE", `/api/houses/${encodeURIComponent(house)}/secrets/${encodeURIComponent(name)}`),
  signOut: () => call<void>("POST", "/api/logout"),
};
