import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostHomeStorage } from "../../src/infra/home-storage";
import { runCommand } from "../../src/infra/process";
import { tempDir } from "../helpers";

async function archive(from: string, file: string) {
  expect((await runCommand(["tar", "-cf", file, "-C", from, "."], { env: { COPYFILE_DISABLE: "1" } })).ok).toBe(true);
}

test("host homes round-trip plain tar including dotfiles, long Unicode paths, executable modes, timestamps and internal links", async () => {
  const root = tempDir(), home = join(root, "household.work.sibling.home");
  mkdirSync(home);
  const nested = join(home, ".state", "πολύ-μακρύς-φάκελος-".repeat(8));
  mkdirSync(nested, { recursive: true });
  const script = join(nested, "run.sh");
  writeFileSync(script, "#!/bin/sh\necho test\n"); chmodSync(script, 0o750);
  const at = new Date("2020-01-01T00:00:00Z"); utimesSync(script, at, at);
  writeFileSync(join(home, ".memory"), "portable"); chmodSync(join(home, ".memory"), 0o660);
  symlinkSync(".memory", join(home, "latest"));
  linkSync(join(home, ".memory"), join(home, "hardlink"));
  const storage = new HostHomeStorage(root);
  expect(await storage.volumeHasFiles("missing")).toBe(false);
  const tar = join(tempDir(), "home.tar");
  await storage.saveVolume("household.work.sibling.home", tar);
  expect(statSync(tar).mode & 0o777).toBe(0o600);
  await storage.loadVolume("restored.home", tar);
  const restored = join(root, "restored.home");
  expect(readFileSync(join(restored, ".memory"), "utf8")).toBe("portable");
  expect(statSync(join(restored, ".memory")).mode & 0o777).toBe(0o660);
  expect(readlinkSync(join(restored, "latest"))).toBe(".memory");
  expect(statSync(join(restored, "hardlink")).ino).toBe(statSync(join(restored, ".memory")).ino);
  const restoredScript = join(restored, ".state", "πολύ-μακρύς-φάκελος-".repeat(8), "run.sh");
  expect(statSync(restoredScript).mode & 0o777).toBe(0o750);
  expect(statSync(restoredScript).mtime.toISOString()).toBe(at.toISOString());
  expect(await storage.volumeHasFiles("restored.home")).toBe(true);
  expect(statSync(restored).mode & 0o777).toBe(0o700);
});

test("a failed restore preserves every old home file; successful restore replaces rather than merges", async () => {
  const root = tempDir(), target = join(root, "pet.home"); mkdirSync(target);
  writeFileSync(join(target, "old"), "old memory");
  const storage = new HostHomeStorage(root);
  const broken = join(tempDir(), "broken.tar"); writeFileSync(broken, "not an archive");
  await expect(storage.loadVolume("pet.home", broken)).rejects.toThrow("unsafe Household home archive");
  expect(readFileSync(join(target, "old"), "utf8")).toBe("old memory");
  const source = tempDir(); writeFileSync(join(source, "new"), "new memory");
  const tar = join(tempDir(), "home.tar"); await archive(source, tar);
  await storage.loadVolume("pet.home", tar);
  expect(existsSync(join(target, "old"))).toBe(false);
  expect(readFileSync(join(target, "new"), "utf8")).toBe("new memory");
});

test("symlink roots and destinations never point backups or restores at unrelated directories", async () => {
  const elsewhere = tempDir(); writeFileSync(join(elsewhere, "keep"), "private");
  const root = tempDir(); symlinkSync(elsewhere, join(root, "linked.home"));
  const storage = new HostHomeStorage(root);
  await expect(storage.volumeHasFiles("linked.home")).rejects.toThrow("plain directory");
  await expect(storage.loadVolume("linked.home", "/unused")).rejects.toThrow("plain directory");
  const alias = join(tempDir(), "homes"); symlinkSync(root, alias);
  await expect(new HostHomeStorage(alias).volumeHasFiles("any.home")).rejects.toThrow("root must be a plain directory");
  await expect(storage.volumeHasFiles("../escape")).rejects.toThrow("invalid Household home");
  expect(readFileSync(join(elsewhere, "keep"), "utf8")).toBe("private");
});

test("link-parent writes and traversal archives are refused before extraction", async () => {
  const root = tempDir(), home = join(root, "pet.home"); mkdirSync(home); writeFileSync(join(home, "keep"), "old");
  const storage = new HostHomeStorage(root);
  const source = tempDir(), tar = join(tempDir(), "parent-link.tar");
  mkdirSync(join(source, "safe")); symlinkSync("safe", join(source, "alias"));
  await archive(source, tar);
  rmSync(join(source, "alias")); mkdirSync(join(source, "alias")); writeFileSync(join(source, "alias", "write"), "attack");
  expect((await runCommand(["tar", "-rf", tar, "-C", source, "alias/write"])).ok).toBe(true);
  await expect(storage.loadVolume("pet.home", tar)).rejects.toThrow("unsafe Household home archive");
  // A case-insensitive Mac filesystem must not turn a distinct archive spelling into a link parent.
  const aliased = join(tempDir(), "case-alias.tar"), aliasSource = tempDir();
  symlinkSync("/tmp", join(aliasSource, "Alias"));
  await archive(aliasSource, aliased);
  rmSync(join(aliasSource, "Alias")); mkdirSync(join(aliasSource, "alias")); writeFileSync(join(aliasSource, "alias", "child"), "attack");
  expect((await runCommand(["tar", "-rf", aliased, "-C", aliasSource, "alias/child"])).ok).toBe(true);
  await expect(storage.loadVolume("pet.home", aliased)).rejects.toThrow("unsafe Household home archive");
  const traversal = join(tempDir(), "traversal.tar");
  writeFileSync(join(source, "file"), "attack");
  expect((await runCommand(["tar", "-cf", traversal, "-C", source, "-s", ",^file$,../outside,", "file"])).ok).toBe(true);
  await expect(storage.loadVolume("pet.home", traversal)).rejects.toThrow("unsafe Household home archive");
  expect(readFileSync(join(home, "keep"), "utf8")).toBe("old");
});

test("inert guest absolute/external symlinks survive backup without reading or writing their host targets", async () => {
  const root = tempDir(), home = join(root, "pet.home"); mkdirSync(home);
  const outside = join(tempDir(), "private"); writeFileSync(outside, "must remain private");
  symlinkSync(outside, join(home, "outside"));
  symlinkSync("/opt/codex/tools/apply_patch", join(home, "apply_patch"));
  symlinkSync("../guest-path", join(home, "relative"));
  const file = join(tempDir(), "home.tar"), storage = new HostHomeStorage(root);
  await storage.saveVolume("pet.home", file);
  await storage.loadVolume("restored.home", file);
  expect(readlinkSync(join(root, "restored.home", "outside"))).toBe(outside);
  expect(readlinkSync(join(root, "restored.home", "apply_patch"))).toBe("/opt/codex/tools/apply_patch");
  expect(readlinkSync(join(root, "restored.home", "relative"))).toBe("../guest-path");
  expect(readFileSync(outside, "utf8")).toBe("must remain private");
  expect(readFileSync(file).includes(Buffer.from("must remain private"))).toBe(false);
});

test("special files cannot be exported as a portable archive", async () => {
  const root = tempDir(), home = join(root, "pet.home"); mkdirSync(home);
  expect((await runCommand(["mkfifo", join(home, "fifo")])).ok).toBe(true);
  const file = join(tempDir(), "home.tar");
  await expect(new HostHomeStorage(root).saveVolume("pet.home", file)).rejects.toThrow("unsafe Household home archive");
  expect(existsSync(file)).toBe(false);
});


test("cancel aborts active restore without changing old files, while later operations remain usable", async () => {
  const root = tempDir(), target = join(root, "pet.home"); mkdirSync(target); writeFileSync(join(target, "old"), "old memory");
  const source = tempDir(); writeFileSync(join(source, "new"), "new memory");
  const tar = join(tempDir(), "home.tar"); await archive(source, tar);
  const storage = new HostHomeStorage(root);
  const pending = storage.loadVolume("pet.home", tar);
  storage.cancel();
  let rejected = false;
  try { await pending; } catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(readFileSync(join(target, "old"), "utf8")).toBe("old memory");
  expect(existsSync(join(target, "new"))).toBe(false);
  await storage.loadVolume("pet.home", tar);
  expect(readFileSync(join(target, "new"), "utf8")).toBe("new memory");
});
