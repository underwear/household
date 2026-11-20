import { assertWorkspaceCapacity, workspaceBudget, workspaceResourcesSchema, type ResourceAllocation } from "../core/resources";
import type { MessageRef } from "../core/channel";
import { channelKey, parsePlaceKey, petPlaceKey } from "../core/channels";
import { houseFeatures } from "../core/house-features";
import { agentOf, type Agents } from "./agents";
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Household, Pet } from "../core/household";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import type { McpTool } from "../infra/mcp-server";
import type { SideworkerWorktree } from "./sideworker-workspace";
import type { PostedNotice } from "./chat";
import { cardText, html } from "../core/card";

/** Resolved adapter settings captured at spawn; credential values never enter worker state. */
export interface SideworkerLaunch {
  agent: string;
  key: string;
  model: string;
  reasoningEffort?: string;
  mode?: string;
  settings?: Record<string, string>;
}

export interface SideworkerRecord {
  channel?: string;
  originPlace?: string;
  place?: string;
  placement?: "same" | "thread";
  house: string;
  name: string;
  parent: string;
  parentHome?: string;
  profile?: string;
  launch?: SideworkerLaunch;
  cwd: string;
  /** Its own git worktree (`cwd` is in it): the branch, from the parent's commit `base`. */
  worktree?: { branch: string; base: string };
  createdAt: number;
  cpus: number;
  memoryMiB: number;
  idleSince?: number;
  remindedAt?: number;
  /** Desired removal remains durable until VM reconciliation succeeds. */
  closing?: boolean;
  /** Household's notice in the parent's place that it was spawned (with a button to its thread): rewritten when it closes. */
  announcement?: PostedNotice;
  /**
   * Still starting: its task is not given yet (kept here so a Household restart meanwhile resumes the start).
   * `reused`: its name was used before, so its thread may hold an earlier worker's history and is never removed.
   */
  starting?: { task: string; reused?: boolean };
}
/** Stable across daemon restarts: the task is queued once and precedes startup follow-ups. */
export const sideworkerTaskRef = (worker: Pick<SideworkerRecord, "name" | "createdAt">) =>
  `sideworker-task:${worker.name}:${worker.createdAt}` as MessageRef;

export const SIDEWORKER_HOME = "/home/worker";
/** The notice in its parent's place while a worker's VM starts: posted at once, rewritten when it is up or failed. */
export function sideworkerStarting(worker: Pick<SideworkerRecord, "name" | "parent" | "cwd" | "worktree">): string {
  return cardText({ title: `⏳ Starting sideworker ⛏️ ${html(worker.name)}…`,
    facts: [`Started by: ${html(worker.parent)}`, `Folder: <code>${html(worker.cwd)}</code>`, ...(worker.worktree ? [`Branch: <code>${html(worker.worktree.branch)}</code>`] : [])],
    note: "Its VM is starting; this can take a few minutes. Its task goes to it once it is ready." });
}
/** The same notice when the worker did not come up: why, and that nothing of it runs. */
export function sideworkerFailed(worker: Pick<SideworkerRecord, "name">, reason: string): string {
  return cardText({ title: `❌ Sideworker ⛏️ ${html(worker.name)} did not start`, note: html(reason) });
}
/** The notice in its parent's place that a worker was spawned (a button to its thread goes under it). */
export function sideworkerSpawned(worker: Pick<SideworkerRecord, "name" | "parent" | "cwd" | "worktree">): string {
  return cardText({ title: `✅ Spawned new sideworker ⛏️ ${html(worker.name)}`,
    facts: [`Started by: ${html(worker.parent)}`, `Folder: <code>${html(worker.cwd)}</code>`, ...(worker.worktree ? [`Branch: <code>${html(worker.worktree.branch)}</code>`] : [])] });
}
/** The same notice once the worker is closed: its VM is gone; its thread and shared project files stay. */
export function sideworkerFinished(worker: Pick<SideworkerRecord, "name">): string {
  return cardText({ title: `⏹ Sideworker ⛏️ ${html(worker.name)} finished`, note: "Its VM is removed; its thread and the shared project files remain." });
}
export const SIDEWORKER_IDLE_MS = 30 * 60_000;
export const SIDEWORKER_STATE_KEY = "sideworkers.v1";
const STATE_KEY = SIDEWORKER_STATE_KEY;
export interface SideworkerDeps {
  otherAllocations?(house: string): ResourceAllocation[];
  place?(house: string, pet: string, place?: string): { channel: string; origin: string; publicOrigin: string };
  store: KeyValueStore;
  agents: Agents;
  /**
   * Captured before it is removed, run after: a notice in its thread says it stopped, and the thread stays. With
   * `remove` (a worker that never started) its thread goes instead.
   */
  prepareClosedNotice?(house: string, name: string, remove?: boolean): () => Promise<void>;
  /** A worker being spawned is told in its parent's place (`text`); resolves to that notice's handle. */
  announce?(worker: SideworkerRecord, text: string): Promise<PostedNotice | undefined>;
  /** The address of the worker's own thread, while it runs; undefined where there is none. */
  threadLink?(worker: SideworkerRecord): Promise<string | undefined>;
  /** The worker's notice (`announce`) says `text` now; with `link`, a button under it opens the worker's thread. */
  rewrite?(worker: SideworkerRecord, notice: PostedNotice, text: string, link?: string): Promise<void>;
  /** A name used again: the home kept from its earlier worker starts a new agent session, not the old one. */
  resetSession?(house: string, name: string, agent: string): Promise<void>;
  configured(): Promise<Household>;
  reload(): Promise<unknown>;
  resolveDirectory(house: string, pet: string, cwd: string): Promise<string | undefined>;
  /** A git worktree for the worker, made in the parent's VM; undefined when `cwd` is in no repository. */
  makeWorktree?(house: string, parent: string, cwd: string, name: string): Promise<SideworkerWorktree | undefined>;
  ready(house: string, pet: string): Promise<boolean>;
  /** Confirm the worker's destination exists before handing it any task. */
  ensurePlace?(house: string, pet: string): Promise<void>;
  dispatch(caller: PetIdentity, to: string, task: string, ref?: MessageRef): Promise<unknown>;
  releaseDelivery?(house: string, pet: string): void;
  pendingMessages?(house: string, pet: string): number;
  isIdle(house: string, pet: string): Promise<boolean>;
  send(house: string, pet: string, text: string): void;
  log(message: string): void;
  now?(): number;
}

/** Durable workers reuse the pet lifecycle and channel routing, without becoming editable config pets. */
export class Sideworkers {
  private records: SideworkerRecord[];
  private readonly usedNames: Set<string>;
  /** Which bot last used each name (`house/name`): a name goes to another bot only with a fresh home. */
  private readonly usedBy: Record<string, string>;
  private readonly closedNotices = new Map<string, () => Promise<void>>();
  /** Workers being spawned: their first start is no restart, and their task is still to come. */
  private readonly spawning = new Set<string>();
  /** The background start of each worker being spawned (never rejects). */
  private readonly starts = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly now: () => number;
  constructor(private readonly deps: SideworkerDeps) {
    this.records = JSON.parse(deps.store.get(STATE_KEY) ?? "[]");
    this.usedNames = new Set(JSON.parse(deps.store.get(`${STATE_KEY}.used-names`) ?? "[]"));
    this.usedBy = JSON.parse(deps.store.get(`${STATE_KEY}.used-by`) ?? "{}");
    this.now = deps.now ?? Date.now;
    // A start a restart cut off: no restart notice for it, its start is resumed (`start`).
    for (const worker of this.records) if (worker.starting && !worker.closing) this.spawning.add(`${worker.house}/${worker.name}`);
  }
  list(house: string): SideworkerRecord[] { return this.records.filter(item => item.house === house).map(item => structuredClone(item)); }
  allocations(house: string): ResourceAllocation[] { return this.list(house).map(w => ({ name: w.name, kind: "sideworker", cpus: w.cpus, memoryMiB: w.memoryMiB, state: w.closing ? "closing" : "allocated" })); }
  async resources(caller: PetIdentity) {
    const house = (await this.deps.configured()).houses.find(h => h.name === caller.house);
    if (!house) throw new Error("Unknown workspace");
    return workspaceBudget(house, [...this.allocations(house.name), ...this.deps.otherAllocations?.(house.name) ?? []]);
  }
  worker(house: string, name: string) { return this.records.find(item => item.house === house && item.name === name); }
  /**
   * What a worker is told when its VM started again after its spawn (a Household update or restart, a changed
   * launch): its session may be new, so it hears what happened and decides itself whether to go on. Nothing for a
   * worker still being spawned or closing, or for a bot that is no worker.
   */
  restartNotice(house: string, name: string): string | undefined {
    const worker = this.worker(house, name);
    if (!worker || worker.closing || this.spawning.has(`${house}/${name}`)) return undefined;
    return `Household: your VM was restarted (a Household update, a restart or a changed launch). Your agent session may be a new one, without your earlier conversation. Your home, your working directory ${worker.cwd} with its uncommitted changes, and your Docker data are as they were; running processes are not. Your task came from your parent ${worker.parent}: decide yourself whether to pick it up where it stopped, and tell your parent or your human if it matters. This is a notice, not a new task.`;
  }
  memoryOwner(house: string, pet: string) { return this.worker(house, pet)?.parent ?? pet; }
  private save() {
    this.deps.store.set(STATE_KEY, JSON.stringify(this.records));
    this.deps.store.set(`${STATE_KEY}.used-names`, JSON.stringify([...this.usedNames]));
    this.deps.store.set(`${STATE_KEY}.used-by`, JSON.stringify(this.usedBy));
  }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.catch(() => {});
    return result;
  }
  /** A removed parent removes its workers; a paused parent pauses them, preserving their conversations. */
  expanded(configured: Household): Household {
    const valid = this.records.filter(worker => configured.houses.some(house => house.name === worker.house && house.pets.some(pet => pet.name === worker.parent)));
    if (valid.length !== this.records.length) { this.records = valid; this.save(); }
    return { ...configured, houses: configured.houses.map(house => {
      const workers = this.list(house.name).filter(worker => !worker.closing);
      const pets: Pet[] = workers.map(worker => {
        const parent = house.pets.find(pet => pet.name === worker.parent)!;
        return { ...parent, ...(worker.launch ? { ...worker.launch, reasoningEffort: worker.launch.reasoningEffort, mode: worker.launch.mode, settings: worker.launch.settings } : {}),
          enabled: parent.enabled !== false && houseFeatures(house).sideworkers,
          originPlace: worker.originPlace,
          ...(worker.placement === "same" ? { chatPlace: worker.originPlace } : {}),
          name: worker.name, title: worker.name, emoji: "⛏️", aliases: [], cpus: worker.cpus, memoryMiB: worker.memoryMiB,
          sideworker: { parent: worker.parent, cwd: worker.cwd, ...(worker.parentHome ? { parentHome: worker.parentHome } : {}), ...(worker.worktree ? { branch: worker.worktree.branch } : {}) } };
      });
      return { ...house, pets: [...house.pets, ...pets], channels: house.channels.map(channel => ({ ...channel,
        pets: [...channel.pets, ...workers.filter(worker => channel.pets.includes(worker.parent) && channelKey(channel) === (worker.channel ?? parsePlaceKey(worker.announcement?.place)?.channel)).map(worker => worker.name)],
        // Adding a worker must never make an existing one-pet channel's default ambiguous.
        ...(channel.default || channel.pets.length !== 1 ? {} : { default: channel.pets[0] }),
      })) };
    }) };
  }
  private launch(config: Household, house: string, pet: Pet): { launch: SideworkerLaunch; home: string } {
    const found = agentOf(this.deps.agents, pet, config.keys, house);
    if ("problem" in found) throw new Error(found.problem);
    return { home: found.agent.home, launch: { agent: found.agent.name, key: found.key.name, model: found.model,
      ...(found.reasoningEffort === undefined ? {} : { reasoningEffort: found.reasoningEffort }), ...(found.mode === undefined ? {} : { mode: found.mode }), ...(found.settings ? { settings: { ...found.settings } } : {}) } };
  }
  async profiles(caller: PetIdentity) {
    const config = await this.deps.configured();
    const house = config.houses.find(item => item.name === caller.house);
    const parent = house?.pets.find(item => item.name === caller.pet);
    if (!house || !parent) throw new Error("Only configured bots may select sideworker profiles");
    return { inherited: this.launch(config, house.name, parent).launch,
      profiles: (house.sideworkerProfiles ?? []).map(profile => ({ name: profile.name, ...this.launch(config, house.name, profile).launch })) };
  }
  spawn(caller: PetIdentity, input: { cpus?: number; memoryMiB?: number; cwd: string; task: string; name?: string; profile?: string; worktree?: boolean; place?: string; placement?: "same" | "thread" }): Promise<SideworkerRecord> {
    if (input.place !== undefined && typeof input.place !== "string") return Promise.reject(new Error("place must be a place.id"));
    if (input.placement !== undefined && !["same", "thread"].includes(input.placement)) return Promise.reject(new Error("placement must be same or thread"));
    const destination = this.deps.place?.(caller.house, caller.pet, input.place);
    if (input.place !== undefined && !destination) return Promise.reject(new Error("Explicit place routing is unavailable"));
    return this.serial(async () => {
      const config = await this.deps.configured();
      const house = config.houses.find(item => item.name === caller.house);
      const parent = house?.pets.find(item => item.name === caller.pet);
      if (!house || !parent || parent.enabled === false) throw new Error("Only an enabled bot may spawn sideworkers");
      if (!houseFeatures(house).sideworkers) throw new Error("Sideworkers are disabled in this workspace. Ask your human to enable them in Workspace Settings.");
      if (input.profile !== undefined && (typeof input.profile !== "string" || !input.profile)) throw new Error("profile must name a configured workspace sideworker profile");
      const selected = input.profile === undefined ? parent : house.sideworkerProfiles?.find(profile => profile.name === input.profile);
      if (!selected) throw new Error(`Unknown sideworker profile '${input.profile}'; use sideworker_profiles`);
      const inherited = this.launch(config, house.name, parent);
      const parentHome = inherited.home;
      if (parentHome === SIDEWORKER_HOME) throw new Error("Parent home conflicts with the private worker home");
      const { launch } = this.launch(config, house.name, selected);
      // Pet-only settings follow the parent even when a profile selects another model/key.
      const adapter = this.deps.agents.get(launch.agent);
      for (const setting of adapter?.settings ?? []) {
        if (!setting.petOnly) continue;
        const value = parent.settings?.[setting.key];
        if (value !== undefined && inherited.launch.agent === launch.agent) (launch.settings ??= {})[setting.key] = value;
      }
      // The bot sizes each worker for its job: there is no workspace default to fall back on.
      if (input.cpus === undefined || input.memoryMiB === undefined) throw new Error("Choose cpus and memoryMiB for the sideworker's VM: workspace_resources shows what is free");
      const resources = workspaceResourcesSchema.parse({ cpus: input.cpus, memoryMiB: input.memoryMiB });
      assertWorkspaceCapacity(house, [...this.allocations(caller.house), ...this.deps.otherAllocations?.(caller.house) ?? []], resources);
      if (!house.channels.some(channel => channel.pets.includes(caller.pet))) throw new Error("Attach your bot to a channel before spawning a sideworker");
      if (typeof input.cwd !== "string" || !input.cwd.startsWith("/") || /[\x00-\x1f]/.test(input.cwd) || input.cwd.length > 4096) throw new Error("cwd must be an absolute guest directory path");
      const channels = house.channels.filter(channel => channel.pets.includes(caller.pet));
      const originChannel = destination?.channel ?? (channels.length === 1 ? channelKey(channels[0]!) : undefined);
      if (!originChannel || !channels.some(channel => channelKey(channel) === originChannel)) throw new Error("Choose an explicit place for this sideworker");
      const requestedCwd = posix.normalize(input.cwd);
      if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 32_000) throw new Error("task must contain 1–32000 characters");
      if (input.worktree !== undefined && typeof input.worktree !== "boolean") throw new Error("worktree must be true or false");
      const resolved = await this.deps.resolveDirectory(caller.house, caller.pet, requestedCwd);
      if (!resolved) throw new Error("cwd must resolve to an existing directory within the parent’s shared home; rootfs directories are not shared");
      const name = input.name ?? `sw-${randomBytes(4).toString("hex")}`;
      if (!/^sw-[a-z0-9][a-z0-9-]{0,27}$/.test(name)) throw new Error("name must start with sw- and contain lowercase letters, digits and hyphens (31 characters maximum)");
      const key = `${caller.house}/${name}`;
      if (this.spawning.has(key)) throw new Error(`Sideworker ${name} is still starting: Household tells you when it is up and has its task. Do not spawn it again.`);
      if (house.pets.some(pet => pet.name === name) || this.worker(caller.house, name)) throw new Error("This worker name is in use by a running sideworker or a bot; close it first or choose another name");
      // A name used before is fine for the bot that used it: its kept home gets a new session; its worktree and branch
      // are taken up again. Another bot's former worker home is never handed over, nor one whose bot is not known
      // (used before Household kept who used it).
      const reused = this.usedNames.has(key);
      const formerParent = this.usedBy[key];
      if (reused && formerParent !== caller.pet) throw new Error(formerParent === undefined
        ? `The name ${name} was used by an earlier sideworker whose bot is not known; choose another name`
        : `The name ${name} was used by ${formerParent}'s sideworker; choose another name`);
      // In a repository, by default, the worker gets its own checkout: its files, builds and bind-mounted data do not
      // meet its parent's (two VMs writing one database directory corrupt it). Outside one, it shares the directory.
      const worktree = input.worktree === false ? undefined : await this.deps.makeWorktree?.(caller.house, caller.pet, resolved, name);
      const worktreeCwd = worktree && await this.deps.resolveDirectory(caller.house, caller.pet, worktree.cwd);
      if (worktree && (!worktreeCwd || !(worktreeCwd === parentHome || worktreeCwd.startsWith(`${parentHome}/`)))) {
        throw new Error("The git worktree resolves outside the parent's shared home; keep the repository and .worktrees directory inside it, or use worktree: false.");
      }
      const cwd = worktreeCwd ?? resolved;
      const record: SideworkerRecord = { channel: originChannel, originPlace: destination?.origin ?? petPlaceKey(caller.pet, originChannel), placement: input.placement ?? "thread", ...(destination ? { place: input.placement === "same" ? destination.publicOrigin : petPlaceKey(name, parsePlaceKey(destination.publicOrigin)!.channel) } : {}), house: caller.house, name, parent: caller.pet, parentHome, ...(input.profile === undefined ? {} : { profile: input.profile }), launch, cwd, ...(worktree ? { worktree: { branch: worktree.branch, base: worktree.base } } : {}), createdAt: this.now(), ...resources };
      if (reused) await this.deps.resetSession?.(caller.house, name, launch.agent);
      const latest = (await this.deps.configured()).houses.find(h => h.name === caller.house);
      if (!latest) throw new Error("Workspace was removed");
      // Check and publish synchronously, with no await between: scouts see this allocation before any VM work starts.
      assertWorkspaceCapacity(latest, [...this.allocations(caller.house), ...this.deps.otherAllocations?.(caller.house) ?? []], resources);
      this.usedNames.add(key); this.usedBy[key] = caller.pet;
      record.starting = { task: input.task, ...(reused ? { reused: true } : {}) };
      this.records.push(record); this.save();
      // The VM comes up in the background; its parent's place hears at once that it is starting (`begin`).
      this.resume(record, true);
      return structuredClone(record);
    });
  }
  /** Runs (or, after a restart, resumes) a worker's start in the background. */
  private resume(record: SideworkerRecord, announce: boolean): void {
    const key = `${record.house}/${record.name}`;
    this.spawning.add(key);
    const started = this.begin({ house: record.house, pet: record.parent }, record, announce);
    this.starts.set(key, started);
    void started.finally(() => { if (this.starts.get(key) === started) this.starts.delete(key); });
  }
  private async threadLink(worker: SideworkerRecord): Promise<string | undefined> {
    return worker.placement === "same" ? undefined : this.deps.threadLink?.(structuredClone(worker)).catch(() => undefined);
  }
  /** Settles once the worker's background start did (up with its task, or failed and rolled back). */
  started(house: string, name: string): Promise<void> { return this.starts.get(`${house}/${name}`) ?? Promise.resolve(); }
  /**
   * The worker's VM starts, its place is made and its harness gets ready; then it gets its task. Its parent is told
   * either way (an internal notice), and so is the person, on the announcement. One that did not come up is rolled
   * back: its VM goes, and its thread with it. Never rejects.
   */
  private async begin(caller: PetIdentity, record: SideworkerRecord, announce: boolean): Promise<void> {
    const { house, name, worktree } = record;
    const { task, reused } = record.starting!;
    if (announce) {
      const announcement = await this.deps.announce?.(structuredClone(record), sideworkerStarting(record)).catch(() => undefined);
      if (announcement && this.records.includes(record)) { record.announcement = announcement; this.save(); }
    }
    try {
      try {
        await this.deps.reload();
        await this.deps.ensurePlace?.(house, name);
        if (!await this.deps.ready(house, name)) throw new Error("Sideworker VM started, but its harness did not become ready");
        await this.deps.dispatch(caller, name, task, sideworkerTaskRef(record));
        delete record.starting; this.save();
        this.deps.releaseDelivery?.(house, name);
      } catch (error) {
        const reason = (error as Error).message;
        record.closing = true; this.save();
        const queued = this.deps.pendingMessages?.(house, name) ?? 0;
        const queueNotice = queued ? ` ${queued} queued message(s) remain undelivered and are kept for the next spawn with the same name.` : "";
        // Its thread may be there already (made on the reload): it goes with it, nothing was said in it. A name used
        // before has its earlier worker's thread, with its history: that one stays.
        const closed = this.deps.prepareClosedNotice?.(house, name, !reused);
        let pending = false;
        try {
          await this.deps.reload();
          await closed?.().catch(() => {});
          this.records = this.records.filter(item => item !== record); this.save();
        } catch { pending = true; }
        this.deps.log(`sideworker ${house}/${name} did not start: ${reason}${pending ? " (cleanup pending)" : ""}`);
        if (record.announcement) await this.deps.rewrite?.(structuredClone(record), record.announcement, sideworkerFailed(record, reason)).catch(() => {});
        this.deps.send(house, record.parent, `Household: sideworker ${name} did not start: ${reason}. ${pending ? `Cleanup is pending for ${name}; retry sideworker_close.` : `Nothing of it is running; you may spawn it again (the same name is fine).`} Its task was not given to it.${queueNotice} This is an internal notice, not a message from your human.`);
        return;
      }
    } finally {
      this.spawning.delete(`${house}/${name}`);
    }
    this.deps.log(`sideworker ${house}/${name} spawned by ${caller.pet} in ${record.cwd}${worktree ? ` (worktree on ${worktree.branch} from ${worktree.base})` : ""}`);
    if (record.announcement && this.records.includes(record)) {
      const link = await this.threadLink(record);
      await this.deps.rewrite?.(structuredClone(record), record.announcement, sideworkerSpawned(record), link).catch(() => {});
    }
    this.deps.send(house, record.parent, `Household: sideworker ${name} is up and has your task. Coordinate with it using house_send; close it with sideworker_close when it is done. This is an internal notice, not a message from your human.`);
  }
  close(caller: PetIdentity, name: string) {
    const worker = this.worker(caller.house, name);
    if (!worker || worker.parent !== caller.pet) return Promise.reject(new Error("You may close only your own sideworkers"));
    if (this.spawning.has(`${caller.house}/${name}`)) return Promise.reject(new Error(`Sideworker ${name} is still starting: close it once Household told you it is up or did not start`));
    return this.closeForOwner(caller.house, name);
  }
  async closeForOwner(house: string, name: string): Promise<void> {
    // One still starting is closed once its start settled (it may have rolled back by itself).
    await this.started(house, name);
    return this.serial(async () => {
      const worker = this.worker(house, name);
      if (!worker) throw new Error("Unknown sideworker");
      const noticeKey = `${house}/${name}`;
      if (!this.closedNotices.has(noticeKey) && this.deps.prepareClosedNotice) this.closedNotices.set(noticeKey, this.deps.prepareClosedNotice(house, name, false));
      // Its thread stays: the button under its notice keeps opening it, so its address is taken while it runs.
      const link = worker.announcement ? await this.threadLink(worker) : undefined;
      worker.closing = true; this.save();
      await this.deps.reload();
      this.records = this.records.filter(item => item !== worker); this.save();
      this.deps.log(`sideworker ${house}/${name} closed`);
      const notice = this.closedNotices.get(noticeKey); this.closedNotices.delete(noticeKey);
      try { await notice?.(); } catch { this.deps.log(`sideworker ${house}/${name}: final notice could not be posted`); }
      if (worker.announcement) await this.deps.rewrite?.(structuredClone(worker), worker.announcement, sideworkerFinished(worker), link).catch(() => this.deps.log(`sideworker ${house}/${name}: its spawn notice was not updated`));
    });
  }
  humanMessage(house: string, name: string) {
    const worker = this.worker(house, name);
    if (worker) this.deps.send(house, worker.parent, `Household: Your human sent a message directly to sideworker ${name} in its thread. Coordinate with it using house_send if needed.`);
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const worker of [...this.records]) {
        if (worker.closing) continue;
        const idle = await this.deps.isIdle(worker.house, worker.name).catch(() => false);
        if (!this.records.includes(worker)) continue;
        const now = this.now();
        if (!idle) { delete worker.idleSince; delete worker.remindedAt; continue; }
        worker.idleSince ??= now;
        if (now - (worker.remindedAt ?? worker.idleSince) < SIDEWORKER_IDLE_MS) continue;
        this.deps.send(worker.house, worker.parent, `Household: Your sideworker ${worker.name} has been idle for ${Math.floor((now - worker.idleSince) / 60_000)} minutes. If you no longer need it, close it with sideworker_close. This is an internal reminder, not a message from your human.`);
        worker.remindedAt = now;
        this.deps.log(`sideworker ${worker.house}/${worker.name}: idle reminder sent to ${worker.parent}`);
      }
      this.save();
    } finally { this.ticking = false; }
  }
  /** Resumes the starts a restart cut off (their VMs come back with the config), then checks idle workers every minute. */
  start() {
    for (const worker of this.records) if (worker.starting && !worker.closing && !this.starts.has(`${worker.house}/${worker.name}`)) this.resume(worker, !worker.announcement);
    this.timer = setInterval(() => { void this.tick().catch(error => this.deps.log(`sideworker idle check failed: ${(error as Error).message}`)); }, 60_000); }
  stop() { clearInterval(this.timer); }
}

/** Internal channel/notice handles stay on the host; tools return the public destination. */
function publicWorker({ channel: _channel, originPlace: _origin, announcement: _notice, starting: _starting, ...worker }: SideworkerRecord) { return worker; }

export function sideworkerTools(workers: Sideworkers): McpTool<PetIdentity>[] {
  return [
    { name: "workspace_resources", description: "Inspect this workspace's CPU/RAM budget, permanent pet reservations, active/pending helper allocations and free capacity. These are VM maxima, not measured utilization. Choose cpus and memoryMiB for scout_spawn or sideworker_spawn within available capacity; close helpers when finished. No count limit.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async call(caller) { return JSON.stringify(await workers.resources(caller)); } },
    { name: "sideworker_spawn", description: "Start a sideworker in a separate VM with shared project files. Choose a workspace-approved profile from sideworker_profiles for its harness/key/model/mode, or omit profile to inherit your own settings. Settings are captured at spawn. It has its own clean session; place selects its destination, placement chooses a dedicated thread or an existing shared place. It inherits your Household memory, and no scheduled tasks. Its cwd must resolve to an existing directory inside your shared home; fresh rootfs and private harness home are separate. In a git repository it gets its own worktree by default (repository/.worktrees/<name>, branch sideworker/<name> from your HEAD, or that worktree/branch as left when the name was used before; your uncommitted changes are not in it): merge its branch when it is done. Pass worktree: false to share your live directory instead; then never let both of you bind-mount the same data directory into containers. It returns at once with status starting: its VM comes up in the background, and Household tells you when it is up and has the task (or why it did not start). A name used before may be used again: a fresh session, the same worktree and branch. You manage it with house_send and sideworker_close. Size its VM yourself: call workspace_resources first and choose cpus and memoryMiB for the job, within the shared available budget (required).",
      inputSchema: { type: "object", additionalProperties: false, required: ["cwd", "task", "cpus", "memoryMiB"], properties: { cpus: { type: "integer", minimum: 1, maximum: 1024, description: "vCPUs for its VM" }, memoryMiB: { type: "integer", minimum: 512, multipleOf: 128, description: "Memory for its VM, MiB" }, place: { type: "string", description: "Parent place.id from header or places; defaults to the current request place" }, placement: { type: "string", enum: ["same", "thread"], description: "thread (default): dedicated place; same: share the selected place" }, profile: { type: "string", description: "Optional workspace profile name from sideworker_profiles; omitted inherits your harness/key/model/mode" }, cwd: { type: "string" }, task: { type: "string", maxLength: 32000 }, name: { type: "string", description: "Optional sw-prefixed lowercase name, e.g. sw-tests" }, worktree: { type: "boolean", description: "In a git repository: its own worktree (default true) or your shared live directory (false)" } } },
      available: caller => !workers.worker(caller.house, caller.pet),
      async call(caller, args) { return JSON.stringify({ ...publicWorker(await workers.spawn(caller, args as Parameters<Sideworkers["spawn"]>[1])), status: "starting", note: "Its VM is starting in the background (often a few minutes). Household tells you in an internal notice when it is up and has the task, or why it did not start; your human sees its progress in a card. Do not spawn it again meanwhile." }); } },
    { name: "sideworker_profiles", description: "List workspace-approved sideworker profiles and your inherited defaults: adapter, model, effort, permission mode and credential reference name only. Pass a profile name to sideworker_spawn, or omit profile to use inherited settings.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      available: caller => !workers.worker(caller.house, caller.pet),
      async call(caller) { return JSON.stringify(await workers.profiles(caller)); } },
    { name: "sideworkers", description: "List the workspace's active or closing sideworkers, their parent bots, working directories and observed idle times.", inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async call(caller) { return JSON.stringify(workers.list(caller.house).map(publicWorker)); } },
    { name: "sideworker_close", description: "Stop and remove one of your sideworker VMs. Shared project files, its worktree and branch remain; the worker's private home is retained for inspection. Ends its session immediately; its chat thread stays with its history.",
      inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
      available: caller => !workers.worker(caller.house, caller.pet),
      async call(caller, args) { if (typeof args.name !== "string") throw new Error("name must be a string"); await workers.close(caller, args.name); return JSON.stringify({ closed: args.name }); } },
  ];
}
