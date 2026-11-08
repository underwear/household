import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/core/clock";

// Preloaded (bunfig.toml), so this afterAll is global and runs once after all test files.
const root = mkdtempSync(join(tmpdir(), "household-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh temp dir, removed after the test run. */
export function tempDir(): string {
  return mkdtempSync(join(root, "t-"));
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(20);
  }
}

/** A clock that stands still until `tick`, which runs what is due. */
export function fakeClock(): Clock & { tick(ms: number): void } {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: () => now,
    after(ms, run) {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    tick(ms) {
      now += ms;
      for (const timer of [...timers].filter(({ at }) => at <= now)) {
        timers.delete(timer);
        timer.run();
      }
    },
  };
}
