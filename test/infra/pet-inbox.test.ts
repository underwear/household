import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PetInboxFiles } from "../../src/infra/pet-inbox";
import { inboxFileName, type FileRef } from "../../src/core/attachment";
import { tempDir } from "../helpers";

const bytes = (text: string) => new TextEncoder().encode(text);
const VOLUME = "household.work.sibling.home";

function setup() {
  const homes = realpathSync(tempDir());
  const home = join(homes, VOLUME);
  mkdirSync(home);
  return { homes, home, files: new PetInboxFiles(homes) };
}

/** Sets a file's (or link's own) time `days` back. */
const age = (path: string, days: number) => {
  const then = new Date(Date.now() - days * 24 * 60 * 60_000);
  if (lstatSync(path).isSymbolicLink()) return Bun.spawnSync(["touch", "-h", "-t", stamp(then), path]);
  utimesSync(path, then, then);
};
const stamp = (date: Date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}0000`;

test("valid multibyte attachment names fit the inbox's byte limit and keep their contents", async () => {
  const { home, files } = setup();
  const name = inboxFileName("m999", { kind: "document", file: "f" as FileRef, name: `${"𝒜".repeat(60)}.txt` });
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
  expect(name).toMatch(/^m999-𝒜+\.txt$/u);
  const path = await files.save(VOLUME, "2026-11-06", name, bytes("UNICODE-472"));
  expect(readFileSync(join(home, path), "utf8")).toBe("UNICODE-472");
});

test("a file is saved privately in its day's directory, atomically, never over another of the same name", async () => {
  const { home, files } = setup();
  expect(await files.save(VOLUME, "2026-11-06", "m3-photo.jpg", bytes("one"))).toBe(".household/inbox/2026-11-06/m3-photo.jpg");
  expect(await files.save(VOLUME, "2026-11-06", "m3-photo.jpg", bytes("two"))).toBe(".household/inbox/2026-11-06/m3-photo-2.jpg");
  const day = join(home, ".household/inbox/2026-11-06");
  expect(readdirSync(day).sort()).toEqual(["m3-photo-2.jpg", "m3-photo.jpg"]); // no temporary file left
  expect(readFileSync(join(day, "m3-photo.jpg"), "utf8")).toBe("one");
  expect(lstatSync(join(day, "m3-photo.jpg")).mode & 0o777).toBe(0o600);
  expect(lstatSync(day).mode & 0o777).toBe(0o700);
});

test("names and days that could leave the inbox are refused; so is a home that is not there", async () => {
  const { files } = setup();
  for (const name of ["../escape.txt", ".hidden", "a/b.txt", ""]) await expect(files.save(VOLUME, "2026-11-06", name, bytes("x"))).rejects.toThrow("Invalid file name");
  await expect(files.save(VOLUME, "../..", "a.txt", bytes("x"))).rejects.toThrow("Invalid day");
  await expect(files.save("../other", "2026-11-06", "a.txt", bytes("x"))).rejects.toThrow("invalid Household home name");
  await expect(files.save("household.work.gone.home", "2026-11-06", "a.txt", bytes("x"))).rejects.toThrow("unsafe or unavailable inbox path");
});

test("a link the pet put in the way is never followed: nothing is written outside its home", async () => {
  const outside = tempDir();
  for (const [link, at] of [[".household", ""], ["inbox", ".household"], ["2026-11-06", ".household/inbox"]] as const) {
    const { home, files } = setup();
    mkdirSync(join(home, at), { recursive: true });
    symlinkSync(outside, join(home, at, link));
    await expect(files.save(VOLUME, "2026-11-06", "m1-a.txt", bytes("x"))).rejects.toThrow("unsafe or unavailable inbox path");
  }
  expect(readdirSync(outside)).toEqual([]);
});

test("the sweep deletes what is older than its time, keeps what is newer, removes empty old days, and never follows a link", async () => {
  const { homes, home, files } = setup();
  const inbox = join(home, ".household/inbox");
  const old = join(inbox, "2026-11-01"), today = join(inbox, "2026-11-06"), mixed = join(inbox, "2026-11-04");
  for (const dir of [old, today, mixed]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(old, "m1-a.jpg"), "a");
  writeFileSync(join(mixed, "m2-old.jpg"), "b");
  writeFileSync(join(mixed, "m3-new.jpg"), "c");
  writeFileSync(join(today, "m4-new.jpg"), "d");
  // A link to a file outside, old itself: the link goes, the file it points to stays.
  const outside = tempDir();
  writeFileSync(join(outside, "precious.txt"), "keep");
  age(join(outside, "precious.txt"), 10);
  symlinkSync(join(outside, "precious.txt"), join(old, "link.txt"));
  // A day that is a link to a directory outside, with old files: never entered.
  writeFileSync(join(outside, "old.txt"), "keep");
  age(join(outside, "old.txt"), 10);
  symlinkSync(outside, join(inbox, "2026-10-01"));
  for (const path of [join(old, "m1-a.jpg"), join(old, "link.txt"), join(mixed, "m2-old.jpg"), join(inbox, "2026-10-01")]) age(path, 5);
  age(old, 5);
  age(mixed, 5);

  expect(await files.sweep(new Date(Date.now() - 3 * 24 * 60 * 60_000))).toBe(4); // two files, two links
  expect(readdirSync(inbox).sort()).toEqual(["2026-11-04", "2026-11-06"]);
  expect(readdirSync(mixed)).toEqual(["m3-new.jpg"]);
  expect(readdirSync(today)).toEqual(["m4-new.jpg"]);
  expect(readdirSync(outside).sort()).toEqual(["old.txt", "precious.txt"]);
  // An inbox that is itself a link (to that outside directory) is not swept; nor is a home that is one.
  const other = join(homes, "household.work.chair.home");
  mkdirSync(join(other, ".household"), { recursive: true });
  symlinkSync(outside, join(other, ".household/inbox"));
  symlinkSync(outside, join(homes, "household.work.link.home"));
  expect(await files.sweep(new Date())).toBe(2); // only the two new files of the first home
  expect(readdirSync(outside).sort()).toEqual(["old.txt", "precious.txt"]);
  expect(existsSync(join(other, ".household/inbox"))).toBe(true);
});

test("no homes yet: nothing to sweep", async () => {
  expect(await new PetInboxFiles(join(tempDir(), "none")).sweep(new Date())).toBe(0);
});
