import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { NO_LOG, type LogCursor } from "../core/log-cursor";

/** A log kept to a size: past `maxBytes` the file becomes `<path>.1` (`.1` becomes `.2`, …), `keep` old files in all. */
export interface Rotation {
  maxBytes: number;
  keep: number;
}

/** The live file, then the old ones, newest first. */
const generation = (path: string, n: number) => (n === 0 ? path : `${path}.${n}`);

/** Appends to a log through one open file, rotating it by size. */
export class RotatingLog {
  private fd: number | undefined;
  private size = 0;

  constructor(
    private readonly path: string,
    private readonly rotation: Rotation,
  ) {}

  append(text: string): void {
    const bytes = Buffer.from(text);
    if (this.fd === undefined) this.open();
    if (this.size > 0 && this.size + bytes.length > this.rotation.maxBytes) this.rotate();
    for (let written = 0; written < bytes.length; ) written += writeSync(this.fd!, bytes, written);
    this.size += bytes.length;
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  private open(): void {
    this.fd = openSync(this.path, "a");
    this.size = fstatSync(this.fd).size;
  }

  private rotate(): void {
    this.close();
    for (let n = this.rotation.keep; n > 0; n--) {
      try {
        renameSync(generation(this.path, n - 1), generation(this.path, n)); // the oldest is renamed over
      } catch {
        // No such old file yet.
      }
    }
    this.open();
  }
}

/** A line of a log: the file it is in (its identity), where it starts there, and its text. */
export interface FileLine {
  file: string;
  at: number;
  text: string;
}

/** One file of a log, open for reading: its identity (device, inode and first line) and size when opened. */
interface OpenFile {
  id: string;
  fd: number;
  size: number;
}

/**
 * Opens the log's files, the live one first, for `use`, then closes them. Each is read through its own descriptor,
 * so a rotation meanwhile cannot swap a file under the reader; a file seen twice (renamed between opens) counts once.
 */
function withFiles<T>(path: string, keep: number, use: (files: OpenFile[]) => T): T {
  const files: OpenFile[] = [];
  try {
    for (let n = 0; n <= keep; n++) {
      let fd: number;
      try {
        fd = openSync(generation(path, n), "r");
      } catch {
        continue; // not written yet, or rotated away meanwhile
      }
      const stat = fstatSync(fd);
      const id = identity(fd, stat.dev, stat.ino);
      if (files.some((file) => file.id === id)) closeSync(fd);
      else files.push({ id, fd, size: stat.size });
    }
    return use(files);
  } finally {
    for (const file of files) closeSync(file.fd);
  }
}

/**
 * A file's identity: its device and inode, and a hash of its first line. Linux hands a deleted file's inode to the next
 * new one at once, so a cursor into a log rotated away would otherwise point into a newer file. A file still empty
 * gets another identity once written to: a cursor into it starts that file over, from 0, as it would anyway.
 */
function identity(fd: number, dev: number, ino: number): string {
  const head = Buffer.alloc(256);
  const got = readSync(fd, head, 0, head.length, 0);
  const end = head.subarray(0, got).indexOf(0x0a);
  const first = head.subarray(0, end === -1 ? got : end);
  return `${dev}-${ino}-${createHash("sha256").update(first).digest("hex").slice(0, 8)}`;
}

function read(file: OpenFile, from: number, to: number): Buffer {
  const chunk = Buffer.alloc(to - from);
  const got = readSync(file.fd, chunk, 0, chunk.length, from);
  return chunk.subarray(0, got);
}

/** The lines of `bytes` (whole lines, read at `start` of `file`), empty ones left out. */
function split(file: string, start: number, bytes: Buffer): FileLine[] {
  const lines: FileLine[] = [];
  for (let at = 0; at < bytes.length; ) {
    let end = bytes.indexOf(0x0a, at);
    if (end === -1) end = bytes.length;
    if (end > at) lines.push({ file, at: start + at, text: bytes.toString("utf8", at, end) });
    at = end + 1;
  }
  return lines;
}

/**
 * Reads the log's whole lines from its newest back, `window` bytes at a time and across its old files, handing each
 * window's lines (oldest first) to `visit` until it says enough or `budget` bytes were read. Returns where the live
 * file's whole lines end (a half-written last line is the next follow-up read's), and whether it read back to the
 * start of the oldest file.
 */
export function readBackward(
  path: string,
  { keep, window, budget }: { keep: number; window: number; budget: number },
  visit: (lines: FileLine[]) => boolean,
): { end: LogCursor; complete: boolean } {
  return withFiles(path, keep, (files) => {
    let end = NO_LOG;
    let spent = 0;
    for (const [index, file] of files.entries()) {
      let to = file.size;
      while (to > 0) {
        const from = Math.max(0, to - window);
        let chunk = read(file, from, to);
        if (index === 0 && to === file.size) {
          chunk = chunk.subarray(0, chunk.lastIndexOf(0x0a) + 1);
          end = { log: file.id, at: from + chunk.length };
        }
        // A window that starts mid-line leaves that line to the next one back.
        const first = from === 0 ? 0 : chunk.indexOf(0x0a) + 1;
        spent += to - from;
        to = first === 0 && from > 0 ? from : from + first; // a line longer than a window is passed over
        if (visit(split(file.id, from + first, chunk.subarray(first)))) return { end, complete: false };
        if (spent >= budget) return { end, complete: false };
      }
      if (index === 0 && end === NO_LOG) end = { log: file.id, at: 0 };
    }
    return { end, complete: true };
  });
}

/**
 * Reads the log's whole lines after `cursor`, up to `window` bytes: the rest of the file it points into (found by
 * identity among the old files once rotated), then the newer files from their start. A file no longer there
 * (replaced, or rotated past `keep`) gives way to the live file from its start, as does a cursor past its file's end
 * (truncated). Returns where the next read goes on.
 */
export function readForward(path: string, { keep, window }: { keep: number; window: number }, cursor: LogCursor): { lines: FileLine[]; next: LogCursor } {
  return withFiles(path, keep, (files) => {
    let index = files.findIndex((file) => file.id === cursor.log);
    let from = index === -1 || cursor.at > files[index]!.size ? 0 : cursor.at;
    if (index === -1) index = 0;
    const lines: FileLine[] = [];
    let left = window;
    for (;;) {
      const file = files[index];
      if (!file) return { lines, next: NO_LOG };
      const to = Math.min(file.size, from + left);
      const chunk = read(file, from, to);
      let end = chunk.lastIndexOf(0x0a) + 1;
      // An old file's last line is whole; so, for want of a better reading, is a line longer than a window.
      if ((index > 0 && to === file.size) || (end === 0 && chunk.length === window)) end = chunk.length;
      lines.push(...split(file.id, from, chunk.subarray(0, end)));
      from += end;
      left -= end;
      if (index === 0 || from < file.size || left <= 0) return { lines, next: { log: file.id, at: from } };
      index--;
      from = 0;
    }
  });
}
