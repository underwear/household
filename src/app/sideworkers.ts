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
}

export interface SideworkerRecord {
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
}
export const SIDEWORKER_HOME = "/home/worker";
/** The notice in its parent's place that a worker was spawned (a button to its thread goes under it). */
export function sideworkerSpawned(worker: Pick<SideworkerRecord, "name" | "parent" | "cwd" | "worktree">): string {
  return cardText({ title: `✅ Spawned new sideworker ⛏️ ${html(worker.name)}`,
    facts: [`Started by: ${html(worker.parent)}`, `Folder: <code>${html(worker.cwd)}</code>`, ...(worker.worktree ? [`Branch: <code>${html(worker.worktree.branch)}</code>`] : [])] });
}
/** The same notice once the worker is closed: its thread is gone, so is the button. */
export function sideworkerFinished(worker: Pick<SideworkerRecord, "name">): string {
  return cardText({ title: `⏹ Sideworker ⛏️ ${html(worker.name)} finished`, note: "Its VM is removed; shared project files remain." });
}
export const SIDEWORKER_IDLE_MS = 30 * 60_000;
export const SIDEWORKER_STATE_KEY = "sideworkers.v1";
const STATE_KEY = SIDEWORKER_STATE_KEY;
export interface SideworkerDeps {
  store: KeyValueStore;
  agents: Agents;
  /** Captured before it is removed, run after: its thread goes (or, where it cannot, a notice there says it stopped). */
  prepareClosedNotice?(house: string, name: string): () => Promise<void>;
  /** A spawned worker is told in its parent's place, with a way to its thread; resolves to that notice's handle. */
  announce?(worker: SideworkerRecord): Promise<PostedNotice | undefined>;
  /** A closed worker's spawn notice (`announce`) says it is finished, its thread button gone. */
  finished?(worker: SideworkerRecord, notice: PostedNotice): Promise<void>;
  configured(): Promise<Household>;
  reload(): Promise<unknown>;
  resolveDirectory(house: string, pet: string, cwd: string): Promise<string | undefined>;
  /** A git worktree for the worker, made in the parent's VM; undefined when `cwd` is in no repository. */
  makeWorktree?(house: string, parent: string, cwd: string, name: string): Promise<SideworkerWorktree | undefined>;
  ready(house: string, pet: string): Promise<boolean>;
  dispatch(caller: PetIdentity, to: string, task: string): Promise<unknown>;
  isIdle(house: string, pet: string): Promise<boolean>;
  send(house: string, pet: string, text: string): void;
  log(message: string): void;
  now?(): number;
}

/** Durable workers reuse the pet lifecycle and channel routing, without becoming editable config pets. */
export class Sideworkers {
  private records: SideworkerRecord[];
  private readonly usedNames: Set<string>;
  private readonly closedNotices = new Map<string, () => Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly now: () => number;
  constructor(private readonly deps: SideworkerDeps) {
    this.records = JSON.parse(deps.store.get(STATE_KEY) ?? "[]");
    this.usedNames = new Set(JSON.parse(deps.store.get(`${STATE_KEY}.used-names`) ?? "[]"));
    this.now = deps.now ?? Date.now;
  }
  list(house: string): SideworkerRecord[] { return this.records.filter(item => item.house === house).map(item => structuredClone(item)); }
  worker(house: string, name: string) { return this.records.find(item => item.house === house && item.name === name); }
  memoryOwner(house: string, pet: string) { return this.worker(house, pet)?.parent ?? pet; }
  private save() { this.deps.store.set(STATE_KEY, JSON.stringify(this.records)); this.deps.store.set(`${STATE_KEY}.used-names`, JSON.stringify([...this.usedNames])); }
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
        return { ...parent, ...(worker.launch ? { ...worker.launch, reasoningEffort: worker.launch.reasoningEffort, mode: worker.launch.mode } : {}),
          enabled: parent.enabled !== false && houseFeatures(house).sideworkers,
          name: worker.name, title: worker.name, emoji: "⛏️", aliases: [], cpus: worker.cpus, memoryMiB: worker.memoryMiB,
          sideworker: { parent: worker.parent, cwd: worker.cwd, ...(worker.parentHome ? { parentHome: worker.parentHome } : {}), ...(worker.worktree ? { branch: worker.worktree.branch } : {}) } };
      });
      return { ...house, pets: [...house.pets, ...pets], channels: house.channels.map(channel => ({ ...channel,
        pets: [...channel.pets, ...workers.filter(worker => channel.pets.includes(worker.parent)).map(worker => worker.name)],
        // Adding a worker must never make an existing one-pet channel's default ambiguous.
        ...(channel.default || channel.pets.length !== 1 ? {} : { default: channel.pets[0] }),
      })) };
    }) };
  }
  private launch(config: Household, house: string, pet: Pet): { launch: SideworkerLaunch; home: string } {
    const found = agentOf(this.deps.agents, pet, config.keys, house);
    if ("problem" in found) throw new Error(found.problem);
    return { home: found.agent.home, launch: { agent: found.agent.name, key: found.key.name, model: found.model,
      ...(found.reasoningEffort === undefined ? {} : { reasoningEffort: found.reasoningEffort }), ...(found.mode === undefined ? {} : { mode: found.mode }) } };
  }
  async profiles(caller: PetIdentity) {
    const config = await this.deps.configured();
    const house = config.houses.find(item => item.name === caller.house);
    const parent = house?.pets.find(item => item.name === caller.pet);
    if (!house || !parent) throw new Error("Only configured pets may select sideworker profiles");
    return { inherited: this.launch(config, house.name, parent).launch,
      profiles: (house.sideworkerProfiles ?? []).map(profile => ({ name: profile.name, ...this.launch(config, house.name, profile).launch })) };
  }
  spawn(caller: PetIdentity, input: { cwd: string; task: string; name?: string; profile?: string; worktree?: boolean }): Promise<SideworkerRecord> {
    return this.serial(async () => {
      const config = await this.deps.configured();
      const house = config.houses.find(item => item.name === caller.house);
      const parent = house?.pets.find(item => item.name === caller.pet);
      if (!house || !parent || parent.enabled === false) throw new Error("Only an enabled pet may spawn sideworkers");
      if (!houseFeatures(house).sideworkers) throw new Error("Sideworkers are disabled in this house. Ask your human to enable them in House Settings.");
      if (input.profile !== undefined && (typeof input.profile !== "string" || !input.profile)) throw new Error("profile must name a configured house sideworker profile");
      const selected = input.profile === undefined ? parent : house.sideworkerProfiles?.find(profile => profile.name === input.profile);
      if (!selected) throw new Error(`Unknown sideworker profile '${input.profile}'; use sideworker_profiles`);
      const parentHome = this.launch(config, house.name, parent).home;
      if (parentHome === SIDEWORKER_HOME) throw new Error("Parent home conflicts with the private worker home");
      const { launch } = this.launch(config, house.name, selected);
      const limit = house.sideworkerLimits?.maxWorkers ?? 2;
      if (this.list(caller.house).length >= limit) throw new Error(`House sideworker limit (${limit}) reached. Close an existing sideworker first.`);
      if (!house.channels.some(channel => channel.pets.includes(caller.pet))) throw new Error("Attach your pet to a channel before spawning a sideworker");
      if (typeof input.cwd !== "string" || !input.cwd.startsWith("/") || /[\x00-\x1f]/.test(input.cwd) || input.cwd.length > 4096) throw new Error("cwd must be an absolute guest directory path");
      const requestedCwd = posix.normalize(input.cwd);
      if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 32_000) throw new Error("task must contain 1–32000 characters");
      if (input.worktree !== undefined && typeof input.worktree !== "boolean") throw new Error("worktree must be true or false");
      const resolved = await this.deps.resolveDirectory(caller.house, caller.pet, requestedCwd);
      if (!resolved) throw new Error("cwd must resolve to an existing directory within the parent’s shared home; rootfs directories are not shared");
      const name = input.name ?? `sw-${randomBytes(4).toString("hex")}`;
      if (!/^sw-[a-z0-9][a-z0-9-]{0,27}$/.test(name)) throw new Error("name must start with sw- and contain lowercase letters, digits and hyphens (31 characters maximum)");
      if (house.pets.some(pet => pet.name === name) || this.worker(caller.house, name)) throw new Error("This worker name is already in use");
      if (this.usedNames.has(`${caller.house}/${name}`)) throw new Error("This worker name has already been used; choose a new name for a clean session");
      this.usedNames.add(`${caller.house}/${name}`);
      this.save();
      // In a repository, by default, the worker gets its own checkout: its files, builds and bind-mounted data do not
      // meet its parent's (two VMs writing one database directory corrupt it). Outside one, it shares the directory.
      const worktree = input.worktree === false ? undefined : await this.deps.makeWorktree?.(caller.house, caller.pet, resolved, name);
      const worktreeCwd = worktree && await this.deps.resolveDirectory(caller.house, caller.pet, worktree.cwd);
      if (worktree && (!worktreeCwd || !(worktreeCwd === parentHome || worktreeCwd.startsWith(`${parentHome}/`)))) {
        throw new Error("The git worktree resolves outside the parent's shared home; keep the repository and .worktrees directory inside it, or use worktree: false.");
      }
      const cwd = worktreeCwd ?? resolved;
      const record: SideworkerRecord = { house: caller.house, name, parent: caller.pet, parentHome, ...(input.profile === undefined ? {} : { profile: input.profile }), launch, cwd, ...(worktree ? { worktree: { branch: worktree.branch, base: worktree.base } } : {}), createdAt: this.now(), cpus: house.sideworkerLimits?.cpus ?? 2, memoryMiB: house.sideworkerLimits?.memoryMiB ?? 1024 };
      this.records.push(record); this.save();
      try {
        await this.deps.reload();
        if (!await this.deps.ready(caller.house, name)) throw new Error("Sideworker VM started, but its agent did not become ready");
        await this.deps.dispatch(caller, name, input.task);
      } catch (error) {
        record.closing = true; this.save();
        // Its thread may be there already (made on the reload): it goes with it.
        const closed = this.deps.prepareClosedNotice?.(caller.house, name);
        try {
          await this.deps.reload();
          await closed?.().catch(() => {});
          this.records = this.records.filter(item => item !== record); this.save();
        } catch {
          throw new Error(`${(error as Error).message}. Cleanup is pending for ${name}; retry sideworker_close.`);
        }
        throw error;
      }
      this.deps.log(`sideworker ${caller.house}/${name} spawned by ${caller.pet} in ${cwd}${worktree ? ` (worktree on ${worktree.branch} from ${worktree.base})` : ""}`);
      const announcement = await this.deps.announce?.(structuredClone(record)).catch(() => undefined);
      if (announcement && this.records.includes(record)) { record.announcement = announcement; this.save(); }
      return structuredClone(record);
    });
  }
  close(caller: PetIdentity, name: string) {
    const worker = this.worker(caller.house, name);
    if (!worker || worker.parent !== caller.pet) return Promise.reject(new Error("You may close only your own sideworkers"));
    return this.closeForOwner(caller.house, name);
  }
  closeForOwner(house: string, name: string): Promise<void> {
    return this.serial(async () => {
      const worker = this.worker(house, name);
      if (!worker) throw new Error("Unknown sideworker");
      const noticeKey = `${house}/${name}`;
      if (!this.closedNotices.has(noticeKey) && this.deps.prepareClosedNotice) this.closedNotices.set(noticeKey, this.deps.prepareClosedNotice(house, name));
      worker.closing = true; this.save();
      await this.deps.reload();
      this.records = this.records.filter(item => item !== worker); this.save();
      this.deps.log(`sideworker ${house}/${name} closed`);
      const notice = this.closedNotices.get(noticeKey); this.closedNotices.delete(noticeKey);
      try { await notice?.(); } catch { this.deps.log(`sideworker ${house}/${name}: final notice could not be posted`); }
      if (worker.announcement) await this.deps.finished?.(structuredClone(worker), worker.announcement).catch(() => this.deps.log(`sideworker ${house}/${name}: its spawn notice was not updated`));
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
  start() { this.timer = setInterval(() => { void this.tick().catch(error => this.deps.log(`sideworker idle check failed: ${(error as Error).message}`)); }, 60_000); }
  stop() { clearInterval(this.timer); }
}

export function sideworkerTools(workers: Sideworkers): McpTool<PetIdentity>[] {
  return [
    { name: "sideworker_spawn", description: "Start a sideworker in a separate VM with shared project files. Choose a house-approved profile from sideworker_profiles for its harness/key/model/mode, or omit profile to inherit your own settings. Settings are captured at spawn. It has its own clean session and Telegram topic, your Household memory, and no scheduled tasks. Its cwd must resolve to an existing directory inside your shared home; fresh rootfs and private harness home are separate. In a git repository it gets its own worktree by default (repository/.worktrees/<name>, branch sideworker/<name> from your HEAD; your uncommitted changes are not in it): merge its branch when it is done. Pass worktree: false to share your live directory instead; then never let both of you bind-mount the same data directory into containers. You manage it with house_send and sideworker_close. The house enforces worker resource/count limits.",
      inputSchema: { type: "object", additionalProperties: false, required: ["cwd", "task"], properties: { profile: { type: "string", description: "Optional house profile name from sideworker_profiles; omitted inherits your harness/key/model/mode" }, cwd: { type: "string" }, task: { type: "string", maxLength: 32000 }, name: { type: "string", description: "Optional sw-prefixed lowercase name, e.g. sw-tests" }, worktree: { type: "boolean", description: "In a git repository: its own worktree (default true) or your shared live directory (false)" } } },
      available: caller => !workers.worker(caller.house, caller.pet),
      async call(caller, args) { return JSON.stringify(await workers.spawn(caller, args as { cwd: string; task: string; name?: string; profile?: string; worktree?: boolean })); } },
    { name: "sideworker_profiles", description: "List house-approved sideworker profiles and your inherited defaults: adapter, model, effort, permission mode and credential reference name only. Pass a profile name to sideworker_spawn, or omit profile to use inherited settings.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      available: caller => !workers.worker(caller.house, caller.pet),
      async call(caller) { return JSON.stringify(await workers.profiles(caller)); } },
    { name: "sideworkers", description: "List the house's active or closing sideworkers, their parent pets, working directories and observed idle times.", inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async call(caller) { return JSON.stringify(workers.list(caller.house)); } },
    { name: "sideworker_close", description: "Stop and remove one of your sideworker VMs. Shared project files remain; the worker's private home is retained for inspection. Ends its session immediately, and its chat thread is deleted with all its messages (in Telegram): tell your human first what in it they may want to keep.",
      inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
      available: caller => !workers.worker(caller.house, caller.pet),
      async call(caller, args) { if (typeof args.name !== "string") throw new Error("name must be a string"); await workers.close(caller, args.name); return JSON.stringify({ closed: args.name }); } },
  ];
}
