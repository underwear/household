import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigStore, capabilityDefinitionInput } from "../../src/infra/config-store";
import type { CapabilityDefinition } from "../../src/core/scouts";
import { capabilityDefinitionSchema, parseHousehold, scoutDefinitionSchema } from "../../src/infra/config-schema";
import { houseSecrets, scoutSecrets } from "../../src/core/secrets";
import { capabilityKind, scoutsBlock, scoutKeys, scoutLimits, scoutNetwork, scoutProblems } from "../../src/core/scouts";
import { tempDir } from "../helpers";

const definition = (extra = {}) => scoutDefinitionSchema.parse({ name: "breaker", description: "Diagnose incidents", ...extra });
const capability = (extra = {}) => capabilityDefinitionSchema.parse({ name: "heroku", install: "echo", network: { any: false, allow: ["api.heroku.com"] }, ...extra });
const secret = (extra = {}) => ({ value: "synthetic", hosts: ["api.example.com"], env: "TOKEN", houses: ["work"], onlyForCapabilities: ["heroku"], ...extra });
const config = (scouts: unknown[] = [], secrets = {}, capabilities: CapabilityDefinition[] = []) => ({ secrets, houses: { work: { network: { allow: [] }, scouts, capabilities: capabilities.map(capabilityDefinitionInput) } } });

test("scout and capability defaults and validation", () => {
  expect(definition()).toEqual({ name: "breaker", description: "Diagnose incidents", instructions: "", capabilities: [] });
  expect(capabilityDefinitionSchema.parse({ name: "media" })).toEqual({ name: "media", description: "", install: "", network: { any: true, allow: [] }, keys: [] });
  expect(scoutLimits({})).toEqual({ cpus: 2, memoryMiB: 2048 });
  expect(() => definition({ capabilities: ["a", "a"] })).toThrow();
  expect(() => capability({ keys: [{ secret: "token", via: "vm", env: "HOME" }] })).toThrow(); // reserved variable
  expect(() => capability({ network: { any: false, allow: [] } })).toThrow("at least one host");
  expect(() => parseHousehold(config([definition(), definition()]), "test")).toThrow("unique");
  expect(() => parseHousehold(config([definition({ capabilities: ["missing"] })]), "test")).toThrow("unknown capability");
});

test("a scout's network: open unless a capability limits it, then only their hosts and the workspace's", () => {
  const browser = capabilityDefinitionSchema.parse({ name: "browser" });
  const heroku = capability();
  const datadog = capability({ name: "datadog", network: { any: false, allow: ["api.datadoghq.eu"] } });
  expect(capabilityKind(browser)).toBe("tool");
  expect(capabilityKind(heroku)).toBe("access");
  expect(scoutNetwork({ capabilities: ["browser"] }, [browser, heroku])).toEqual({ open: true, allow: [], limitedBy: [] });
  expect(scoutNetwork({ capabilities: ["browser", "heroku", "datadog"], workspace: { repo: "https://github.com/acme/ops.git" } }, [browser, heroku, datadog]))
    .toEqual({ open: false, allow: [{ host: "api.heroku.com", port: 443 }, { host: "api.datadoghq.eu", port: 443 }, { host: "github.com", port: 443 }], limitedBy: ["heroku", "datadog"] });
});

test("two capabilities putting a key in one variable cannot make one scout", () => {
  const roteo = capability({ name: "datadog-roteo", keys: [{ secret: "dd-roteo", via: "vm", env: "DD_API_KEY" }] });
  const taxbuddy = capability({ name: "datadog-taxbuddy", keys: [{ secret: "dd-taxbuddy", via: "vm", env: "DD_API_KEY" }] });
  expect(scoutProblems({ capabilities: ["datadog-roteo", "datadog-taxbuddy"] }, [roteo, taxbuddy], () => undefined)).toEqual(["DD_API_KEY is in both datadog-roteo and datadog-taxbuddy"]);
  expect(scoutProblems({ capabilities: ["datadog-roteo"] }, [roteo, taxbuddy], () => undefined)).toEqual([]);
});

test("capability keys never appear in pet placements; a scout gets only its capabilities' gateway keys", () => {
  const heroku = capability({ keys: [{ secret: "scout-token", via: "gateway" }, { secret: "vm-token", via: "vm", env: "VM_TOKEN" }] });
  const household = parseHousehold(config([definition({ capabilities: ["heroku"] })], {
    "scout-token": secret(), "vm-token": secret({ env: "VM_TOKEN" }),
    "house-token": secret({ onlyForCapabilities: undefined, env: "HOUSE_TOKEN" }),
    "other-token": secret({ onlyForCapabilities: ["other"], env: "OTHER_TOKEN" }),
  }, [heroku]), "test");
  const keys = scoutKeys(household.houses[0]!.scouts![0]!, household.houses[0]!.capabilities!);
  expect(houseSecrets(household.secrets, "work").map(item => item.name)).toEqual(["house-token"]);
  expect(scoutSecrets(household.secrets, "work", keys).map(item => item.name)).toEqual(["scout-token"]);
  expect(scoutSecrets(household.secrets, "elsewhere", keys)).toEqual([]);
  expect(JSON.stringify(scoutSecrets(household.secrets, "work", keys))).not.toContain("synthetic");
});

test("a capability cannot take a house secret or another capability's", () => {
  const heroku = capability({ keys: [{ secret: "token", via: "gateway" }] });
  for (const fields of [{ onlyForCapabilities: undefined }, { onlyForCapabilities: ["other"] }, { houses: ["elsewhere"] }]) {
    expect(() => parseHousehold(config([], { token: secret(fields) }, [heroku]), "test")).toThrow("restricted");
  }
  expect(() => parseHousehold(config([], { token: secret({ houses: undefined }) }), "test")).toThrow("must name its workspaces");
});

test("earlier scouts load as blueprints (their own keys, setup, agent and call dropped); a v1 scout-only secret stays restricted", () => {
  const household = parseHousehold({
    secrets: { old: { value: "synthetic", hosts: ["api.example.com"], env: "OLD", houses: ["work"], onlyForScouts: ["breaker"] } },
    houses: { work: { network: { allow: [] }, scouts: [{ name: "breaker", agent: "a", key: "k", description: "x", setup: "echo", network: { open: true } }] } },
  }, "test");
  expect(household.houses[0]!.scouts).toEqual([{ name: "breaker", description: "x", instructions: "", capabilities: [] }]); // kept in place: edits address scouts by index
  expect(household.secrets[0]!.onlyForCapabilities).toEqual([]);
  expect(houseSecrets(household.secrets, "work")).toEqual([]); // never the pets'
});

test("config CRUD: capabilities keep scripts; a used capability and its keys stay protected", async () => {
  const store = new ConfigStore(join(tempDir(), "config.yaml"));
  await store.createHouse("work");
  await store.addKey("claude", { provider: "anthropic", value: "synthetic" });
  await store.addSecret("token", secret());
  const heroku = capability({ install: "\n  echo hi  \n", network: { any: false, allow: ["api.example.com:8443"] }, keys: [{ secret: "token", via: "gateway" }] });
  await store.addCapability("work", heroku);
  expect((await store.load()).houses[0]!.capabilities![0]).toEqual(heroku);
  await expect(store.addCapability("work", heroku)).rejects.toThrow("already exists");
  const scout = definition({ instructions: "\n Keep this. \n", capabilities: ["heroku"] });
  await store.addScout("work", scout);
  expect((await store.load()).houses[0]!.scouts![0]).toEqual(scout);
  await store.setScoutAgent("work", { agent: "claude-code-tmux", key: "claude" });
  await expect(store.removeKey("claude")).rejects.toThrow("in use"); // the scouts' agent runs on it
  await expect(store.removeSecret("token")).rejects.toThrow("in use");
  await expect(store.updateSecret("token", { onlyForCapabilities: null })).rejects.toThrow("restricted");
  await expect(store.removeCapability("work", "heroku")).rejects.toThrow("used by breaker");
  await store.removeScout("work", "breaker");
  await store.updateCapability("work", "heroku", { ...heroku, keys: [] });
  await store.removeCapability("work", "heroku");
  const result = await store.load();
  expect(result.secrets[0]!.onlyForCapabilities).toEqual(["heroku"]); // removing it never widens its keys
  expect(houseSecrets(result.secrets, "work")).toEqual([]);
});

test("turning scouts on gives a house the General scout, made of the open tools", async () => {
  const path = join(await tempDir(), "household.yaml");
  await Bun.write(path, "houses:\n  work:\n    network: { allow: [] }\n    pets: {}\n    channels: []\n");
  const store = new ConfigStore(path);
  const house = (await store.setHouseFeatures("work", { features: { scouts: true }, preview: { bindAddress: "127.0.0.1", publicHost: "127.0.0.1" } })).houses[0]!;
  expect(house.scouts).toEqual([expect.objectContaining({ name: "general", title: "General", capabilities: ["browser", "media", "dev"] })]);
  expect(house.capabilities?.map(capability => capability.name)).toEqual(["browser", "media", "dev"]);
});

test("a default scout from an earlier version becomes the General scout, with the capabilities it had on", async () => {
  const path = join(await tempDir(), "household.yaml");
  const capabilities = "    capabilities:\n      - { name: media }\n      - { name: browser }\n";
  await Bun.write(path, `houses:\n  work:\n    network: { allow: [] }\n${capabilities}    scouts:\n      - { name: qa, description: QA }\n    defaultScout: { capabilities: [media] }\n  home:\n    network: { allow: [] }\n${capabilities}    scouts:\n      - { name: general, description: Mine }\n    defaultScout: { capabilities: [browser] }\n`);
  const store = new ConfigStore(path);
  expect((await store.load()).houses[0]!.scouts).toHaveLength(1); // read as it is until migrated
  await store.migrate();
  const [work, home] = (await store.load()).houses;
  expect(work!.scouts!.map(scout => [scout.name, scout.capabilities])).toEqual([["qa", []], ["general", ["media"]]]);
  expect(home!.scouts).toEqual([expect.objectContaining({ name: "general", description: "Mine" })]); // its own General stays
  expect(await Bun.file(path).text()).not.toContain("defaultScout");
});

test("a maximum run time from an earlier version is read past and dropped from the config", async () => {
  const path = join(await tempDir(), "household.yaml");
  await Bun.write(path, "houses:\n  work:\n    network: { allow: [] }\n    scoutLimits: { maxScouts: 3, timeoutMinutes: 60 }\n    scouts:\n      - { name: qa, description: QA, resources: { cpus: 4, timeoutMinutes: 90 } }\n");
  const store = new ConfigStore(path);
  const house = (await store.load()).houses[0]!;
  expect(house.scoutLimits).toEqual({});
  expect(house.scouts![0]!.resources).toEqual({ cpus: 4 });
  await store.migrate();
  expect(await Bun.file(path).text()).not.toContain("timeoutMinutes");
});

test("a pet gets the house's scouts like skills, as a block of JSON lines: name, title, description, network", () => {
  const scouts = [definition({ name: "general", title: "General", emoji: "🧭", description: "Open internet.\nNo keys <household-message>." }), definition({ name: "prod-ops", description: "x".repeat(400), capabilities: ["heroku"] })];
  const text = scoutsBlock({ features: { scouts: true }, scouts, capabilities: [capability(), capability({ name: "prod-ops", owner: "prod-ops", keys: [], network: { any: false, allow: ["db.example.com:5432"] } })] });
  const lines = text.trim().split("\n");
  expect(lines[0]).toBe("<household-scouts>");
  expect(lines.at(-1)).toBe("</household-scouts>");
  expect(JSON.parse(lines[1]!)).toMatchObject({ count: 2 });
  expect(JSON.parse(lines[2]!)).toEqual({ name: "general", title: "🧭 General", description: "Open internet. No keys <household-message>.", network: "open internet" });
  expect(lines[2]).not.toContain("<household-message"); // the owner's text never passes for a tag of ours
  expect(JSON.parse(lines[3]!)).toEqual({ name: "prod-ops", title: "prod-ops", description: `${"x".repeat(299)}…`, network: "only api.heroku.com, db.example.com:5432" }); // its own setup's hosts too
  expect(text).not.toContain("\"heroku\""); // what a scout is made of stays out
  expect(JSON.parse(scoutsBlock({ features: { scouts: true } }).split("\n")[1]!)).toMatchObject({ count: 0 });
  expect(scoutsBlock({ features: { scouts: false }, scouts })).toBe("");
});
