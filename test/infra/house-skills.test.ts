import { expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HouseSkills, PetSkills } from "../../src/infra/house-skills";
import { tempDir } from "../helpers";

test("house files share one source; stale saves/deletes and concurrent web saves cannot overwrite", async () => {
  const store = new HouseSkills(tempDir());
  const first = await store.write("work", "review/SKILL.md", "# Review\n", null);
  expect((await store.list("work")).map(e => e.path)).toEqual(["review", "review/SKILL.md"]);
  const results = await Promise.allSettled([store.write("work", first.path, "one", first.revision), store.write("work", first.path, "two", first.revision)]);
  expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
  await expect(store.delete("work", first.path, first.revision)).rejects.toThrow("changed");
  expect((await store.read("work", first.path)).content).toBe("one");
  expect(await store.list("personal")).toEqual([]);
  const current = await store.read("work", first.path);
  await store.delete("work", first.path, current.revision);
  await expect(store.read("work", first.path)).rejects.toThrow("not found");
});

test("filesystem editor rejects traversal, symlink parents/files, hard links, binary and oversized files", async () => {
  const store = new HouseSkills(tempDir());
  const root = await store.ensure("work"), outside = tempDir();
  writeFileSync(join(outside, "secret"), "PRIVATE");
  symlinkSync(outside, join(root, "escape"));
  for (const path of ["../secret", "/secret", "escape/secret", "a/../../secret"]) {
    await expect(store.write("work", path, "oops", null)).rejects.toThrow();
    await expect(store.read("work", path)).rejects.toThrow();
  }
  mkdirSync(join(root, "normal"));
  symlinkSync(join(outside, "secret"), join(root, "normal", "link"));
  linkSync(join(outside, "secret"), join(root, "normal", "hard"));
  writeFileSync(join(root, "normal", "binary"), Buffer.from([0, 255]));
  writeFileSync(join(root, "normal", "large"), "a".repeat(512 * 1024 + 1));
  for (const path of ["normal/link", "normal/hard", "normal/binary", "normal/large"]) await expect(store.read("work", path)).rejects.toThrow();
  expect(readFileSync(join(outside, "secret"), "utf8")).toBe("PRIVATE");
});

test("editing scripts retains executable mode; unicode round trips exactly; pet edits conflict", async () => {
  const store = new HouseSkills(tempDir());
  const file = await store.write("work", "review/scripts/check.sh", "#!/bin/sh\n", null);
  const path = join(store.path("work"), file.path);
  chmodSync(path, 0o755);
  const next = await store.write("work", file.path, "#!/bin/sh\necho 'Grüß dich 🐾'\n", file.revision);
  expect(statSync(path).mode & 0o777).toBe(0o755);
  expect((await store.read("work", file.path)).content).toBe(next.content);
  writeFileSync(path, "changed by pet");
  await expect(store.write("work", file.path, "stale", next.revision)).rejects.toThrow("changed");
});


test("hidden supporting files remain editable within an ordinary skill", async () => {
  const store = new HouseSkills(tempDir());
  await store.write("work", "review/scripts/.config", "resource", null);
  expect((await store.list("work")).some(e => e.path === "review/scripts/.config")).toBe(true);
  expect((await store.read("work", "review/scripts/.config")).content).toBe("resource");
});


test("workspace skill CRUD edits the mounted home, independently of shared and other pet skills", async () => {
  const homes = tempDir(), store = new PetSkills(homes);
  const pet = store.at("work", "owl", "work/.claude/skills");
  const file = await pet.write("review/SKILL.md", "# Local review", null);
  expect(readFileSync(join(homes, "household.work.owl.home/work/.claude/skills/review/SKILL.md"), "utf8")).toBe("# Local review");
  expect((await pet.list()).map(e => e.path)).toEqual(["review", "review/SKILL.md"]);
  expect(await store.at("work", "cat", "work/.agents/skills").list()).toEqual([]);
  const changed = await pet.write(file.path, "# Changed", file.revision);
  await expect(pet.write(file.path, "# Stale", file.revision)).rejects.toThrow("changed");
  await pet.delete(file.path, changed.revision);
  expect(await pet.list()).toEqual([]);
});

test("workspace skill roots cannot traverse guest symlinks to host files", async () => {
  const homes = tempDir(), outside = tempDir(), store = new PetSkills(homes);
  mkdirSync(join(homes, "household.work.owl.home"));
  symlinkSync(outside, join(homes, "household.work.owl.home/work"));
  await expect(store.at("work", "owl", "work/.agents/skills").write("review/SKILL.md", "unsafe", null)).rejects.toThrow("Unsafe");
  expect(() => store.at("work", "owl", "../outside")).toThrow("Invalid");
});
