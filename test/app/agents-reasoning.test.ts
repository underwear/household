import { expect, test } from "bun:test";
import type { AgentAdapter } from "../../src/core/agent";
import { agentCheck, agentOf, placePets } from "../../src/app/agents";
import type { Household } from "../../src/core/household";
import { knownAgents } from "../../src/app/agents";
import { ConfigStore } from "../../src/infra/config-store";
import { join } from "node:path";
import { tempDir } from "../helpers";

const base = knownAgents().get("claude-code-tmux")!;
const agent: AgentAdapter = {
  ...base,
  name: "reasoner",
  models: ["small", "big"],
  defaultModel: "small",
  acceptsReasoningEffort: (model, effort) => model === "big" && ["low", "high"].includes(effort),
  modelOptions: (model) => ({ id: model, label: model, ...(model === "big" ? { supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Thorough" }] } : {}) }),
};
const agents = new Map([[agent.name, agent], [base.name, base]]);
const keys = [{ name: "test", provider: "anthropic" as const, value: "sk-ant-oat01-fixture" }];
const pet = { name: "pet", agent: agent.name, model: "big", key: "test" };

test("placement preserves explicit effort and omission retains native defaults", () => {
  expect(agentOf(agents, pet, keys)).not.toHaveProperty("reasoningEffort");
  expect(agentOf(agents, { ...pet, reasoningEffort: "high" }, keys)).toMatchObject({ reasoningEffort: "high" });
  const household: Household = { daemon: {}, keys, secrets: [], houses: [{ name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ ...pet, reasoningEffort: "low" }], people: { owners: [] }, channels: [] }] };
  expect(placePets(agents, household)[0]).toMatchObject({ reasoningEffort: "low" });
});

test("effort validation uses the selected model and rejects agents without support", () => {
  expect(agentOf(agents, { ...pet, reasoningEffort: "turbo" }, keys)).toMatchObject({ problem: expect.stringContaining("low, high") });
  expect(agentOf(agents, { ...pet, model: "small", reasoningEffort: "high" }, keys)).toMatchObject({ problem: expect.stringContaining("leave reasoningEffort out") });
  expect(agentOf(agents, { name: "pet", agent: base.name, key: "test", reasoningEffort: "turbo" }, keys)).toMatchObject({ problem: expect.stringContaining("unsupported reasoning effort") });
});

test("unsupported effort edits and model switches leave persisted config unchanged", async () => {
  const config = new ConfigStore(join(tempDir(), "household.yaml"), agentCheck(agents));
  await config.addKey("test", keys[0]!);
  await config.createHouse("work");
  await config.addPet("work", "pet", { agent: agent.name, model: "big", key: "test", reasoningEffort: "high" });
  await expect(config.updatePet("work", "pet", { reasoningEffort: "turbo" })).rejects.toThrow("unsupported reasoning effort");
  await expect(config.updatePet("work", "pet", { model: "small" })).rejects.toThrow("unsupported reasoning effort");
  expect((await config.load()).houses[0]!.pets[0]).toMatchObject({ model: "big", reasoningEffort: "high" });
  await config.updatePet("work", "pet", { model: "small", reasoningEffort: null });
  expect((await config.load()).houses[0]!.pets[0]).not.toHaveProperty("reasoningEffort");
});

test("each pet is placed with the system prompt of its role", () => {
  const scout = { ...pet, name: "scout-1", scout: { definition: "general", parent: "pet", instructions: "Be careful.", homePath: "/tmp", network: { kind: "allowlist", allow: [] } } } as never;
  const worker = { ...pet, name: "pet-w1", sideworker: { parent: "pet", cwd: "/home/agent/work" } } as never;
  const household: Household = { daemon: {}, keys, secrets: [], houses: [{ name: "work", network: { kind: "allowlist", allow: [] }, features: { scouts: true }, pets: [pet, worker, scout], people: { owners: [] }, channels: [] }] };
  const [placedPet, placedWorker, placedScout] = placePets(agents, household);
  expect(placedPet!.instructions).toStartWith("Household runs you in a VM");
  expect(placedWorker!.instructions).toStartWith("You are sideworker pet-w1, dispatched by pet pet in house work");
  expect(placedScout!.instructions).toStartWith("You are scout general of house work, in a VM of your own that is deleted when you finish. Pet pet handed you one task");
  expect(placedScout!.instructions).toEndWith("Your instructions\nBe careful.");
});
