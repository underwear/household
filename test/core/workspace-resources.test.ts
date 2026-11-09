import { expect, test } from "bun:test";
import { assertWorkspaceCapacity, workspaceBudget } from "../../src/core/resources";

test("pet reservations survive pause, helpers share both dimensions, runtime pets are not counted twice", () => {
  const house = { resources: { cpus: 8, memoryMiB: 8192 }, pets: [{ name: "pet", enabled: false }, { name: "sw-one", sideworker: {} }] };
  const helpers = [{ name: "sw-one", kind: "sideworker" as const, cpus: 3, memoryMiB: 6144 }];
  expect(workspaceBudget(house, helpers)).toMatchObject({ reserved: { cpus: 2, memoryMiB: 1024 }, available: { cpus: 3, memoryMiB: 1024 } });
  expect(() => assertWorkspaceCapacity(house, helpers, { cpus: 3, memoryMiB: 1024 })).not.toThrow();
  expect(() => assertWorkspaceCapacity(house, helpers, { cpus: 4, memoryMiB: 512 })).toThrow("available 3 vCPU");
  expect(() => assertWorkspaceCapacity(house, helpers, { cpus: 1, memoryMiB: 2048 })).toThrow("Workspace resource budget exceeded");
  expect(() => assertWorkspaceCapacity(house, [], { cpus: 0, memoryMiB: 1024 })).toThrow();
});

test("resident VM maxima hold staged reductions and merge with helper records without double counting", () => {
  const house = { resources: { cpus: 8, memoryMiB: 8192 }, pets: [{ name: "pet", cpus: 2, memoryMiB: 1024 }] };
  const active = [{ name: "pet", kind: "pet" as const, cpus: 6, memoryMiB: 6144, state: "resident" }];
  expect(workspaceBudget(house, active)).toMatchObject({ reserved: { cpus: 6, memoryMiB: 6144 }, available: { cpus: 2, memoryMiB: 2048 } });
  expect(() => assertWorkspaceCapacity(house, active, { cpus: 6, memoryMiB: 6144 })).toThrow("budget exceeded");
  const helper = { name: "sw-one", kind: "sideworker" as const, cpus: 2, memoryMiB: 1024 };
  expect(workspaceBudget(house, [...active, helper, { ...helper, kind: "pet", state: "resident" }]).helpers.cpus).toBe(2);
});
