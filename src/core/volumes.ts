import { z } from "zod";
import { NAME_PATTERN, PET_NAME_HINT, PET_NAME_PATTERN } from "./names";

/**
 * A volume: a folder of the host the owner shares with some of a workspace's bots, mounted in their VMs at
 * `/volumes/<name>`, read-only or read-write for all of them alike. The folder stays the owner's: removing the
 * volume unmounts it and never deletes a file. Bot homes are not volumes (they are Household's own); a bot's
 * sideworkers see what their parent sees.
 *
 * Mounts are fixed when a VM is created: a change to a volume recreates the VMs of the bots it touches (their homes
 * and Docker disks carry over).
 */
export const VOLUMES_ROOT = "/volumes";
export const VOLUME_ACCESS = ["read", "write"] as const;
export type VolumeAccess = (typeof VOLUME_ACCESS)[number];

export interface Volume {
  name: string;
  /** The host folder: absolute, links resolved when it was added. */
  path: string;
  access: VolumeAccess;
  /** The bots (by name) it is mounted for. */
  bots: string[];
  /** The owner's words about it, for the web UI only (never told to a bot, so changing it restarts none). */
  note?: string;
}

/** Where a volume is in a VM. */
export const volumeTarget = (name: string) => `${VOLUMES_ROOT}/${name}`;

/** A volume as the config and the API take it (the name is its key in the config). */
export const volumeFieldsSchema = z.strictObject({
  path: z.string().trim().min(1, "a folder is required").max(1024),
  access: z.enum(VOLUME_ACCESS),
  bots: z.array(z.string().regex(PET_NAME_PATTERN, PET_NAME_HINT)).max(64).nullish().transform((bots) => [...new Set(bots ?? [])]),
  note: z.string().trim().max(200).regex(/^[^\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]*$/u, "a note is plain text on one line").nullish().transform((note) => note || undefined),
});
export type VolumeFields = z.input<typeof volumeFieldsSchema>;

export const volumeNameSchema = z.string().regex(NAME_PATTERN, `a volume's name: a–z first, then a–z, 0–9 or -, up to 31 characters`);

/** What is wrong with a host path as text, before the file system is asked; undefined when nothing. */
export function volumePathProblem(path: string): string | undefined {
  if (!path.startsWith("/")) return "the folder must be an absolute path (or start with ~/)";
  if (/[:,\p{Cc}]/u.test(path)) return "the folder's path cannot contain ':', ',' or control characters";
  if (path.split("/").some((part) => part === "..")) return "the folder's path cannot contain '..'";
  return undefined;
}

/** The volumes a bot of `house` gets: its own, or its parent's for a sideworker; none for a scout. */
export function volumesOf(house: { volumes?: Volume[] }, pet: { name: string; sideworker?: { parent: string }; scout?: unknown }): Volume[] {
  if (pet.scout) return [];
  const owner = pet.sideworker?.parent ?? pet.name;
  return (house.volumes ?? []).filter((volume) => volume.bots.includes(owner));
}

/** The bots whose mounts differ between two volume lists (added, removed, moved, access changed). */
export function botsTouched(before: readonly Volume[], after: readonly Volume[]): string[] {
  const mounts = (volumes: readonly Volume[], bot: string) => JSON.stringify(volumes.filter((v) => v.bots.includes(bot)).map((v) => [v.name, v.path, v.access]).sort());
  const bots = new Set([...before, ...after].flatMap((volume) => volume.bots));
  return [...bots].filter((bot) => mounts(before, bot) !== mounts(after, bot)).sort();
}

/** «1,234 files», «10,000+ files», «empty». */
export function describeFiles(info: { exists: boolean; files: number; capped: boolean }): string {
  if (!info.exists) return "does not exist yet: Household creates it";
  if (info.files === 0) return "empty";
  return `${info.files.toLocaleString("en-US")}${info.capped ? "+" : ""} file${info.files === 1 && !info.capped ? "" : "s"}`;
}

const within = (path: string, folder: string) => path !== folder && path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/**
 * Why `path` cannot be a volume beside the others (of every workspace), or undefined. A folder inside a read-write
 * volume could be swapped, from inside a VM, for a link to anywhere on the host before it is mounted; so no volume
 * lies inside a read-write one, and a read-write one holds no other.
 */
export function nestingProblem(path: string, access: VolumeAccess, others: readonly Pick<Volume, "name" | "path" | "access">[]): string | undefined {
  const outer = others.find((other) => other.access === "write" && within(path, other.path));
  if (outer) return `That folder is inside the read-write volume ${outer.name}: share that one, or a folder outside it.`;
  const inner = access === "write" ? others.find((other) => within(other.path, path)) : undefined;
  if (inner) return `That folder holds the volume ${inner.name}: a read-write volume cannot hold another one.`;
  return undefined;
}

/** `nestingProblem` against every other volume of every workspace (`name` in `house`: the one being replaced). */
export function nestingIn(houses: readonly { name: string; volumes?: Volume[] }[], house: string, name: string, path: string, access: VolumeAccess): string | undefined {
  const others = houses.flatMap((each) => (each.volumes ?? []).filter((volume) => !(each.name === house && volume.name === name)).map((volume) => ({ ...volume, name: each.name === house ? volume.name : `${each.name}/${volume.name}` })));
  return nestingProblem(path, access, others);
}
