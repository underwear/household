import type { Exec } from "../core/agent";
import { formatCursor, NO_LOG, parseCursor, type LogCursor } from "../core/log-cursor";

/**
 * The logs inside a pet's VM: its two environment scripts', its Docker daemon's, and the kernel's (the VM has no
 * journal: its init is libkrun's). Files are read as the pet user; the kernel ring buffer needs sudo.
 */
export const PET_LOG_SOURCES = {
  setup: { label: "Setup script", file: "environment/setup.log" },
  onStart: { label: "On start script", file: "environment/on-start.log" },
  docker: { label: "Docker", file: "/var/log/household-docker.log" },
  kernel: { label: "Kernel", file: null },
} as const;
export type PetLogSource = keyof typeof PET_LOG_SOURCES;
export const isPetLogSource = (value: string): value is PetLogSource => Object.hasOwn(PET_LOG_SOURCES, value);

/** A read of a pet's log: its text (the last lines, or what came since `after`), and where the next read goes on. */
export interface PetLogView {
  source: PetLogSource;
  text: string;
  /** Pass it back as `after` to follow: a file's inode and the bytes read, or the boot and the last kernel line's time. */
  cursor: string;
  /** There is no such log yet (a script that never ran). */
  missing: boolean;
  /** The log started over since `after` (a file written anew, the VM booted again): `text` is its newest lines. */
  restarted?: boolean;
}

/** At most this much text per read. */
const MAX_BYTES = 256 * 1024;
/** At most this many lines for a first read. */
const MAX_LINES = 5000;

// The guest prints a header line, then the bytes it read as base64: exec output comes back trimmed and decoded,
// so the text's own bytes cannot tell where a read ended.
// $1 the file (relative: under the pet's home), $2 its inode at the read before (none for a first read), $3 the bytes
// read then. Prints «inode start»: a first read, or one of a file replaced or shrunk since, takes the file's last bytes.
const FILE_SCRIPT = String.raw`case "$1" in /*) f=$1 ;; *) f=$HOME/$1 ;; esac; [ -f "$f" ] || { echo missing; exit 0; }
inode=$(stat -c %i "$f"); size=$(stat -c %s "$f"); n=$3
[ "$2" = "$inode" ] && [ "$n" -le "$size" ] || n=$((size > ${MAX_BYTES} ? size - ${MAX_BYTES} : 0))
echo "$inode $n"; tail -c +$((n + 1)) "$f" | head -c ${MAX_BYTES} | base64`;
// The kernel ring buffer drops its oldest lines as it fills, so it follows by time: $1 the boot of the read before
// (none for a first read), $2 the time (µs) of the last line read then. Prints the boot, then the lines after that
// time: the last ones for a first read or a new boot, the first ones otherwise; a line without a time goes with the one before.
const KERNEL_SCRIPT = String.raw`sudo -n true 2>/dev/null || { echo missing; exit 0; }
boot=$(cat /proc/sys/kernel/random/boot_id); after=$2
[ "$1" = "$boot" ] || after=-1
echo "$boot"
sudo -n dmesg | awk -v after="$after" 'match($0, /^\[ *[0-9]+\.[0-9]+\]/) { split(substr($0, RSTART + 1, RLENGTH - 2), t, "."); at = t[1] * 1000000 + t[2] } at > after' |
  if [ "$after" = -1 ]; then tail -c ${MAX_BYTES}; else head -c ${MAX_BYTES}; fi | base64`;

const KERNEL_TIME = /^\[ *(\d+)\.(\d{6})\]/;

/** A text's last `count` lines (a last line without its newline counts). */
function lastLines(text: string, count: number): string {
  if (count <= 0) return "";
  let at = text.length - (text.endsWith("\n") ? 1 : 0);
  for (let n = 0; n < count; n++) {
    if (at <= 0) return text;
    at = text.lastIndexOf("\n", at - 1);
    if (at === -1) return text;
  }
  return text.slice(at + 1);
}

/** How many of `bytes` hold whole UTF-8 characters: a read can end inside one. */
function wholeCharacters(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!;
    if (byte < 0x80) return bytes.length; // ASCII: whole
    if (byte >= 0xc0) return back < (byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2) ? bytes.length - back : bytes.length; // a lead byte
  }
  return bytes.length;
}

/** Bytes after their first newline: a read that starts inside a line drops that line. */
const fromNextLine = (bytes: Buffer) => bytes.subarray(bytes.indexOf(0x0a) + 1);
/** Bytes up to their last newline: a read cut short drops its cut line. */
const toLastLine = (bytes: Buffer) => bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1);

/** The time (µs since boot) of the last line of `text` that has one. */
function lastKernelTime(text: string): number | undefined {
  for (const line of text.split("\n").reverse()) {
    const time = KERNEL_TIME.exec(line);
    if (time) return Number(time[1]) * 1_000_000 + Number(time[2]);
  }
  return undefined;
}

/** What the guest printed: its header line, and the bytes after it. */
function output(text: string): { head: string; bytes: Buffer } {
  const newline = text.indexOf("\n");
  if (newline === -1) return { head: text.trim(), bytes: Buffer.alloc(0) };
  return { head: text.slice(0, newline).trim(), bytes: Buffer.from(text.slice(newline + 1), "base64") };
}

/** A guest's read: its text, where the next read goes on, and whether it went on from `after` or read anew. */
interface GuestRead {
  text: string;
  cursor: LogCursor;
  anew: boolean;
}

/**
 * Reads one of a pet's logs in its running VM: the last `lines` lines, or with `after` (a cursor from a read before)
 * what was appended since. A log that started over (replaced, shrunk, a new boot) says so and gives its last lines.
 */
export async function readPetLog(exec: Exec, source: PetLogSource, { lines = 200, after }: { lines?: number; after?: string } = {}): Promise<PetLogView> {
  const { file, label } = PET_LOG_SOURCES[source];
  const since = after === undefined ? undefined : parseCursor(after);
  const script = file ? [FILE_SCRIPT, "sh", file] : [KERNEL_SCRIPT, "sh"];
  const result = await exec(["sh", "-c", ...script, since?.log ?? "", String(since?.at ?? 0)]);
  if (!result.ok) throw new Error(`could not read the ${label.toLowerCase()} log`);
  const { head, bytes } = output(result.output);
  if (head === "missing") return { source, text: "", cursor: formatCursor(NO_LOG), missing: true };
  const read = file ? fileRead(head, bytes, since) : kernelRead(head, bytes, since);
  const restarted = read.anew && since !== undefined && since.log !== NO_LOG.log;
  return {
    source,
    text: read.anew ? lastLines(read.text, Math.min(Math.max(0, Math.floor(lines)), MAX_LINES)) : read.text,
    cursor: formatCursor(read.cursor),
    missing: false,
    ...(restarted ? { restarted } : {}),
  };
}

/** A file follows by bytes: the cursor is where the bytes read end, at a whole character. */
function fileRead(head: string, bytes: Buffer, since: LogCursor | undefined): GuestRead {
  const [log = "", offset = "0"] = head.split(" ");
  const start = Number(offset);
  const anew = since === undefined || since.log !== log || since.at !== start;
  const end = wholeCharacters(bytes);
  const whole = bytes.subarray(0, end);
  return { text: (anew && start > 0 ? fromNextLine(whole) : whole).toString("utf8"), cursor: { log, at: start + end }, anew };
}

/** The kernel follows by the time of its last whole line read; its boot tells a VM started again. */
function kernelRead(boot: string, bytes: Buffer, since: LogCursor | undefined): GuestRead {
  const anew = since === undefined || since.log !== boot;
  // A read cut short: its last bytes start inside a line, its first bytes end inside one.
  const whole = bytes.length < MAX_BYTES ? bytes : anew ? fromNextLine(bytes) : toLastLine(bytes);
  const text = whole.toString("utf8");
  return { text, cursor: { log: boot, at: lastKernelTime(text) ?? (anew ? 0 : since.at) }, anew };
}
