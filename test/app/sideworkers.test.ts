import { knownAgents, agentCheck } from "../../src/app/agents";
import { ConfigStore } from "../../src/infra/config-store";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { expect, test } from "bun:test";
import { Sideworkers, SIDEWORKER_IDLE_MS, sideworkerTools, type SideworkerDeps } from "../../src/app/sideworkers";
import type { Household } from "../../src/core/household";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { PetMemory } from "../../src/app/memory";
import { mcpHandler } from "../../src/infra/mcp-server";

function fixture(overrides: Partial<SideworkerDeps> = {}) {
  const store = new SqliteStore(":memory:");
  const config: Household = { daemon: {}, keys: [{name:"openai",provider:"openai",value:"sk-household-fake-key"},{name:"claude",provider:"anthropic",value:"sk-ant-api03-fake-key"}], secrets: [], houses: [{ name: "home", resources: { cpus: 16, memoryMiB: 16384 }, network: { kind: "allowlist", allow: [] }, people: { owners: [] },
    pets: [{ name: "parent", agent: "codex-app-server", model: "gpt-6.1-terra", mode: "auto", key:"openai", environment: { setup: "echo setup" } }, { name: "other" }],
    channels: [{ kind: "telegram-private", token: "dummy", chat: "1", pets: ["parent"] }], sideworkerLimits: { maxWorkers: 2, cpus: 3, memoryMiB: 2048 } }] };
  const sent: { house: string; pet: string; text: string }[] = [], logs: string[] = [];
  let reloads = 0, now = 100, idle = true;
  const deps: SideworkerDeps = { store, agents: knownAgents(), configured: async () => config, reload: async () => { reloads++; }, resolveDirectory: async (_h, _p, cwd) => cwd, ready: async () => true, dispatch: async (_caller, pet, text) => { sent.push({ house: "home", pet, text }); },
    isIdle: async () => idle, send: (house, pet, text) => { sent.push({ house, pet, text }); }, log: text => logs.push(text), now: () => now, ...overrides };
  const workers = new Sideworkers(deps);
  return { workers, config, store, sent, deps, logs, reloads: () => reloads, advance: (ms: number) => { now += ms; }, idle: (value: boolean) => { idle = value; } };
}
const parent = { house: "home", pet: "parent" };
const task = { cwd: "/home/agent/projects/test", task: "Please review the code", name: "sw-review" };

test("workers preserve parent launch settings, share channels without changing default, and restore after daemon restart", async () => {
  const f = fixture();
  const worker = await f.workers.spawn(parent, task);
  expect(worker).toMatchObject({ parent: "parent", cwd: task.cwd, cpus: 3, memoryMiB: 2048 });
  expect(f.sent).toEqual([{ house: "home", pet: "sw-review", text: task.task }]);
  const expanded = f.workers.expanded(f.config);
  expect(expanded.houses[0]!.pets[2]).toMatchObject({ name: "sw-review", model: "gpt-6.1-terra", mode: "auto", agent: "codex-app-server", sideworker: { parent: "parent", cwd: task.cwd } });
  expect(expanded.houses[0]!.channels[0]).toMatchObject({ pets: ["parent", "sw-review"], default: "parent" });
  expect(f.config.houses[0]!.pets).toHaveLength(2);
  expect(new Sideworkers(f.deps).list("home")).toEqual([worker]);
  f.config.houses[0]!.sideworkerLimits!.memoryMiB = 4096;
  expect(f.workers.expanded(f.config).houses[0]!.pets[2]!.memoryMiB).toBe(2048);
  f.store.close();
});

test("resource budget is atomic for concurrent spawns; only parent may close, only real enabled pets may spawn", async () => {
  const f = fixture(); f.config.houses[0]!.resources = { cpus: 7, memoryMiB: 8192 };
  const results = await Promise.allSettled([f.workers.spawn(parent, task), f.workers.spawn(parent, { ...task, name: "sw-two" })]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(f.reloads()).toBe(1);
  await expect(f.workers.close({ ...parent, pet: "other" }, "sw-review")).rejects.toThrow("own");
  await expect(f.workers.spawn({ ...parent, pet: "sw-review" }, { ...task, name: "sw-child" })).rejects.toThrow("enabled bot");
  await f.workers.close(parent, "sw-review");
  expect(f.workers.list("home")).toEqual([]);
  await f.workers.spawn(parent, { ...task, name: "sw-next" });
  f.config.houses[0]!.pets[0]!.enabled = false;
  expect(f.workers.expanded(f.config).houses[0]!.pets[2]!.enabled).toBe(false);
  f.config.houses[0]!.pets.shift();
  expect(f.workers.expanded(f.config).houses[0]!.pets).toHaveLength(1);
  expect(f.workers.list("home")).toEqual([]);
  f.store.close();
});

test("invalid directories, inputs and failed creation leave no worker reservation", async () => {
  const f = fixture({ resolveDirectory: async () => undefined });
  await expect(f.workers.spawn(parent, task)).rejects.toThrow("existing directory");
  await expect(f.workers.spawn(parent, { ...task, cwd: "relative" })).rejects.toThrow("absolute");
  await expect(f.workers.spawn(parent, { ...task, task: "" })).rejects.toThrow("task");
  expect(f.workers.list("home")).toEqual([]); f.store.close();
  const broken = fixture({ reload: async () => { throw new Error("VM failed"); } });
  await expect(broken.workers.spawn(parent, task)).rejects.toThrow("VM failed");
  expect(new Sideworkers(broken.deps).list("home")).toMatchObject([{ name: "sw-review", closing: true }]);
  expect(broken.workers.expanded(broken.config).houses[0]!.pets).toHaveLength(2);
  expect(broken.sent).toEqual([]); broken.store.close();
});

test("idle reminder repeats every thirty minutes, resets on activity, survives restart, and is sent only to parent", async () => {
  const f = fixture(); await f.workers.spawn(parent, task); f.sent.length = 0;
  await f.workers.tick(); f.advance(SIDEWORKER_IDLE_MS - 1); await f.workers.tick();
  expect(f.sent).toHaveLength(0);
  f.advance(1); await f.workers.tick();
  expect(f.sent[0]).toMatchObject({ house: "home", pet: "parent", text: expect.stringContaining("30 minutes") });
  const restarted = new Sideworkers(f.deps);
  await restarted.tick(); expect(f.sent).toHaveLength(1);
  f.advance(SIDEWORKER_IDLE_MS); await restarted.tick(); expect(f.sent).toHaveLength(2);
  f.idle(false); await restarted.tick(); f.idle(true); f.advance(SIDEWORKER_IDLE_MS); await restarted.tick();
  expect(f.sent).toHaveLength(2); // newly observed idle, not thirty minutes of continuous idle
  f.store.close();
});

test("worker memory is the parent's versioned memory; other pet and house remain isolated", async () => {
  const f = fixture(); await f.workers.spawn(parent, task);
  const memory = new PetMemory(f.store.memory, () => true, (house, pet) => f.workers.memoryOwner(house, pet));
  memory.write("home", "parent", { key: "core", value: "shared", revision: 0 }, "pet");
  expect(memory.get("home", "sw-review", "core").value).toBe("shared");
  memory.write("home", "sw-review", { key: "core", value: "worker updated", revision: 1 }, "pet");
  expect(memory.get("home", "parent", "core").value).toBe("worker updated");
  expect(memory.get("home", "other", "core").value).toBeNull();
  expect(memory.get("other", "sw-review", "core").value).toBeNull();
  expect(() => memory.write("home", "parent", { key: "core", value: "stale", revision: 1 }, "pet")).toThrow("changed");
  f.store.close();
});

test("worker-only MCP visibility also prevents direct calls of hidden tools", async () => {
  const f = fixture(); await f.workers.spawn(parent, task);
  const handler = mcpHandler({ name: "test", version: "1" }, sideworkerTools(f.workers));
  const rpc = async (pet: string, method: string, params?: unknown) => (await handler({ house: "home", pet }, new Request("http://test/mcp", { method: "POST", body: JSON.stringify({ id: 1, method, params }) }))).json() as any;
  const listed = await rpc("sw-review", "tools/list");
  expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(["workspace_resources", "sideworkers"]);
  expect((await rpc("parent", "tools/list")).result.tools).toHaveLength(5);
  expect((await rpc("sw-review", "tools/call", { name: "sideworker_spawn", arguments: task })).error.code).toBe(-32602);
  f.store.close();
});

test("failed close remains retryable and a closed name cannot resume retained harness history", async () => {
  const f = fixture(); await f.workers.spawn(parent, task);
  f.deps.reload = async () => { throw new Error("reload unavailable"); };
  await expect(f.workers.close(parent, task.name)).rejects.toThrow("reload unavailable");
  expect(new Sideworkers(f.deps).list("home")).toHaveLength(1);
  f.deps.reload = async () => {};
  await f.workers.close(parent, task.name);
  await expect(f.workers.spawn(parent, task)).rejects.toThrow("already been used");
  f.store.close();
});

test("a failed destination rolls back the worker without dispatching or announcing success", async () => {
  let announced = false;
  const f = fixture({ ensurePlace: async () => { throw new Error("BOT_TOPIC_WRONG_HOME"); }, announce: async () => { announced = true; return undefined; } });
  await expect(f.workers.spawn(parent, task)).rejects.toThrow("BOT_TOPIC_WRONG_HOME");
  expect(f.workers.list("home")).toHaveLength(0);
  expect(new Sideworkers(f.deps).list("home")).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
  expect(announced).toBe(false);
  expect(f.reloads()).toBe(2);
  f.store.close();
});

test("a VM that starts without a ready harness is removed and its task is not dispatched", async () => {
  const f = fixture({ ready: async () => false });
  await expect(f.workers.spawn(parent, task)).rejects.toThrow("did not become ready");
  expect(f.workers.list("home")).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
  expect(f.reloads()).toBe(2);
  f.store.close();
});


test("oversized task fails before creating a VM; failed cleanup remains tracked but never restarts the worker", async () => {
  const f = fixture();
  await expect(f.workers.spawn(parent, { ...task, task: "a".repeat(32001) })).rejects.toThrow("32000");
  expect(f.reloads()).toBe(0);
  await f.workers.spawn(parent, task);
  f.deps.reload = async () => { throw new Error("unavailable"); };
  await expect(f.workers.close(parent, task.name)).rejects.toThrow("unavailable");
  const restored = new Sideworkers(f.deps);
  expect(restored.list("home")[0]!.closing).toBe(true);
  expect(restored.expanded(f.config).houses[0]!.pets).toHaveLength(2);
  f.deps.reload = async () => {};
  await restored.close(parent, task.name);
  expect(restored.list("home")).toHaveLength(0);
  f.store.close();
});

test("sideworker route hides and refuses all cron CRUD even when called by name", async () => {
  const { agentRoutes } = await import("../../src/app/agent-routes");
  const { Crons } = await import("../../src/app/crons");
  const store = new SqliteStore(":memory:");
  const crons = new Crons(store.crons, { acceptScheduled: () => {} }, () => true, () => {});
  const routes = agentRoutes({ onPayload: async () => ({}) }, { reply: async () => ({ id: "m1", channel: "c1" }), react: async () => ({ id: "m1", reaction: null }) }, { find: async () => ({ messages: [], more: false }) }, undefined, undefined, crons, undefined, [], caller => caller.pet === "sw-test");
  const rpc = async (pet: string, method: string, params?: unknown) => (await routes({ house: "home", pet }, new Request("http://test/mcp", { method: "POST", body: JSON.stringify({ id: 1, method, params }) }))).json() as any;
  const parentList = (await rpc("parent", "tools/list")).result.tools.map((tool: any) => tool.name);
  const workerList = (await rpc("sw-test", "tools/list")).result.tools.map((tool: any) => tool.name);
  expect(parentList).toContain("cron_create");
  expect(workerList.some((name: string) => name.startsWith("cron_"))).toBe(false);
  for (const name of ["cron_create", "cron_list", "cron_get", "cron_update", "cron_delete"]) expect((await rpc("sw-test", "tools/call", { name, arguments: {} })).error.code).toBe(-32602);
  store.close();
});

test("house profiles allow cross-harness selection, snapshot resolved key/model/mode, and never expose credentials", async () => {
  const f = fixture();
  const house = f.config.houses[0]!;
  house.pets[0]!.reasoningEffort = "high";
  house.sideworkerProfiles = [{ name: "claude", agent: "claude-code-tmux", key: "claude", model: "sonnet" }];
  const choices = await f.workers.profiles(parent);
  expect(choices.inherited).toMatchObject({ agent: "codex-app-server", key: "openai", reasoningEffort: "high" });
  expect(choices.profiles).toEqual([{ name: "claude", agent: "claude-code-tmux", key: "claude", model: "sonnet", mode: "bypassPermissions" }]);
  expect(JSON.stringify(choices)).not.toContain("fake-key");
  const record = await f.workers.spawn(parent, { ...task, profile: "claude" });
  expect(record).toMatchObject({ profile: "claude", parentHome: "/home/agent", launch: choices.profiles[0] && { agent: "claude-code-tmux", key: "claude", model: "sonnet", mode: "bypassPermissions" } });
  expect(JSON.stringify(record)).not.toContain("fake-key");
  let worker = f.workers.expanded(f.config).houses[0]!.pets.at(-1)!;
  expect(worker.agent).toBe("claude-code-tmux"); expect(worker.reasoningEffort).toBeUndefined();
  house.sideworkerProfiles[0]!.model = "opus";
  house.sideworkerProfiles[0]!.mode = "auto";
  house.pets[0]!.model = "gpt-6.1-sol";
  house.pets[0]!.reasoningEffort = "low";
  house.sideworkerProfiles = [];
  worker = new Sideworkers(f.deps).expanded(f.config).houses[0]!.pets.at(-1)!;
  expect(worker).toMatchObject({ agent: "claude-code-tmux", key: "claude", model: "sonnet", mode: "bypassPermissions" });
  expect(worker.reasoningEffort).toBeUndefined();
  f.store.close();
});

test("omitting profile snapshots inherited defaults while legacy worker records remain compatible", async () => {
  const f = fixture();
  const record = await f.workers.spawn(parent, task);
  f.config.houses[0]!.pets[0]!.model = "gpt-6.1-sol";
  expect(f.workers.expanded(f.config).houses[0]!.pets.at(-1)!.model).toBe("gpt-6.1-terra");
  delete record.launch; delete record.parentHome;
  f.store.set("sideworkers.v1", JSON.stringify([record]));
  expect(new Sideworkers(f.deps).expanded(f.config).houses[0]!.pets.at(-1)!.model).toBe("gpt-6.1-sol");
  f.store.close();
});

test("unknown, incompatible or invalid profiles fail before reserving a worker or touching VMs", async () => {
  const f = fixture();
  await expect(f.workers.spawn(parent, { ...task, profile: "unknown" })).rejects.toThrow("Unknown sideworker profile");
  const profile = { name: "wrong", agent: "claude-code-tmux", key: "openai", model: "sonnet", mode: "bypassPermissions" };
  f.config.houses[0]!.sideworkerProfiles = [profile];
  await expect(f.workers.spawn(parent, { ...task, profile: "wrong" })).rejects.toThrow("takes anthropic");
  profile.key = "claude"; profile.model = "missing-model";
  await expect(f.workers.spawn(parent, { ...task, profile: "wrong" })).rejects.toThrow("unknown model");
  profile.model = "sonnet"; profile.mode = "missing-mode";
  await expect(f.workers.spawn(parent, { ...task, profile: "wrong" })).rejects.toThrow("unknown mode");
  profile.mode = "auto"; f.config.keys[1]!.houses = ["elsewhere"];
  await expect(f.workers.spawn(parent, { ...task, profile: "wrong" })).rejects.toThrow("not for workspace");
  expect(f.workers.list("home")).toEqual([]); expect(f.reloads()).toBe(0);
  expect(f.store.get("sideworkers.v1.used-names")).toBeUndefined();
  f.store.close();
});

test("configured profiles validate with adapter contracts, unique names and key removal guards", async () => {
  const file = join(tempDir(), "config.yaml");
  writeFileSync(file, "keys:\n  openai: {provider: openai, value: sk-household-test-key}\n  claude: {provider: anthropic, value: sk-ant-api03-test-key}\nhouses:\n  home:\n    network: {allow: []}\n");
  const config = new ConfigStore(file, agentCheck(knownAgents()));
  const profiles = [{ name: "codex", agent: "codex-app-server", key: "openai", model: "gpt-6.1-terra" }];
  await config.setSideworkerProfiles("home", profiles);
  expect((await config.load()).houses[0]!.sideworkerProfiles).toEqual(profiles);
  const saved = readFileSync(file, "utf8");
  await expect(config.setSideworkerProfiles("home", [{ ...profiles[0]!, key: "claude" }])).rejects.toThrow("takes openai");
  await expect(config.setSideworkerProfiles("home", [{ ...profiles[0]!, mode: "bad-mode" }])).rejects.toThrow("unknown mode");
  await expect(config.setSideworkerProfiles("home", [profiles[0]!, profiles[0]!])).rejects.toThrow("unique");
  await expect(config.setSideworkerProfiles("home", [{ ...profiles[0]!, reasoningEffort: "banana" }])).rejects.toThrow("unsupported reasoning effort");
  expect(readFileSync(file, "utf8")).toBe(saved);
  await expect(config.removeKey("openai")).rejects.toThrow("sideworker-profile:codex");
});

test("successful close posts once only after reconciliation; retry retains original prepared thread", async () => {
  let captures = 0, notices = 0;
  const f = fixture({ prepareClosedNotice: () => { captures++; return async () => { notices++; }; } });
  await f.workers.spawn(parent, task);
  f.deps.reload = async () => { throw new Error("stop unavailable"); };
  await expect(f.workers.close(parent, task.name)).rejects.toThrow("stop unavailable");
  expect(captures).toBe(1); expect(notices).toBe(0);
  f.deps.reload = async () => {};
  await f.workers.close(parent, task.name);
  expect(captures).toBe(1); expect(notices).toBe(1);
  f.store.close();
});

test("in a repository a worker gets its own worktree by default; worktree: false or no repository shares the directory", async () => {
  const asked: string[] = [];
  const f = fixture({ makeWorktree: async (house, from, cwd, name) => {
    asked.push(`${house}/${from}:${cwd}:${name}`);
    return cwd.includes("plain") ? undefined : { cwd: `/home/agent/projects/test/.worktrees/${name}`, branch: `sideworker/${name}`, base: "abc1234" };
  } });
  const own = await f.workers.spawn(parent, task);
  expect(asked).toEqual(["home/parent:/home/agent/projects/test:sw-review"]); // made in the parent's VM
  expect(own).toMatchObject({ cwd: "/home/agent/projects/test/.worktrees/sw-review", worktree: { branch: "sideworker/sw-review", base: "abc1234" } });
  expect(f.workers.expanded(f.config).houses[0]!.pets[2]!.sideworker).toMatchObject({ cwd: own.cwd, branch: "sideworker/sw-review" });
  expect(f.logs.at(-1)).toContain("worktree on sideworker/sw-review from abc1234");
  const shared = await f.workers.spawn(parent, { ...task, name: "sw-live", worktree: false });
  expect(shared.cwd).toBe(task.cwd);
  expect(shared.worktree).toBeUndefined();
  expect(asked).toHaveLength(1); // not asked at all
  await f.workers.close(parent, "sw-live");
  const plain = await f.workers.spawn(parent, { ...task, cwd: "/home/agent/plain", name: "sw-plain" });
  expect(plain).toMatchObject({ cwd: "/home/agent/plain" });
  expect(plain.worktree).toBeUndefined();
  await f.workers.close(parent, "sw-plain");
  await expect(f.workers.spawn(parent, { ...task, name: "sw-odd", worktree: "yes" as unknown as boolean })).rejects.toThrow("worktree must be true or false");
  f.store.close();
});

test("a worktree that cannot be made fails the spawn before any VM, with git's words", async () => {
  const f = fixture({ makeWorktree: async () => { throw new Error("Could not make a git worktree for the sideworker: fatal: invalid reference"); } });
  await expect(f.workers.spawn(parent, task)).rejects.toThrow("invalid reference");
  expect(f.reloads()).toBe(0);
  expect(f.workers.list("home")).toEqual([]);
  f.store.close();
});

test("a worktree that resolves outside the shared home cannot start a VM", async () => {
  const f = fixture({ makeWorktree: async () => ({ cwd: "/home/agent/projects/test/.worktrees/sw-review", branch: "sideworker/sw-review", base: "abcdef0" }),
    resolveDirectory: async (_house, _pet, cwd) => cwd.includes(".worktrees") ? "/tmp/external/sw-review" : cwd });
  await expect(f.workers.spawn(parent, task)).rejects.toThrow("outside the parent's shared home");
  expect(f.workers.list("home")).toEqual([]);
  expect(f.reloads()).toBe(0);
  expect(f.sent).toEqual([]);
});

test("disabled house sideworkers cannot spawn; existing workers pause and resume with the feature", async () => {
  const f = fixture();
  await f.workers.spawn(parent, task);
  f.config.houses[0]!.features = { sideworkers: false };
  expect(f.workers.expanded(f.config).houses[0]!.pets.find(pet => pet.name === task.name)?.enabled).toBe(false);
  await expect(f.workers.spawn(parent, { ...task, name: "sw-disabled" })).rejects.toThrow("disabled in this workspace");
  expect(f.workers.list("home")).toHaveLength(1);
  f.config.houses[0]!.features.sideworkers = true;
  expect(f.workers.expanded(f.config).houses[0]!.pets.find(pet => pet.name === task.name)?.enabled).toBe(true);
  f.config.houses[0]!.pets[0]!.enabled = false;
  expect(f.workers.expanded(f.config).houses[0]!.pets.find(pet => pet.name === task.name)?.enabled).toBe(false);
  await f.workers.close(parent, task.name);
  f.store.close();
});

test("a spawned worker is announced in its parent's place; closing removes its thread and says it is finished, across a restart", async () => {
  const events: string[] = [];
  const f = fixture({
    announce: async worker => { events.push(`announce ${worker.parent} ${worker.name}`); return { place: "parent-place", ref: "post-1" as never }; },
    prepareClosedNotice: (_house, name) => { events.push(`prepare ${name}`); return async () => { events.push(`closed ${name}`); }; },
    finished: async (worker, notice) => { events.push(`finished ${worker.name} ${notice.ref}`); },
  });
  await f.workers.spawn(parent, task);
  expect(events).toEqual(["announce parent sw-review"]);
  expect(f.workers.list("home")[0]!.announcement).toEqual({ place: "parent-place", ref: "post-1" as never });
  await new Sideworkers(f.deps).close(parent, "sw-review");
  expect(events).toEqual(["announce parent sw-review", "prepare sw-review", "closed sw-review", "finished sw-review post-1"]);
  f.store.close();
});

test("a failed announcement or spawn: no handle kept; a worker that never came up has its thread removed too", async () => {
  const events: string[] = [];
  const f = fixture({ announce: async () => { throw new Error("chat down"); }, ready: async () => false,
    prepareClosedNotice: (_house, name) => async () => { events.push(`closed ${name}`); } });
  await expect(f.workers.spawn(parent, task)).rejects.toThrow("did not become ready");
  expect(events).toEqual(["closed sw-review"]);
  expect(f.workers.list("home")).toEqual([]);
  const g = fixture({ announce: async () => { throw new Error("chat down"); } });
  await g.workers.spawn(parent, task);
  expect(g.workers.list("home")[0]!.announcement).toBeUndefined();
  f.store.close(); g.store.close();
});

test("worker placement is captured before asynchronous setup, stays in one channel, and survives reload", async () => {
  let selected = { channel: "slack-private:T:D", origin: "inbox@slack-private:T:D", publicOrigin: "inbox@c2" };
  const f = fixture({ place: () => ({ ...selected }), resolveDirectory: async (_h, _p, cwd) => { selected = { channel: "telegram-private:1", origin: "inbox@telegram-private:1", publicOrigin: "inbox@c1" }; return cwd; } });
  f.config.houses[0]!.channels.push({ kind: "slack-private", chat: "T:D", token: "test", appToken: "test", pets: ["parent"] });
  const worker = await f.workers.spawn(parent, { ...task, place: "inbox@c2", placement: "same" });
  expect(worker).toMatchObject({ channel: "slack-private:T:D", originPlace: "inbox@slack-private:T:D", place: "inbox@c2", placement: "same" });
  const resumed = new Sideworkers(f.deps);
  const house = resumed.expanded(f.config).houses[0]!;
  expect(house.channels[0]!.pets).not.toContain(worker.name);
  expect(house.channels[1]!.pets).toContain(worker.name);
  expect(house.pets.find(p => p.name === worker.name)?.chatPlace).toBe("inbox@slack-private:T:D");
  f.config.houses[0]!.channels.pop();
  expect(resumed.expanded(f.config).houses[0]!.channels[0]!.pets).not.toContain(worker.name);
  const schema = sideworkerTools(f.workers).find(t => t.name === "sideworker_spawn")!.inputSchema as any;
  expect(schema.properties.place.type).toBe("string");
  expect(schema.properties.placement.enum).toEqual(["same", "thread"]);
  f.store.close();
});


test("Claude connectors are captured from the parent, including profile launches, and never leak to another adapter", async () => {
  const f = fixture();
  const house = f.config.houses[0]!;
  Object.assign(house.pets[0]!, { agent: "claude-code-tmux", key: "claude", model: "opus", mode: "auto", settings: { claudeAiConnectors: "true" } });
  house.sideworkerProfiles = [{ name: "small", agent: "claude-code-tmux", key: "claude", model: "haiku" }, { name: "codex", agent: "codex-app-server", key: "openai" }];
  for (const profile of [undefined, "small"]) {
    const worker = await f.workers.spawn(parent, { ...task, name: profile ? "sw-small" : "sw-default", profile });
    expect(worker.launch?.settings).toEqual({ claudeAiConnectors: "true" });
  }
  house.pets[0]!.settings = {};
  const restored = new Sideworkers(f.deps).expanded(f.config);
  expect(restored.houses[0]!.pets.slice(2).map(pet => pet.settings)).toEqual([{ claudeAiConnectors: "true" }, { claudeAiConnectors: "true" }]);
  house.sideworkerLimits!.maxWorkers = 3;
  house.pets[0]!.settings = { claudeAiConnectors: "true" };
  await f.workers.spawn(parent, { ...task, name: "sw-codex", profile: "codex" });
  expect(f.workers.expanded(f.config).houses[0]!.pets.at(-1)!.settings).toBeUndefined();
  f.store.close();
});

test("bot-selected VM sizes share the pool with scouts; failed cleanup retains allocation", async () => {
  const f = fixture({ otherAllocations: () => [{ name: "scout-one", kind: "scout", cpus: 2, memoryMiB: 2048 }] });
  f.config.houses[0]!.resources = { cpus: 8, memoryMiB: 8192 };
  f.config.houses[0]!.sideworkerLimits!.maxWorkers = 0; // obsolete, not admission control
  const worker = await f.workers.spawn(parent, { ...task, cpus: 1, memoryMiB: 512 });
  expect(worker).toMatchObject({ cpus: 1, memoryMiB: 512 });
  expect(await f.workers.resources(parent)).toMatchObject({ available: { cpus: 1, memoryMiB: 3584 } });
  await expect(f.workers.spawn(parent, { ...task, name: "sw-too-big", cpus: 2 })).rejects.toThrow("available 1 vCPU");
  f.deps.reload = async () => { throw new Error("cleanup failed"); };
  await expect(f.workers.close(parent, task.name)).rejects.toThrow("cleanup failed");
  expect((await f.workers.resources(parent)).available.cpus).toBe(1);
  f.deps.reload = async () => {};
  await f.workers.close(parent, task.name);
  expect((await f.workers.resources(parent)).available.cpus).toBe(2);
  f.store.close();
});

test("simultaneous scout and sideworker spawns cannot spend the same remaining CPU", async () => {
  const { Scouts } = await import("../../src/app/scouts");
  const f = fixture();
  const house = f.config.houses[0]!;
  house.resources = { cpus: 6, memoryMiB: 8192 };
  house.features = { scouts: true, sideworkers: true };
  house.scoutAgent = { agent: "codex-app-server", key: "openai" };
  house.scouts = [{ name: "helper", description: "QA", instructions: "", capabilities: [] }];
  const scouts = new Scouts({
    store: f.store, configured: f.deps.configured, otherAllocations: name => f.workers.allocations(name),
    choose: async () => "yes", prepare: async run => ({ definition: run.scout, parent: run.parent, homePath: "/tmp/test", instructions: "", network: { kind: "allowlist", allow: [] } }),
    launch: async () => {}, ready: async () => true, remove: async () => {}, closedNotice: () => async () => {}, notice: async () => {}, send: () => {}, secret: async () => {}, log: () => {},
  });
  f.deps.otherAllocations = name => scouts.allocations(name);
  const results = await Promise.allSettled([
    f.workers.spawn(parent, { ...task, cpus: 2, memoryMiB: 1024 }),
    scouts.spawn(parent, { scout: "helper", task: "Check", cpus: 2, memoryMiB: 1024 }),
  ]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect((await f.workers.resources(parent)).available.cpus).toBe(0);
  await scouts.stop();
  for (const worker of f.workers.list("home")) await f.workers.close(parent, worker.name);
  expect((await f.workers.resources(parent)).available.cpus).toBe(2);
  f.store.close();
});
