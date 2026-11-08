import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexAppServer } from "../../src/agent-adapters/codex-app-server";
import { AgentModels } from "../../src/app/agent-models";
import { agentOf, knownAgents, placePets } from "../../src/app/agents";
import type { AgentModel } from "../../src/core/agent";
import type { Household } from "../../src/core/household";
import { ConfigStore } from "../../src/infra/config-store";
import { tempDir } from "../helpers";

async function setup() {
  const dir = tempDir(), file = join(dir, "model-catalog.json");
  const config = new ConfigStore(join(dir, "household.yaml"));
  await config.addKey("one", { provider: "openai", value: "codex-chatgpt:account-one" });
  await config.addKey("two", { provider: "openai", value: "codex-chatgpt:account-two" });
  await config.createHouse("work");
  await config.addPet("work", "first", { agent: codexAppServer.name, key: "one", model: "gpt-6-luna" });
  await config.addPet("work", "second", { agent: codexAppServer.name, key: "two" });
  let current: Household = await config.load();
  let offline = false;
  let discover: (key: string) => Promise<AgentModel[]> = async (key) => [{ id: key === "one" ? "gpt-6-astra" : "gpt-6.1-sol", label: key === "one" ? "Astra" : "Sol" }];
  const calls: string[] = [];
  const adapter = { ...codexAppServer, async listModels(exec: Parameters<NonNullable<typeof codexAppServer.listModels>>[0], key: Parameters<NonNullable<typeof codexAppServer.listModels>>[1]) {
    if (offline) throw new Error("offline");
    await exec(["models"]);
    return discover(key.name);
  } };
  const agents = new Map([[adapter.name, adapter]]);
  const options = {
    agents, configured: () => config.load(), applied: () => ({ keys: current.keys, pets: offline ? [] : placePets(agents, current) }),
    exec: (house: string, pet: string) => async () => { calls.push(`${house}/${pet}`); return { ok: true, output: "" }; },
    cacheFile: file,
  };
  const service = new AgentModels(options);
  return { service, options, config, file, calls, offline() { offline = true; }, discover(fn: typeof discover) { discover = fn; }, apply: async () => { current = await config.load(); } };
}

test("native model catalogs use the requested agent/key pet, persist public metadata privately, and preserve unlisted configured choices", async () => {
  const env = await setup();
  expect(await env.service.list(codexAppServer.name, "one")).toEqual({ source: "live", models: [{ id: "gpt-6-astra", label: "Astra" }, { id: "gpt-6-luna", label: "gpt-6-luna (unlisted)" }] });
  expect(env.calls).toEqual(["work/first"]);
  expect((await env.service.list(codexAppServer.name, "two")).models).toEqual([{ id: "gpt-6.1-sol", label: "Sol" }]);
  expect(env.calls).toEqual(["work/first", "work/second"]);
  expect(statSync(env.file).mode & 0o777).toBe(0o600);
  const saved = readFileSync(env.file, "utf8");
  expect(saved).not.toContain("account-one");
  expect(saved).not.toContain("account-two");
  env.offline();
  const restarted = new AgentModels(env.options);
  expect((await restarted.list(codexAppServer.name, "one")).source).toBe("cache");
  expect((await restarted.list(codexAppServer.name, "one")).models[0]!.label).toBe("Astra");
});

test("rotating credentials under the same key never reuses another account's cache or a not-yet-applied pet", async () => {
  const env = await setup();
  await env.service.list(codexAppServer.name, "one");
  await env.config.updateKey("one", { value: "codex-chatgpt:different-account" });
  const view = await env.service.list(codexAppServer.name, "one");
  expect(view.source).toBe("default");
  expect(view.models.some(({ label }) => label === "Astra")).toBe(false);
  expect(env.calls).toEqual(["work/first"]);
});

test("a key changed during native lookup returns a benign retry error instead of its old cached catalog", async () => {
  const env = await setup();
  await env.service.list(codexAppServer.name, "one");
  let release!: (models: AgentModel[]) => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => { entered = done; });
  env.discover(() => { entered(); return new Promise((done) => { release = done; }); });
  const pending = env.service.list(codexAppServer.name, "one");
  await started;
  await env.config.updateKey("one", { value: "codex-chatgpt:different-account" });
  release([{ id: "gpt-6-astra", label: "Old account metadata" }]);
  await expect(pending).rejects.toThrow("key changed while models were loading");
});

test("offline explicit Codex ids survive restarts and CLI validation while other agents retain strict model lists", () => {
  const agents = knownAgents(), keys = [{ name: "codex", provider: "openai" as const, value: "codex-chatgpt:account-one" }];
  for (const model of ["gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-7.2-future", "o3", "codex-mini-latest"]) {
    const found = agentOf(agents, { name: "pet", agent: codexAppServer.name, key: "codex", model }, keys);
    expect("problem" in found).toBe(false);
  }
  for (const model of ["banana", "https://api.openai.com", "gpt-6-sol\nconfig", "../model", "gpt-6-sol=override", "gpt-reserve"]) {
    expect("problem" in agentOf(agents, { name: "pet", agent: codexAppServer.name, key: "codex", model }, keys)).toBe(true);
  }
  expect("problem" in agentOf(agents, { name: "pet", agent: "claude-code-tmux", key: "claude", model: "gpt-6-astra" }, [{ name: "claude", provider: "anthropic", value: "sk-ant-oat01-test" }])).toBe(true);
});

test("native effort metadata survives public filtering, cache persistence and restart without inventing options", async () => {
  const env = await setup();
  env.discover(async () => [{ id: "gpt-6-astra", label: "Astra", supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "Think deeply" }, { reasoningEffort: "xhigh", description: "Think further" },
    { reasoningEffort: "../invalid", description: "discard" },
  ], defaultReasoningEffort: "high" }]);
  const live = await env.service.list(codexAppServer.name, "one");
  expect(live.models[0]).toMatchObject({ supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "Think deeply" }, { reasoningEffort: "xhigh", description: "Think further" },
  ], defaultReasoningEffort: "high" });
  env.offline();
  expect((await new AgentModels(env.options).list(codexAppServer.name, "one")).models).toEqual(live.models);
  expect(live.models[1]!.supportedReasoningEfforts).toBeUndefined();
});

test("older cached catalogs gain exact-model fallback efforts while explicit empty native support stays empty", async () => {
  const env = await setup();
  await env.service.list(codexAppServer.name, "one");
  env.offline();
  const cached = await new AgentModels(env.options).list(codexAppServer.name, "one");
  expect(cached.models[0]!.supportedReasoningEfforts).toEqual(codexAppServer.modelOptions!("gpt-6-astra").supportedReasoningEfforts);
  const explicit = await setup();
  explicit.discover(async () => [{ id: "gpt-6-astra", label: "Astra", supportedReasoningEfforts: [] }]);
  await explicit.service.list(codexAppServer.name, "one");
  explicit.offline();
  expect((await new AgentModels(explicit.options).list(codexAppServer.name, "one")).models[0]!.supportedReasoningEfforts).toEqual([]);
});
