import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigStore } from "../../src/infra/config-store";
import { ScoutStorage } from "../../src/infra/scout-storage";
import { scoutRoutes } from "../../src/app/scout-routes";
import { Capabilities } from "../../src/app/capabilities";
import { CapabilityTests } from "../../src/app/capability-test";
import type { ScoutRun } from "../../src/app/scouts";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { tempDir } from "../helpers";

async function fixture() {
  const root = tempDir(), config = new ConfigStore(join(root, "config.yaml"));
  await config.createHouse("work");
  const store = new SqliteStore(join(root, "state.db"));
  const runs: ScoutRun[] = [];
  const capabilities = new Capabilities(config, store, async () => {});
  let launched = 0;
  const tests = new CapabilityTests({ store, launch: async () => { launched++; return { result: async () => ({ ok: true, output: "installed" }), close: async () => {} }; } });
  const routes = scoutRoutes({ config, storage: new ScoutStorage(root), capabilities, tests, scouts: { list: h => runs.filter(r => r.house === h), cancel: async (c, id) => { const r = runs.find(r => r.house === c.house && r.id === id)!; r.status = "cancelled"; return { status: r.status }; } }, apply: async () => {}, applySecrets: async () => {} });
  const call = async (method: string, suffix: string, data?: unknown) => routes(new Request(`http://local/api/houses/work/${suffix}`, { method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }) }));
  const json = async (method: string, suffix: string, data?: unknown) => (await call(method, suffix, data))!.json();
  const create = () => call("POST", "scouts", { name: "breaker", description: "Incident response" });
  return { config, runs, call, json, create, capabilities, launched: () => launched };
}

test("scouts: definitions, defaults and limits; a scout's network is its capabilities'", async () => {
  const f = await fixture();
  expect((await f.create())!.status).toBe(201);
  const list = await f.json("GET", "scouts");
  expect(list.limits).toEqual({ cpus: 2, memoryMiB: 2048 });
  expect(list.scouts[0].name).toBe("breaker");
  expect(list.scouts[0].network.open).toBe(true); // no capability limits it
  expect((await f.call("POST", "capabilities", { name: "heroku", install: "echo hi", network: { any: false, allow: ["api.heroku.com"] } }))!.status).toBe(201);
  expect((await f.call("PATCH", "scouts/breaker", { title: "Expert", capabilities: ["heroku"] }))!.status).toBe(200);
  const detail = await f.json("GET", "scouts/breaker");
  expect(detail.scout.title).toBe("Expert");
  expect(detail.scout.network).toEqual({ open: false, allow: ["api.heroku.com"], limitedBy: ["heroku"] });
  expect((await f.call("PATCH", "scouts/breaker", { capabilities: ["missing"] }))!.status).toBe(400);
  expect((await f.call("PATCH", "scouts/breaker", { name: "renamed" }))!.status).toBe(400);
  expect((await f.call("PATCH", "scouts/breaker", { workspace: { repo: "git@github.com:acme/ops.git" } }))!.status).toBe(400); // https only
  expect((await f.call("PATCH", "scouts/breaker", { workspace: { repo: "https://github.com/acme/ops.git" } }))!.status).toBe(200);
  expect((await f.json("GET", "scouts/breaker")).scout.network.allow).toEqual(["api.heroku.com", "github.com"]); // the repo's host comes along
  expect((await f.call("PUT", "scout-limits", { maxScouts: 4, cpus: 4, memoryMiB: 4096 }))!.status).toBe(200);
  expect((await f.json("GET", "scout-limits"))).toEqual({ cpus: 4, memoryMiB: 4096 });
  expect((await f.call("PUT", "scout-agent", { agent: "claude-code-tmux", key: "claude", model: "opus" }))!.status).toBe(200);
  expect((await f.config.load()).houses[0]!.scoutAgent).toEqual({ agent: "claude-code-tmux", key: "claude", model: "opus" });
  expect((await f.call("GET", "scouts/missing"))!.status).toBe(404);
  expect((await f.call("DELETE", "capabilities/heroku"))!.status).toBe(400); // used by a scout
});

test("instructions reject stale revisions even for simultaneous writes", async () => {
  const f = await fixture(); await f.create();
  const original = await f.json("GET", "scouts/breaker/instructions");
  const results = await Promise.all(["A", "B"].map(content => f.call("PUT", "scouts/breaker/instructions", { content, revision: original.revision })));
  expect(results.map(r => r!.status).sort()).toEqual([200, 409]);
});

test("capabilities: every save is a revision; restore is a new one; duplicate keeps where it came from", async () => {
  const f = await fixture();
  await f.call("POST", "capabilities", { name: "media", install: "pip install yt-dlp" });
  await f.call("PUT", "capabilities/media", { name: "media", install: "pip install yt-dlp==2025.10.22", network: { any: true } });
  let detail = await f.json("GET", "capabilities/media");
  expect(detail.history.map((r: { rev: number; summary: string }) => [r.rev, r.summary])).toEqual([[2, "install"], [1, "created"]]);
  expect(detail.capability.kind).toBe("tool");
  expect((await f.call("POST", "capabilities/media/restore", { rev: 1 }))!.status).toBe(200);
  detail = await f.json("GET", "capabilities/media");
  expect(detail.capability.install).toBe("pip install yt-dlp");
  expect(detail.history[0]).toMatchObject({ rev: 3, summary: "restored r1" });
  expect((await f.call("POST", "capabilities/media/duplicate", { as: "media-2" }))!.status).toBe(201);
  expect((await f.json("GET", "capabilities/media-2")).history[0].from).toEqual({ capability: "media", rev: 3 });
  expect((await f.call("PUT", "capabilities/media", { name: "other" }))!.status).toBe(400);
  expect((await f.call("POST", "capabilities", { name: "media" }))!.status).toBe(400); // taken
});

test("keys: added on a capability as a secret restricted to it; removed with it; never in a revision's values", async () => {
  const f = await fixture();
  await f.call("POST", "capabilities", { name: "heroku", network: { any: false, allow: ["api.heroku.com"] } });
  expect((await f.call("POST", "capabilities/heroku/keys", { secret: "heroku-prod", value: "hrku-synthetic", hosts: ["api.heroku.com"], via: "vm", env: "HEROKU_API_KEY" }))!.status).toBe(201);
  const config = await f.config.load();
  expect(config.houses[0]!.secrets!.find(s => s.name === "heroku-prod")).toMatchObject({ onlyForCapabilities: ["heroku"] });
  const detail = await f.json("GET", "capabilities/heroku");
  expect(detail.capability.keyVariables).toEqual([{ secret: "heroku-prod", via: "vm", env: "HEROKU_API_KEY" }]);
  expect(detail.capability.kind).toBe("access");
  expect(JSON.stringify(detail.history)).not.toContain("hrku-synthetic");
  // A save from the editor keeps keys as they are, whatever the body says.
  await f.call("PUT", "capabilities/heroku", { name: "heroku", install: "echo", network: { any: false, allow: ["api.heroku.com"] }, keys: [] });
  expect((await f.json("GET", "capabilities/heroku")).capability.keys).toHaveLength(1);
  expect((await f.call("DELETE", "capabilities/heroku/keys/heroku-prod"))!.status).toBe(200);
  expect(((await f.config.load()).houses[0]!.secrets ?? []).some(s => s.name === "heroku-prod")).toBe(false);
});

test("a pet's draft waits for the owner; applying makes a revision by the pet; the owner's keys win", async () => {
  const f = await fixture();
  await f.config.addPet("work", "sibling");
  await f.capabilities.draft({ house: "work", pet: "sibling" }, { name: "media", install: "pip install yt-dlp", network: { any: true }, needs_keys: ["YT_COOKIE"] });
  const drafts = await f.json("GET", "capability-drafts");
  expect(drafts[0]).toMatchObject({ capability: "media", pet: "sibling", needsKeys: ["YT_COOKIE"] });
  expect((await f.call("POST", `capability-drafts/${drafts[0].id}/apply`))!.status).toBe(200);
  expect((await f.json("GET", "capabilities/media")).history[0].author).toEqual({ kind: "pet", pet: "sibling" });
});

test("Test install runs a VM for the capability and keeps only its outcome", async () => {
  const f = await fixture();
  await f.call("POST", "capabilities", { name: "media", install: "pip install yt-dlp" });
  const result = await f.json("POST", "capabilities/media/test");
  expect(result).toMatchObject({ ok: true, output: "installed" });
  expect(f.launched()).toBe(1);
  expect((await f.json("GET", "capabilities/media")).capability.lastTest.ok).toBe(true);
});

test("a blueprint's own capability: created from the blueprint, hidden from the shared list, deleted with it", async () => {
  const f = await fixture(); await f.create();
  expect((await f.call("POST", "scouts/breaker/own"))!.status).toBe(201);
  expect((await f.call("POST", "scouts/breaker/own"))!.status).toBe(400); // one each
  expect((await f.json("GET", "capabilities")).capabilities.map((c: { name: string }) => c.name)).toEqual([]);
  const detail = await f.json("GET", "scouts/breaker");
  expect(detail.scout.own).toMatchObject({ name: "breaker", usedBy: ["breaker"] });
  await f.call("PUT", "capabilities/breaker", { name: "breaker", install: "echo own", network: { any: false, allow: ["api.heroku.com"] } });
  expect((await f.json("GET", "scouts/breaker")).scout.network).toEqual({ open: false, allow: ["api.heroku.com"], limitedBy: ["breaker"] });
  expect((await f.call("PATCH", "scouts/breaker", { capabilities: ["breaker"] }))!.status).toBe(400); // only shared ones are ticked
  expect((await f.call("POST", "capabilities/breaker/duplicate", { as: "copy" }))!.status).toBe(404);
  expect((await f.call("DELETE", "scouts/breaker"))!.status).toBe(200);
  expect((await f.config.load()).houses[0]!.capabilities ?? []).toEqual([]);
});

test("restore keeps today's keys", async () => {
  const f = await fixture();
  await f.call("POST", "capabilities", { name: "heroku", install: "v1", network: { any: false, allow: ["api.heroku.com"] } });
  await f.call("POST", "capabilities/heroku/keys", { secret: "heroku-k", value: "synthetic", hosts: ["api.heroku.com"], via: "vm", env: "HEROKU_API_KEY" });
  await f.call("PUT", "capabilities/heroku", { name: "heroku", install: "v2", network: { any: false, allow: ["api.heroku.com"] } });
  expect((await f.call("POST", "capabilities/heroku/restore", { rev: 1 }))!.status).toBe(200); // r1 had no key
  const detail = await f.json("GET", "capabilities/heroku");
  expect(detail.capability.install).toBe("v1");
  expect(detail.capability.keys).toHaveLength(1);
});

test("there is no default scout: its route is gone, and the list carries only scouts", async () => {
  const f = await fixture(); await f.create();
  expect((await f.call("PUT", "default-scout", { capabilities: [] }))).toBeUndefined();
  expect((await f.json("GET", "scouts")).defaultScout).toBeUndefined();
});

test("a special scout's own agent and resources: set, then back to the default scout's", async () => {
  const f = await fixture(); await f.create();
  expect((await f.call("PATCH", "scouts/breaker", { agent: { agent: "claude-code-tmux", key: "claude", model: "opus" }, resources: { cpus: 4 } }))!.status).toBe(200);
  expect((await f.config.load()).houses[0]!.scouts![0]).toMatchObject({ agent: { model: "opus" }, resources: { cpus: 4 } });
  expect((await f.json("GET", "scouts/breaker")).defaults).toMatchObject({ limits: { cpus: 2 } });
  await f.call("PATCH", "scouts/breaker", { agent: null, resources: null });
  const scout = (await f.config.load()).houses[0]!.scouts![0]!;
  expect(scout.agent).toBeUndefined(); expect(scout.resources).toBeUndefined();
});

test("scout runs: the owner starts one, reads it, its VM's logs and screen while it runs", async () => {
  const root = tempDir(), config = new ConfigStore(join(root, "config.yaml"));
  await config.createHouse("work");
  const store = new SqliteStore(join(root, "state.db"));
  const run = { id: "scout-1", house: "work", scout: "breaker", blueprint: "breaker", number: 3, byOwner: true, parent: "sibling", task: "Look", report: "owner", status: "running", createdAt: 0, startedAt: 0, steps: 2,
    actions: [{ at: 0, tool: "Bash" }, { at: 1, tool: "Bash" }], secretRequests: [], files: [], capabilities: [], definition: {} } as unknown as ScoutRun;
  const runs: ScoutRun[] = [run];
  const spawned: unknown[] = [];
  const routes = scoutRoutes({ config, storage: new ScoutStorage(root), capabilities: new Capabilities(config, store, async () => {}), apply: async () => {}, applySecrets: async () => {},
    scouts: { list: () => runs, cancel: async () => ({ status: "cancelled" }), ownerSpawn: async (house, scout, input) => { spawned.push([house, scout, input]); return { id: "scout-2", status: "waiting_approval" }; } },
    vm: { log: async (_h, id, source, read) => ({ source, text: `${id} ${source} ${read.lines}`, cursor: "c", missing: false }), screen: async () => ({ text: "$ _" }) } });
  const call = async (method: string, suffix: string, data?: unknown) => (await routes(new Request(`http://local/api/houses/work/${suffix}`, { method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }) })))!;
  await call("POST", "scouts", { name: "breaker", description: "Incident response" });

  const started = await call("POST", "scouts/breaker/runs", { task: "Check the logs", pet: "sibling", place: "inbox@c3", placement: "same" });
  expect(started.status).toBe(201);
  expect(spawned).toEqual([["work", "breaker", { task: "Check the logs", pet: "sibling", place: "inbox@c3", placement: "same" }]]);
  expect((await call("POST", "scouts/breaker/runs", { task: "x", secrets: {} })).status).toBe(400); // only a task and a pet

  expect(await (await call("GET", "scout-runs")).json()).toEqual([expect.objectContaining({ id: "scout-1", number: 3, byOwner: true, steps: 2 })]);
  expect(await (await call("GET", "scout-runs/scout-1")).json()).toMatchObject({ id: "scout-1", tools: { Bash: 2 }, files: [], networkRequests: [] });
  expect(await (await call("GET", "scout-runs/scout-1/logs?source=docker&lines=5")).json()).toMatchObject({ text: "scout-1 docker 5" });
  expect((await call("GET", "scout-runs/scout-1/logs?source=nope")).status).toBe(400);
  expect(await (await call("GET", "scout-runs/scout-1/screen")).json()).toEqual({ text: "$ _" });
  expect((await call("GET", "scout-runs/missing")).status).toBe(404);

  run.status = "failed"; run.setupFailure = "Setup failed. Last lines:\nE: nope";
  expect(await (await call("GET", "scout-runs/scout-1")).json()).toMatchObject({ setupFailure: expect.stringContaining("E: nope") });
  const gone = await call("GET", "scout-runs/scout-1/logs");
  expect(gone.status).toBe(409); // its VM is deleted
  expect((await gone.json()).error).toContain("has ended");
});
