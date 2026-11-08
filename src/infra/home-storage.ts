import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join, posix, resolve } from "node:path";
import { runCommand } from "./process";
import type { StorageRuntime } from "./runtime";

const MAX_HOME = 20 * 1024 ** 3;
const TIMEOUT = 10 * 60_000;
const validVolume = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(name);

/** Host homes retain the existing volume names and plain-tar backup format. */
export class HostHomeStorage implements StorageRuntime {
  private running = new AbortController();
  constructor(private readonly homesDir: string) {}

  cancel(): void {
    this.running.abort();
    this.running = new AbortController();
  }

  private async path(volume: string, create = false): Promise<string | undefined> {
    if (!validVolume(volume)) throw new Error("invalid Household home name");
    const root = await lstat(this.homesDir).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (root && !root.isDirectory()) throw new Error("Household homes root must be a plain directory");
    if (!root && !create) return undefined;
    if (create) await mkdir(this.homesDir, { recursive: true, mode: 0o700 });
    const home = join(await realpath(this.homesDir), volume);
    const info = await lstat(home).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info && !info.isDirectory()) throw new Error("Household home must be a plain directory");
    return home;
  }

  async volumeHasFiles(volume: string): Promise<boolean> {
    const home = await this.path(volume);
    if (!home) return false;
    try { return (await readdir(home)).length > 0; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async saveVolume(volume: string, file: string): Promise<void> {
    const signal = this.running.signal;
    const home = await this.path(volume);
    if (!home) throw new Error("Household home does not exist");
    const stage = await mkdtemp(join(dirname(resolve(file)), ".household-home-save-"));
    try {
      const tar = join(stage, "home.tar");
      const result = await runCommand(["tar", "-cf", tar, "--no-xattrs", "--no-acls", "-C", home, "."], { timeoutMs: TIMEOUT, env: { COPYFILE_DISABLE: "1" }, signal });
      if (!result.ok) throw new Error("could not archive Household home");
      await validateTar(tar, signal);
      await chmod(tar, 0o600);
      await rename(tar, file);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  /** Extract privately, validate completely, then replace by rename; an extraction failure changes no old files. */
  async loadVolume(volume: string, file: string): Promise<void> {
    const signal = this.running.signal;
    const target = (await this.path(volume, true))!;
    const source = await lstat(file);
    if (!source.isFile() || source.size > MAX_HOME) throw new Error("invalid or oversized Household home archive");
    const stage = await mkdtemp(join(dirname(target), ".household-home-restore-"));
    const saved = join(stage, "previous");
    const incoming = join(stage, "home");
    let moved = false;
    try {
      const archive = join(stage, "home.tar");
      await pipeline(createReadStream(file), createWriteStream(archive, { mode: 0o600, flags: "wx" }), { signal });
      await validateTar(archive, signal);
      await mkdir(incoming, { mode: 0o700 });
      const result = await runCommand(["tar", "-xpf", archive, "-C", incoming, "--no-same-owner", "--no-xattrs", "--no-acls"], { timeoutMs: TIMEOUT, env: { COPYFILE_DISABLE: "1" }, signal });
      if (!result.ok) throw new Error("could not extract Household home archive");
      await validateTree(incoming, signal);
      await chmod(incoming, 0o700);
      signal.throwIfAborted();
      // Re-check the destination after the asynchronous extraction, before any rename.
      await this.path(volume);
      try { await rename(target, saved); moved = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await rename(incoming, target); } catch (error) {
        if (moved) { await rename(saved, target); moved = false; }
        throw error;
      }
    } finally {
      // If a rollback rename itself failed, retain the old home for recovery rather than deleting it.
      if (moved && !(await lstat(target).catch(() => undefined))) throw new Error(`old Household home retained at ${saved}`);
      await rm(stage, { recursive: true, force: true });
    }
  }
}

type Entry = { name: string; type: string; link: string };
const unsafe = () => new Error("unsafe Household home archive (path, link, size or unsupported entry)");
function cleanName(name: string): string {
  if (!name || name.startsWith("/") || /[\x00-\x1f\x7f]/.test(name) || name.split("/").includes("..")) throw unsafe();
  // Compare conservatively across case-insensitive/Unicode-normalizing host filesystems.
  return posix.normalize(name).replace(/\/$/, "").normalize("NFD").toLowerCase();
}
function number(bytes: Buffer): number {
  let value: number;
  if (bytes[0]! & 0x80) {
    let binary = BigInt(bytes[0]! & 0x7f);
    for (const byte of bytes.subarray(1)) binary = (binary << 8n) | BigInt(byte);
    value = Number(binary);
  } else {
    const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
    if (text && !/^[0-7]+$/.test(text)) throw unsafe();
    value = text ? parseInt(text, 8) : 0;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_HOME) throw unsafe();
  return value;
}
const string = (bytes: Buffer) => bytes.toString("utf8").replace(/\0.*$/, "");
function pax(bytes: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at);
    const length = Number(bytes.subarray(at, space).toString("ascii"));
    if (space < at || !Number.isSafeInteger(length) || length <= space - at + 2 || at + length > bytes.length || bytes[at + length - 1] !== 10) throw unsafe();
    const entry = bytes.subarray(space + 1, at + length - 1).toString("utf8");
    const equal = entry.indexOf("=");
    if (equal < 1 || /sparse|holes|filetype|realsize/i.test(entry.slice(0, equal))) throw unsafe();
    values[entry.slice(0, equal)] = entry.slice(equal + 1);
    at += length;
  }
  return values;
}

/** Read headers only: file contents stay streamed by tar, bounded by archive and declared expanded sizes. */
async function validateTar(file: string, signal?: AbortSignal): Promise<void> {
  const handle = await open(file, "r");
  try {
    const { size: length } = await handle.stat();
    if (length > MAX_HOME) throw unsafe();
    const entries: Entry[] = [];
    let at = 0, expanded = 0, headers = 0, metadataBytes = 0;
    let global: Record<string, string> = {}, local: Record<string, string> = {};
    let longName: string | undefined, longLink: string | undefined;
    while (at + 512 <= length) {
      signal?.throwIfAborted();
      if (++headers > 400_000) throw unsafe();
      const header = Buffer.alloc(512);
      if ((await handle.read(header, 0, 512, at)).bytesRead !== 512) throw unsafe();
      if (header.every((byte) => byte === 0)) break;
      const checksum = number(header.subarray(148, 156));
      const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (sum !== checksum) throw unsafe();
      const type = string(header.subarray(156, 157)) || "0";
      const rawSize = number(header.subarray(124, 136));
      const meta = { ...global, ...local };
      const contentSize = !["x", "g", "L", "K"].includes(type) && meta.size !== undefined ? Number(meta.size) : rawSize;
      if (!Number.isSafeInteger(contentSize) || contentSize < 0 || contentSize > MAX_HOME) throw unsafe();
      at += 512;
      if (at + contentSize > length) throw unsafe();
      if (["x", "g", "L", "K"].includes(type)) {
        metadataBytes += contentSize;
        if (contentSize > 1024 * 1024 || metadataBytes > 32 * 1024 * 1024) throw unsafe();
        const body = Buffer.alloc(contentSize);
        if ((await handle.read(body, 0, contentSize, at)).bytesRead !== contentSize) throw unsafe();
        if (type === "x") local = { ...local, ...pax(body) };
        else if (type === "g") global = { ...global, ...pax(body) };
        else if (type === "L") longName = string(body);
        else longLink = string(body);
      } else {
        if (!["0", "1", "2", "5"].includes(type)) throw unsafe();
        const prefix = string(header.subarray(345, 500));
        const basic = string(header.subarray(0, 100));
        const name = cleanName(meta.path ?? longName ?? (prefix ? `${prefix}/${basic}` : basic));
        const link = meta.linkpath ?? longLink ?? string(header.subarray(157, 257));
        // Symlinks keep guest filesystem semantics, including absolute /opt tool paths. They remain
        // inert leaves: no archive member may ever be written under a link (checked below), and neither
        // archive export nor post-extraction validation dereferences them on the host.
        if (type === "2" && (!link || /[\x00-\x1f\x7f]/.test(link))) throw unsafe();
        if (type === "1") cleanName(link);
        entries.push({ name, type, link });
        expanded += contentSize;
        if (expanded > MAX_HOME) throw unsafe();
        local = {}; longName = longLink = undefined;
      }
      at += Math.ceil(contentSize / 512) * 512;
    }
    if (entries.length === 0) throw unsafe();
    const types = new Map<string, Set<string>>();
    for (const { name, type } of entries) types.set(name, (types.get(name) ?? new Set()).add(type));
    const files = new Set(entries.filter(({ type }) => type === "0").map(({ name }) => name));
    const links = new Set(entries.filter(({ type }) => type === "1" || type === "2").map(({ name }) => name));
    for (const entry of entries) {
      const parts = entry.name.split("/");
      for (let i = 1; i < parts.length; i++) if (links.has(parts.slice(0, i).join("/"))) throw unsafe();
      // Disallow duplicate-type tricks (a file first, a symlink later, then a file under it).
      if (links.has(entry.name) && types.get(entry.name)!.size > 1) throw unsafe();
      if (entry.type === "1" && !files.has(cleanName(entry.link))) throw unsafe();
    }
  } finally { await handle.close(); }
}

async function validateTree(root: string, signal?: AbortSignal): Promise<void> {
  for (const name of await readdir(root)) {
    signal?.throwIfAborted();
    const path = join(root, name), info = await lstat(path);
    if (info.isDirectory()) await validateTree(path, signal);
    else if (!info.isFile() && !info.isSymbolicLink()) throw unsafe();
    if (!info.isSymbolicLink()) await chmod(path, info.mode & 0o777); // never restore setuid/setgid/sticky bits
  }
}
