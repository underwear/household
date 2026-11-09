import { expect, test } from "bun:test";
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
test("migration drops counts, preserves zero-count off switches, persists a budget and VM defaults", async () => {
  const path = join(tempDir(), "household.yaml");
  await Bun.write(path, stringify({ version: 3, houses: { work: { network: { allow: [] }, pets: { sibling: { cpus: 12, memoryMiB: 16384 } }, scoutLimits: { maxScouts: 0, cpus: 1 }, sideworkerLimits: { maxWorkers: 0, cpus: 2, memoryMiB: 1024 } } } }));
  const store = new ConfigStore(path); await store.migrate();
  const raw = parse(await Bun.file(path).text()).houses.work;
  expect(raw.resources).toEqual({ cpus: 12, memoryMiB: 16384 });
  expect(raw.features).toEqual({ scouts: false, sideworkers: false });
  expect(raw.scoutLimits).toEqual({ cpus: 1 });
  expect(raw.sideworkerLimits).toEqual({ cpus: 2, memoryMiB: 1024 });
});
