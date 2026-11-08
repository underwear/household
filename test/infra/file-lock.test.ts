import { expect, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../../src/infra/file-lock";
import { tempDir } from "../helpers";

test("holders take turns, and the lock is gone after each", async () => {
  const path = join(tempDir(), "household.yaml");
  const log: string[] = [];
  const work = (name: string) =>
    withFileLock(path, async () => {
      log.push(`${name} in`);
      await Bun.sleep(30);
      log.push(`${name} out`);
    });
  await Promise.all([work("a"), work("b"), work("c")]);
  for (let i = 0; i < log.length; i += 2) expect(log[i + 1]).toBe(log[i]!.replace(" in", " out")); // never interleaved
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a failing holder still releases the lock", async () => {
  const path = join(tempDir(), "household.yaml");
  await expect(withFileLock(path, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a lock left by a process that is gone is taken over; a live holder's is waited for, then reported", async () => {
  const path = join(tempDir(), "household.yaml");
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  writeFileSync(`${path}.lock`, String(dead.pid));
  expect(await withFileLock(path, async () => "ran")).toBe("ran");

  writeFileSync(`${path}.lock`, String(process.pid)); // held by a live process (this one)
  await expect(withFileLock(path, async () => "ran", 100)).rejects.toThrow(`is being edited by another process (pid ${process.pid})`);
});

test("a lock older than 30 s is taken over even if its pid looks alive (a reused pid)", async () => {
  const path = join(tempDir(), "household.yaml");
  writeFileSync(`${path}.lock`, String(process.pid));
  const old = new Date(Date.now() - 31_000);
  utimesSync(`${path}.lock`, old, old);
  expect(await withFileLock(path, async () => "ran", 100)).toBe("ran");
  expect(existsSync(`${path}.lock`)).toBe(false);
});
