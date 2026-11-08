import { createHash } from "node:crypto";
import { createReadStream, closeSync, openSync } from "node:fs";
import { lstat, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { HostHomeStorage } from "../../src/infra/home-storage";

/** Explicit opt-in only. Private contents never appear in assertions or logs, and all copies are ephemeral. */
const backup = process.env.HOUSEHOLD_PRIVATE_BACKUP;
const enabled = backup ? test : test.skip;

type Snapshot = { files: number; directories: number; links: number; digest: string };
async function snapshot(root: string): Promise<Snapshot> {
  const hash = createHash("sha256");
  let files = 0, directories = 0, links = 0;
  const walk = async (dir: string, prefix = "") => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), relative = join(prefix, name), info = await lstat(path);
      hash.update(JSON.stringify([relative, info.mode & 0o777, info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file"]));
      if (info.isSymbolicLink()) { links++; hash.update(await readlink(path)); }
      else if (info.isDirectory()) { directories++; await walk(path, relative); }
      else {
        files++;
        hash.update(String(info.mtimeMs));
        for await (const part of createReadStream(path)) hash.update(part);
      }
    }
  };
  await walk(root);
  return { files, directories, links, digest: hash.digest("hex") };
}

async function tarOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "ignore", timeout: 60_000, killSignal: "SIGKILL" });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error("private backup listing failed");
  return output;
}

enabled("private pre-microVM home archive restores and round-trips file counts, modes, links and file hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-private-compat-"));
  try {
    const entries = (await tarOutput(["-tzf", backup!])).split("\n").filter((entry) => /^\.\/volumes\/[a-z0-9._-]+\.tar$/.test(entry));
    expect(entries.length > 0).toBe(true);
    const storage = new HostHomeStorage(join(root, "homes"));
    for (let i = 0; i < entries.length; i++) {
      const nested = join(root, `source-${i}.tar`);
      const fd = openSync(nested, "wx", 0o600);
      try {
        const extract = Bun.spawn(["tar", "-xzOf", backup!, entries[i]!], { stdout: fd, stderr: "ignore", timeout: 60_000, killSignal: "SIGKILL" });
        if (await extract.exited !== 0) throw new Error("private nested home extraction failed");
      } finally { closeSync(fd); }
      const originalTypes = (await tarOutput(["-tvf", nested])).split("\n").filter(Boolean).map((line) => line[0]);
      await storage.loadVolume(`source-${i}.home`, nested);
      const first = await snapshot(join(root, "homes", `source-${i}.home`));
      expect(first.files === originalTypes.filter((type) => type === "-" || type === "h").length).toBe(true);
      expect(first.links === originalTypes.filter((type) => type === "l").length).toBe(true);
      const repacked = join(root, `repacked-${i}.tar`);
      await storage.saveVolume(`source-${i}.home`, repacked);
      await storage.loadVolume(`restored-${i}.home`, repacked);
      const second = await snapshot(join(root, "homes", `restored-${i}.home`));
      expect(first.digest === second.digest).toBe(true);
      expect(first.files === second.files && first.directories === second.directories && first.links === second.links).toBe(true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
