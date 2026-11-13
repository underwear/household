import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentAdapter } from "../../src/core/agent";
import { agentCheck, agentOf, knownAgents, placePets } from "../../src/app/agents";
import type { Household } from "../../src/core/household";
import { ConfigStore } from "../../src/infra/config-store";
import { tempDir } from "../helpers";

const claude = knownAgents().get("claude-code-tmux")!;
/** An agent with no settings of its own. */
const plain: AgentAdapter = { ...claude, name: "plain", settings: undefined };
const agents = new Map([[claude.name, claude], [plain.name, plain]]);
const keys = [{ name: "test", provider: "anthropic" as const, value: "sk-ant-oat01-fixture" }];
const pet = { name: "pet", agent: claude.name, key: "test" };

test("an agent's own settings: each one it has, with one of its options; placed as given, absent when none", () => {
  expect(agentOf(agents, pet, keys)).not.toHaveProperty("settings");
  expect(agentOf(agents, { ...pet, settings: {} }, keys)).not.toHaveProperty("settings");
  expect(agentOf(agents, { ...pet, settings: { subagentModel: "haiku" } }, keys)).toMatchObject({ settings: { subagentModel: "haiku" } });
  expect(agentOf(agents, { ...pet, settings: { subagentModel: "gpt-9" } }, keys)).toMatchObject({ problem: "unknown value 'gpt-9' for setting 'subagentModel' of harness claude-code-tmux (its values: opus, sonnet, haiku, fable)" });
  expect(agentOf(agents, { ...pet, settings: { turbo: "on" } }, keys)).toMatchObject({ problem: "unknown setting 'turbo' for harness claude-code-tmux (its settings: claudeAiConnectors, subagentModel)" });
  expect(agentOf(agents, { ...pet, agent: plain.name, settings: { subagentModel: "haiku" } }, keys)).toMatchObject({ problem: "harness plain has no settings: leave settings out" });
  const household: Household = { daemon: {}, keys, houses: [{ name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ ...pet, settings: { subagentModel: "sonnet" } }], people: { owners: [] }, channels: [] }] };
  expect(placePets(agents, household)[0]).toMatchObject({ settings: { subagentModel: "sonnet" } });
});

test("the config keeps settings under the pet, checked by its agent; one is removed with null, all with null for the map, and an empty map goes", async () => {
  const file = join(tempDir(), "household.yaml");
  const config = new ConfigStore(file, agentCheck(agents));
  await config.addKey("test", keys[0]!);
  await config.createHouse("work");
  await config.addPet("work", "pet", { agent: claude.name, key: "test", settings: { subagentModel: "haiku" } });
  expect((await config.load()).houses[0]!.pets[0]).toMatchObject({ settings: { subagentModel: "haiku" } });
  await expect(config.updatePet("work", "pet", { settings: { subagentModel: "gpt-9" } })).rejects.toThrow("unknown value 'gpt-9'");
  await expect(config.updatePet("work", "pet", { settings: { turbo: "on" } })).rejects.toThrow("unknown setting 'turbo'");
  await expect(config.updatePet("work", "pet", { settings: { "not a key": "x" } })).rejects.toThrow('settings["not a key"]');
  expect((await config.load()).houses[0]!.pets[0]).toMatchObject({ settings: { subagentModel: "haiku" } });
  await config.updatePet("work", "pet", { settings: { subagentModel: "sonnet" } });
  expect(await Bun.file(file).text()).toContain("settings:\n          subagentModel: sonnet");
  await config.updatePet("work", "pet", { settings: { subagentModel: null } });
  expect((await config.load()).houses[0]!.pets[0]).not.toHaveProperty("settings");
  expect(await Bun.file(file).text()).not.toContain("settings:");
  await config.updatePet("work", "pet", { settings: { subagentModel: "haiku" } });
  await config.updatePet("work", "pet", { settings: null });
  expect((await config.load()).houses[0]!.pets[0]).not.toHaveProperty("settings");
  // A pet moved to another agent leaves the settings of the one before behind, whether or not it says so.
  await config.updatePet("work", "pet", { settings: { subagentModel: "haiku" } });
  await config.updatePet("work", "pet", { agent: plain.name });
  expect((await config.load()).houses[0]!.pets[0]).toMatchObject({ agent: plain.name });
  expect((await config.load()).houses[0]!.pets[0]).not.toHaveProperty("settings");
  await expect(config.updatePet("work", "pet", { settings: { subagentModel: "haiku" } })).rejects.toThrow("has no settings");
});

test("a key's overage switch: off unless written, written only when on", async () => {
  const file = join(tempDir(), "household.yaml");
  const config = new ConfigStore(file, agentCheck(agents));
  await config.addKey("test", keys[0]!);
  expect((await config.load()).keys[0]).not.toHaveProperty("allowOverage");
  await config.updateKey("test", { allowOverage: true });
  expect((await config.load()).keys[0]).toMatchObject({ allowOverage: true });
  expect(await Bun.file(file).text()).toContain("allowOverage: true");
  await config.updateKey("test", { note: "Max" }); // untouched
  expect((await config.load()).keys[0]).toMatchObject({ allowOverage: true, note: "Max" });
  await config.updateKey("test", { allowOverage: false });
  expect((await config.load()).keys[0]).not.toHaveProperty("allowOverage");
  expect(await Bun.file(file).text()).not.toContain("allowOverage");
  await config.addKey("paid", { provider: "anthropic", value: "sk-ant-oat01-paid", allowOverage: true });
  expect((await config.load()).keys[1]).toMatchObject({ name: "paid", allowOverage: true });
});


test("connector opt-in is validated as a pet setting", async () => {
  // Validation uses the same metadata that exposes the checkbox.
  expect(agentOf(agents, { ...pet, settings: { claudeAiConnectors: "true" } }, keys)).toMatchObject({ settings: { claudeAiConnectors: "true" } });
  expect(agentOf(agents, { ...pet, settings: { claudeAiConnectors: "yes" } }, keys)).toHaveProperty("problem");
});
