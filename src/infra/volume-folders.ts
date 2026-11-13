import { lstat, mkdir, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { HouseholdError } from "../core/errors";
import { COMPILED, releaseBin } from "./release";
import { volumePathProblem } from "../core/volumes";

/** What Household found at a volume's host folder: never its file names, only how many files it holds. */
export interface FolderInfo {
  /** The folder as it is kept: absolute, `~` expanded, links resolved where it exists. */
  path: string;
  exists: boolean;
  /** Files under it (not directories), counted up to `FILE_COUNT_CAP` or `FILE_COUNT_MS`. */
  files: number;
  /** The count stopped early: there are at least `files`. */
  capped: boolean;
  /** Why sharing it deserves a second look (a credentials folder, say); none when nothing stands out. */
  warning?: string;
}

export const FILE_COUNT_CAP = 10_000;
const FILE_COUNT_MS = 2_000;

/** Host folders no bot may get: Household's own state, config and install, and microsandbox's VMs and disks. */
export function protectedFolders(paths: { stateDir: string; configFile: string }, env: Record<string, string | undefined> = process.env): string[] {
  const home = homedir();
  return [paths.stateDir, dirname(paths.configFile), env.HOUSEHOLD_HOME || join(home, ".household"), env.MSB_HOME || join(home, ".microsandbox"),
    // The release this daemon runs from, wherever it was installed.
    ...(COMPILED ? [dirname(releaseBin())] : [])];
}

/** Folders that hold credentials or what runs on the host: allowed, but the owner is told so. */
const SENSITIVE = [".claude", ".codex", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".local", "Library", ".zshrc", ".bashrc", ".profile"];

/** `~/x` as an absolute path, normalized; refused when it is not a path a VM can mount. */
export function expandFolder(input: string): string {
  const text = input.trim();
  const expanded = text === "~" ? homedir() : text.startsWith("~/") ? join(homedir(), text.slice(2)) : text;
  const problem = volumePathProblem(expanded);
  if (problem) throw new HouseholdError(problem);
  const path = normalize(expanded);
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** The nearest existing ancestor's real path, with the rest appended: where a missing folder would be made. */
async function resolved(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await resolved(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

/**
 * Checks a host folder for a volume: absolute, not the file system's root, not one of `protectedFolders` nor holding
 * one nor inside one (links resolved on both sides), and a folder where it exists. Counts its files.
 */
export async function inspectFolder(input: string, protectedDirs: readonly string[]): Promise<FolderInfo> {
  const path = await resolved(expandFolder(input));
  if (path === sep) throw new HouseholdError("the file system's root cannot be shared");
  for (const folder of await Promise.all(protectedDirs.map(resolved))) {
    if (inside(path, folder)) throw new HouseholdError("That folder is part of Household's or microsandbox's own data (bot homes, keys, VMs): it cannot be shared.");
    if (inside(folder, path)) throw new HouseholdError("That folder holds Household's or microsandbox's own data (bot homes, keys, VMs): share a folder inside it that does not.");
  }
  const found = await lstat(path).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (found && !found.isDirectory()) throw new HouseholdError("That path is a file, not a folder.");
  const home = await resolved(homedir());
  const sensitive = SENSITIVE.find((name) => inside(path, join(home, name)));
  const warning = path === home ? "this is your whole home folder" : sensitive ? `~/${sensitive} can hold credentials or what runs on your machine` : undefined;
  const { files, capped } = found ? await countFiles(path) : { files: 0, capped: false };
  return { path, exists: !!found, files, capped, ...(warning ? { warning } : {}) };
}

/** Files under `root`, links not followed, up to the cap or the time limit. Unreadable folders are skipped. */
export async function countFiles(root: string, cap = FILE_COUNT_CAP, ms = FILE_COUNT_MS): Promise<{ files: number; capped: boolean }> {
  const deadline = Date.now() + ms;
  const stack = [root];
  let files = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let handle;
    try { handle = await opendir(dir); } catch { continue; }
    for await (const entry of handle) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else files++;
      if (files >= cap || Date.now() > deadline) return { files, capped: true };
    }
  }
  return { files, capped: false };
}

/** Makes the folder when it is missing (for a volume just approved or added); a file in its place is refused. */
export async function ensureFolder(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  if (!(await stat(path)).isDirectory()) throw new HouseholdError("That path is a file, not a folder.");
}

/** Whether a volume's folder is there to mount now (an unplugged disk's is not). */
export async function folderPresent(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

/**
 * Whether a volume's folder may be mounted now: there (`missing` when not), still the plain folder it was when it
 * was shared (its path resolves to itself: no part of it was swapped for a link since), and nothing of Household's or
 * microsandbox's own (`unsafe` otherwise).
 */
export async function mountable(path: string, protectedDirs: readonly string[]): Promise<"ok" | "missing" | "unsafe"> {
  if (!(await folderPresent(path))) return "missing";
  const real = await realpath(path).catch(() => undefined);
  if (real !== path) return "unsafe";
  for (const folder of await Promise.all(protectedDirs.map(resolved))) if (inside(real, folder) || inside(folder, real)) return "unsafe";
  return "ok";
}
