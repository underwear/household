import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { HouseholdError } from "../core/errors";

/** A lock older than this is left over: an edit holds it for milliseconds. */
const STALE_MS = 30_000;

/**
 * Runs `work` while holding `<path>.lock`, a file created with O_EXCL that holds the holder's pid, so editors in
 * different processes (the CLI, the daemon) and concurrent edits in one take turns. A lock whose holder is gone
 * (no such pid, or older than STALE_MS) is removed. Waits up to `timeoutMs` for a live holder.
 * Not covered: two editors removing the same stale lock at the same instant (only after a crash, rare enough).
 */
export async function withFileLock<T>(path: string, work: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (!tryCreate(lock)) {
    const holder = holderOf(lock);
    if (holder === "stale") {
      rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new HouseholdError(`${path} is being edited by another process (pid ${holder ?? "?"}): try again; if no one is, remove ${lock}`);
    }
    await Bun.sleep(20);
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
}

function tryCreate(lock: string): boolean {
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The pid holding the lock, "stale" when it is left over, undefined when it cannot be told (yet). */
function holderOf(lock: string): number | "stale" | undefined {
  let pid: number;
  try {
    if (Date.now() - statSync(lock).mtimeMs > STALE_MS) return "stale";
    pid = Number(readFileSync(lock, "utf8"));
  } catch {
    return undefined; // removed meanwhile: the next try takes it
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined; // created, its pid not written yet
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : pid; // EPERM: alive, someone else's
  }
}
