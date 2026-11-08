import { expect, test } from "bun:test";
import { linkSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PetOutboxFiles } from "../../src/infra/pet-outbox";
import { tempDir } from "../helpers";

const VOLUME = "household.work.sibling.home";
function setup() {
  const homes = realpathSync(tempDir());
  const home = join(homes, VOLUME);
  mkdirSync(home);
  return { homes, home, files: new PetOutboxFiles(homes) };
}

test("reads nested binary files byte-for-byte and retains originals", async () => {
  const { home, files } = setup();
  const outbox = join(home, ".household/outbox/rapports-été");
  mkdirSync(outbox, { recursive: true });
  const data = new Uint8Array([0, 255, 32, 10, 13, 0]);
  writeFileSync(join(outbox, "image.png"), data);
  expect(await files.read(VOLUME, "rapports-été/image.png", data.length)).toEqual(data);
  expect(new Uint8Array(readFileSync(join(outbox, "image.png")))).toEqual(data);
  await expect(files.read(VOLUME, "rapports-été/image.png", data.length - 1)).rejects.toThrow("size limit");
});

test("refuses invalid paths, volume names and limits", async () => {
  const { files } = setup();
  for (const path of ["", "/etc/passwd", "../secret", "dir/../../secret", "./a", "dir//a", "dir/", "a\0b"]) {
    await expect(files.read(VOLUME, path, 10)).rejects.toThrow("path must be relative");
  }
  await expect(files.read("../home", "a", 10)).rejects.toThrow("invalid Household home");
  for (const limit of [0, -1, Infinity, 0.5]) await expect(files.read(VOLUME, "a", limit)).rejects.toThrow("size limit");
  await expect(files.read(VOLUME, "missing", 10)).rejects.toThrow("unsafe or unavailable");
});

test("refuses links at every directory boundary and at the file", async () => {
  for (const component of [VOLUME, ".household", "outbox", "nested", "secret"]) {
    const homes = realpathSync(tempDir());
    const outside = realpathSync(tempDir());
    writeFileSync(join(outside, "secret"), "private");
    const parts = [VOLUME, ".household", "outbox", "nested", "secret"];
    const index = parts.indexOf(component);
    const parent = join(homes, ...parts.slice(0, index));
    mkdirSync(parent, { recursive: true });
    symlinkSync(component === "secret" ? join(outside, "secret") : outside, join(parent, component));
    await expect(new PetOutboxFiles(homes).read(VOLUME, "nested/secret", 100)).rejects.toThrow("unsafe or unavailable");
  }
});

test("refuses hard links, directories and FIFOs without blocking", async () => {
  const { home, files } = setup();
  const outbox = join(home, ".household/outbox");
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(home, "secret"), "private");
  linkSync(join(home, "secret"), join(outbox, "hardlink"));
  mkdirSync(join(outbox, "directory"));
  expect(Bun.spawnSync(["mkfifo", join(outbox, "pipe")]).exitCode).toBe(0);
  for (const name of ["hardlink", "directory", "pipe"]) {
    await expect(files.read(VOLUME, name, 100)).rejects.toThrow("regular file");
  }
});
