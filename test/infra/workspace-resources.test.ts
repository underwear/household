import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { ConfigStore } from "../../src/infra/config-store";
import { parseHousehold } from "../../src/infra/config-schema";
import { tempDir } from "../helpers";

const config = { houses: { work: { resources: { cpus: 8, memoryMiB: 8192 }, network: { allow: [] }, pets: { sibling: { cpus: 2, memoryMiB: 2048, enabled: false } } } } };
test("YAML budget validates pet reservations, including disabled pets", () => {
  expect(parseHousehold(config, "test").houses[0]!.resources).toEqual({ cpus: 8, memoryMiB: 8192 });
  const invalid = structuredClone(config); invalid.houses.work.resources.cpus = 1;
  expect(() => parseHousehold(invalid, "test")).toThrow("pet reservations exceed");
});
test("budget edits cannot consume active helper reservations and preserve YAML comments", async () => {
  const path = join(tempDir(), "household.yaml");
  await Bun.write(path, "# Keep this comment\n" + stringify(config));
  const store = new ConfigStore(path);
  store.resourceAllocations = () => [{ name: "sw-one", kind: "sideworker", cpus: 4, memoryMiB: 2048 }];
  await expect(store.setWorkspaceResources("work", { cpus: 5, memoryMiB: 8192 })).rejects.toThrow("allocated 6 cpus");
  expect((await store.load()).houses[0]!.resources!.cpus).toBe(8);
  await store.setWorkspaceResources("work", { cpus: 6, memoryMiB: 4096 });
  expect(await Bun.file(path).text()).toContain("# Keep this comment");
});
test("migration drops counts, preserves zero-count off switches, persists a budget; sideworkers' default size goes too", async () => {
  const path = join(tempDir(), "household.yaml");
  await Bun.write(path, stringify({ version: 3, houses: { work: { network: { allow: [] }, pets: { sibling: { cpus: 12, memoryMiB: 16384 } }, scoutLimits: { maxScouts: 0, cpus: 1 }, sideworkerLimits: { maxWorkers: 0, cpus: 2, memoryMiB: 1024 } } } }));
  const store = new ConfigStore(path); await store.migrate();
  const raw = parse(await Bun.file(path).text()).houses.work;
  expect(raw.resources).toEqual({ cpus: 12, memoryMiB: 16384 });
  expect(raw.features).toEqual({ scouts: false, sideworkers: false });
  expect(raw.scoutLimits).toEqual({ cpus: 1 });
  expect(raw.sideworkerLimits).toBeUndefined(); // bots size each sideworker (migration 6)
  expect(parse(await Bun.file(path).text()).version).toBe(6);
});

test("an unmigrated config with sideworkers' old default size still loads, without it", async () => {
  const path = join(tempDir(), "household.yaml");
  await Bun.write(path, stringify({ version: 5, houses: { work: { network: { allow: [] }, pets: {}, sideworkerLimits: { cpus: 2, memoryMiB: 1024 } } } }));
  const house = (await new ConfigStore(path).load()).houses[0]!;
  expect(house).not.toHaveProperty("sideworkerLimits");
});

test("migration leaves room for one helper beside pets that fill the default budget", async () => {
  const path = join(tempDir(), "household.yaml");
  const pets = Object.fromEntries(["a", "b", "c", "d"].map(name => [name, { cpus: 2, memoryMiB: 2048 }]));
  await Bun.write(path, stringify({ version: 3, houses: { work: { network: { allow: [] }, pets, scoutLimits: { maxScouts: 2 } }, small: { network: { allow: [] }, pets: { one: { cpus: 2, memoryMiB: 1024 } } } } }));
  const store = new ConfigStore(path); await store.migrate();
  const raw = parse(await Bun.file(path).text()).houses;
  expect(raw.work.resources).toEqual({ cpus: 10, memoryMiB: 9216 }); // 8 vCPU / 8 GiB of pets + a default 2 vCPU / 1 GiB helper
  expect(raw.small.resources).toEqual({ cpus: 8, memoryMiB: 8192 }); // the default already leaves room
});

test("a helper admitted while an edit is written is not overcommitted: the old file comes back", async () => {
  const path = join(tempDir(), "household.yaml");
  await Bun.write(path, stringify(config));
  const store = new ConfigStore(path);
  // Before the write no helper runs; once the new file is on disk, one has taken 5 vCPU (admitted against the old one).
  store.resourceAllocations = () => (readFileSync(path, "utf8").includes("cpus: 4") ? [{ name: "sw-late", kind: "sideworker", cpus: 5, memoryMiB: 1024 }] : []);
  const before = await Bun.file(path).text();
  await expect(store.updatePet("work", "sibling", { cpus: 4 })).rejects.toThrow("close helpers");
  expect(await Bun.file(path).text()).toBe(before);
});
