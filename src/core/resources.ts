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

/** Default helper VM size. Legacy counts are accepted on read and discarded. */
export const sideworkerLimitsSchema = z.strictObject({
  maxWorkers: z.number().int().min(0).max(64).optional(),
  cpus: petCpuSchema,
  memoryMiB: petMemorySchema,
}).transform(({ maxWorkers: _legacy, ...resources }) => resources);
export const DEFAULT_SIDEWORKER_LIMITS = { cpus: 2, memoryMiB: 1024 };

export const workspaceResourcesSchema = z.strictObject({ cpus: petCpuSchema, memoryMiB: petMemorySchema });
export const DEFAULT_WORKSPACE_RESOURCES: PetResources = { cpus: 8, memoryMiB: 8192 };
export interface ResourceAllocation extends PetResources { name: string; kind: "pet" | "scout" | "sideworker"; state?: string; resident?: PetResources }
export interface WorkspaceBudget {
  total: PetResources; reserved: PetResources; helpers: PetResources; available: PetResources;
  allocations: ResourceAllocation[];
}
const sumResources = (items: PetResources[]): PetResources => items.reduce((sum, item) => ({ cpus: sum.cpus + item.cpus, memoryMiB: sum.memoryMiB + item.memoryMiB }), { cpus: 0, memoryMiB: 0 });
/** Reservations survive sleep and pause; only deleting/resizing a configured pet releases them. */
export function workspaceBudget(house: { resources?: PetResources; pets: { name: string; cpus?: number | null; memoryMiB?: number | null; sideworker?: unknown; scout?: unknown }[] }, helpers: ResourceAllocation[] = []): WorkspaceBudget {
  const allocations = new Map<string, ResourceAllocation>();
  for (const pet of house.pets.filter(p => !p.sideworker && !p.scout)) allocations.set(pet.name, { name: pet.name, kind: "pet", ...petResources(pet) });
  for (const item of helpers) {
    const before = allocations.get(item.name);
    allocations.set(item.name, before ? { ...before, ...item, kind: before.kind === "pet" && item.kind !== "pet" ? item.kind : before.kind,
      cpus: Math.max(before.cpus, item.cpus), memoryMiB: Math.max(before.memoryMiB, item.memoryMiB),
      ...(before.kind === "pet" && item.state === "resident" && (item.cpus > before.cpus || item.memoryMiB > before.memoryMiB) ? { state: "resize pending" } : {}) } : item);
  }
  const pets = [...allocations.values()].filter(a => a.kind === "pet");
  const workers = [...allocations.values()].filter(a => a.kind !== "pet");
  const reserved = sumResources(pets), used = sumResources(workers);
  // Existing YAML without a budget remains loadable, including large pet reservations.
  const total = house.resources ?? { cpus: Math.max(DEFAULT_WORKSPACE_RESOURCES.cpus, reserved.cpus), memoryMiB: Math.max(DEFAULT_WORKSPACE_RESOURCES.memoryMiB, reserved.memoryMiB) };
  return { total, reserved, helpers: used, available: { cpus: Math.max(0, total.cpus - reserved.cpus - used.cpus), memoryMiB: Math.max(0, total.memoryMiB - reserved.memoryMiB - used.memoryMiB) }, allocations: [...pets, ...workers] };
}
export function assertWorkspaceCapacity(house: Parameters<typeof workspaceBudget>[0], helpers: ResourceAllocation[], requested: PetResources): void {
  workspaceResourcesSchema.parse(requested);
  const budget = workspaceBudget(house, helpers);
  if (requested.cpus > budget.available.cpus || requested.memoryMiB > budget.available.memoryMiB)
    throw new Error(`Workspace resource budget exceeded: requested ${requested.cpus} vCPU / ${gib(requested.memoryMiB)}; available ${budget.available.cpus} vCPU / ${gib(budget.available.memoryMiB)}. Choose a smaller VM or close a helper; use workspace_resources for allocations.`);
}
