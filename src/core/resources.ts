import { z } from "zod";

export const DEFAULT_PET_CPUS = 2;
export const DEFAULT_PET_MEMORY_MIB = 1024;
// A sane bound for any machine; the host a pet runs on bounds it further (`beyondHost`).
export const petCpuSchema = z.number().int().min(1).max(1024);
export const petMemorySchema = z.number().int().min(512).multipleOf(128);
export interface PetResources { cpus: number; memoryMiB: number }
export function petResources(pet: { cpus?: number | null; memoryMiB?: number | null }): PetResources {
  return { cpus: pet.cpus ?? DEFAULT_PET_CPUS, memoryMiB: pet.memoryMiB ?? DEFAULT_PET_MEMORY_MIB };
}

/** The machine Household runs on: its CPUs and memory, what every pet's VM shares. */
export interface HostCapacity { cpus: number; memoryMiB: number }

/** «2 GiB», «1.5 GiB», «0.5 GiB»: mebibytes in GiB, without trailing zeros. */
export const gib = (mebibytes: number) => `${Number((mebibytes / 1024).toFixed(3))} GiB`;

/** What a pet is given beyond its host, a line per resource; none when its VM fits on the host. */
export function beyondHost({ cpus, memoryMiB }: PetResources, host: HostCapacity): string[] {
  return [
    ...(cpus > host.cpus ? [`${cpus} vCPU, more than this host's ${host.cpus}`] : []),
    ...(memoryMiB > host.memoryMiB ? [`${gib(memoryMiB)} of RAM, more than this host's ${gib(host.memoryMiB)}`] : []),
  ];
}

/** Past this share of the host, an allocation crowds it: a warning, never a refusal. */
export const CROWDED_SHARE = 0.8;
export const crowds = (amount: number, capacity: number) => amount > capacity * CROWDED_SHARE;

/** A pet as the totals count it: its house and name, whether it is enabled, what it is given (unset: the defaults). */
export interface CountedPet { house: string; name: string; enabled?: boolean; cpus?: number | null; memoryMiB?: number | null }

/**
 * What the enabled pets of every house are given together; `editing` (a pet being added or changed) counts at its
 * new values in place of what it has now. A disabled pet takes nothing: its VM is stopped.
 */
export function allocatedTotal(pets: CountedPet[], editing?: CountedPet): PetResources {
  const others = editing ? pets.filter((pet) => pet.house !== editing.house || pet.name !== editing.name) : pets;
  return [...others, ...(editing ? [editing] : [])]
    .filter((pet) => pet.enabled !== false)
    .map(petResources)
    .reduce((sum, each) => ({ cpus: sum.cpus + each.cpus, memoryMiB: sum.memoryMiB + each.memoryMiB }), { cpus: 0, memoryMiB: 0 });
}

/** House-wide concurrency ceiling and allocation for each new worker. */
export const sideworkerLimitsSchema = z.strictObject({
  maxWorkers: z.number().int().min(0).max(64),
  cpus: petCpuSchema,
  memoryMiB: petMemorySchema,
});
export const DEFAULT_SIDEWORKER_LIMITS = { maxWorkers: 2, cpus: 2, memoryMiB: 1024 };
