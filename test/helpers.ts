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

/**
 * A tar archive (ustar) of regular files, named exactly as given: hostile names like `../x` included, which no
 * system tar writes the same way on macOS and Linux.
 */
export function tarArchive(files: { name: string; content: string }[]): Uint8Array<ArrayBuffer> {
  const blocks: Buffer[] = [];
  for (const { name, content } of files) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    const field = (text: string, at: number, length: number) => header.write(text, at, length, "ascii");
    const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;
    field(name, 0, 100);
    field(octal(0o644, 8), 100, 8);
    field(octal(0, 8), 108, 8);
    field(octal(0, 8), 116, 8);
    field(octal(body.length, 12), 124, 12);
    field(octal(0, 12), 136, 12);
    field("        ", 148, 8); // the checksum counts its own field as spaces
    field("0", 156, 1);
    field("ustar\0", 257, 6);
    field("00", 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}
