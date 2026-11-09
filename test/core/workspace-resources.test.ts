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
