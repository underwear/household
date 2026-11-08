import { expect, test } from "bun:test";
import { allocatedTotal, beyondHost, crowds, gib, petCpuSchema, petMemorySchema, petResources } from "../../src/core/resources";

const host = { cpus: 10, memoryMiB: 32768 };

test("a pet without its own CPU and RAM gets 2 vCPU and 1 GiB; the schema keeps a bound for any machine", () => {
  expect(petResources({})).toEqual({ cpus: 2, memoryMiB: 1024 });
  expect(petResources({ cpus: 4, memoryMiB: null })).toEqual({ cpus: 4, memoryMiB: 1024 });
  for (const good of [1, 64, 1024]) expect(petCpuSchema.safeParse(good).success).toBe(true);
  for (const bad of [0, 1.5, 1025]) expect(petCpuSchema.safeParse(bad).success).toBe(false);
  expect(petMemorySchema.safeParse(512).success).toBe(true);
  expect(petMemorySchema.safeParse(640).success).toBe(true); // any 128 MiB, though the UI steps by 256
  expect(petMemorySchema.safeParse(384).success).toBe(false);
});

test("what is beyond the host: a line per resource, none when all of it fits", () => {
  expect(beyondHost({ cpus: 10, memoryMiB: 32768 }, host)).toEqual([]); // all of it still fits
  expect(beyondHost({ cpus: 11, memoryMiB: 32768 }, host)).toEqual(["11 vCPU, more than this host's 10"]);
  expect(beyondHost({ cpus: 12, memoryMiB: 32768 + 128 }, host)).toEqual(["12 vCPU, more than this host's 10", "32.125 GiB of RAM, more than this host's 32 GiB"]);
  expect(gib(1536)).toBe("1.5 GiB");
  expect(gib(512)).toBe("0.5 GiB");
});

test("past 80% of the host crowds it; 80% exactly does not", () => {
  expect(crowds(8, 10)).toBe(false);
  expect(crowds(9, 10)).toBe(true);
  expect(crowds(26215, 32768)).toBe(true);
  expect(crowds(26214, 32768)).toBe(false);
});

test("the total: every house's enabled pets, the defaults for unset ones, the pet being edited at its new values", () => {
  const pets = [
    { house: "work", name: "owl", cpus: 4, memoryMiB: 8192 },
    { house: "work", name: "cat" }, // the defaults: 2 vCPU, 1 GiB
    { house: "lab", name: "owl", cpus: 1, memoryMiB: 512, enabled: true },
    { house: "lab", name: "off", cpus: 8, memoryMiB: 16384, enabled: false }, // stopped: takes nothing
  ];
  expect(allocatedTotal(pets)).toEqual({ cpus: 7, memoryMiB: 9728 });
  expect(allocatedTotal(pets, { house: "work", name: "owl", cpus: 6, memoryMiB: 2048 })).toEqual({ cpus: 9, memoryMiB: 3584 }); // in place of its own
  expect(allocatedTotal(pets, { house: "lab", name: "", cpus: 2, memoryMiB: 1024 })).toEqual({ cpus: 9, memoryMiB: 10752 }); // a new one: on top
  expect(allocatedTotal(pets, { house: "lab", name: "off", enabled: false, cpus: 2, memoryMiB: 1024 })).toEqual({ cpus: 7, memoryMiB: 9728 });
  expect(allocatedTotal([])).toEqual({ cpus: 0, memoryMiB: 0 });
});
