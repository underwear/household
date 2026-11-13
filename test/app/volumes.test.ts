import { expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { VolumeRequests } from "../../src/app/volumes";
import type { OwnerCard } from "../../src/app/chat";
import type { House } from "../../src/core/household";
import type { Volume } from "../../src/core/volumes";
import { botsTouched, volumesOf } from "../../src/core/volumes";
import { countFiles, inspectFolder } from "../../src/infra/volume-folders";
import { fakeClock, tempDir } from "../helpers";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await Bun.sleep(5); };

function setup(volumes: Volume[] = [], protectedDirs: string[] = []) {
  const clock = fakeClock();
  const house: House = { name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ name: "sibling", title: "Sibling" }, { name: "helper" }, { name: "w1", sideworker: { parent: "sibling", cwd: "/x" } }], people: { owners: [] }, channels: [], volumes };
  const notified: string[] = [], written: unknown[][] = [], prepared: string[] = [], released: string[] = [];
  let card: OwnerCard<"waiting" | "approve" | "deny"> | undefined;
  let decide!: (value: "waiting" | "approve" | "deny" | undefined) => void;
  const requests = new VolumeRequests({
    clock, waitMs: 1000, protectedDirs,
    house: () => house,
    current: async () => house,
    volumes: () => (house.volumes ?? []).map(volume => ({ ...volume, house: "work" })),
    write: async (...args) => { written.push(args); },
    affected: async (_house, bots) => house.pets.filter(p => bots.includes(p.name) || (p.sideworker && bots.includes(p.sideworker.parent))).map(p => p.name),
    prepareRestart: async (_house, pet) => { prepared.push(pet); return () => { released.push(pet); }; },
    choose: async (_house, _pet, shown, signal) => { card = shown; return new Promise(resolve => { decide = resolve; signal.addEventListener("abort", () => resolve(undefined), { once: true }); }); },
    notify: (_house, pet, text) => { notified.push(`${pet}: ${text}`); },
    log: () => {},
  });
  return { requests, clock, house, notified, written, prepared, released, card: () => card!, decide: (value: "approve" | "deny" | undefined) => decide(value) };
}

test("a bot asks for a folder with files: the card says what is in it, approval restarts it after its turn and writes it", async () => {
  const dir = await realpath(tempDir());
  const folder = join(dir, "photos");
  await mkdir(join(folder, "2024"), { recursive: true });
  for (const name of ["a.jpg", "b.jpg", "2024/c.jpg"]) await writeFile(join(folder, name), "x");
  const s = setup();
  const answer = await s.requests.request("work", "sibling", { name: "photos", path: folder, access: "write", reason: "Sort the photos" });
  expect(answer).toMatchObject({ status: "pending", action: "create", name: "photos", restarts_vm_if_approved: true });
  expect(s.card().text).toContain("Sibling asks to share a folder");
  expect(s.card().text).toContain("Holds: 3 files");
  expect(s.card().text).toContain("Access: read-write");
  expect(s.card().text).toContain("<code>/volumes/photos</code>");
  expect(s.card().text).toContain("restarts the VM of");
  expect(s.card().view("waiting")).toEqual({ choices: [["Approve"], ["Deny"]] });
  expect(await s.requests.request("work", "helper", { name: "other", path: folder, reason: "x" })).toMatchObject({ status: "busy" });
  s.decide("approve"); await flush();
  expect(s.prepared.sort()).toEqual(["sibling", "w1"]); // its sideworker sees its folders too
  expect(s.written).toEqual([["work", "photos", { name: "photos", path: folder, access: "write", bots: ["sibling"] }, null]]);
  expect(s.released.sort()).toEqual(["sibling", "w1"]);
  expect(s.notified.at(-1)).toContain("mounted at /volumes/photos (read-write)");
});

test("a missing folder is created on approval; a denied request changes nothing", async () => {
  const dir = tempDir();
  const missing = join(dir, "new", "inbox");
  const s = setup();
  await s.requests.request("work", "sibling", { name: "inbox", path: missing, reason: "Drop zone" });
  expect(s.card().text).toContain("does not exist yet");
  s.decide("deny"); await flush();
  expect(s.written).toEqual([]);
  expect(existsSync(missing)).toBe(false);
  expect(s.notified.at(-1)).toContain("denied");
  await s.requests.request("work", "sibling", { name: "inbox", path: missing, reason: "Drop zone" });
  s.decide("approve"); await flush();
  expect(existsSync(missing)).toBe(true);
  expect(s.written[0]![2]).toMatchObject({ access: "read", bots: ["sibling"] });
});

test("update and delete show before and after; delete only unmounts", async () => {
  const dir = await realpath(tempDir());
  const volume: Volume = { name: "docs", path: dir, access: "read", bots: ["sibling"] };
  const s = setup([volume]);
  expect(await s.requests.request("work", "sibling", { action: "update", name: "docs", bots: ["sibling", "helper"], reason: "Helper needs them" })).toMatchObject({ restarts_vm_if_approved: false });
  expect(s.card().text).toContain("Before:");
  expect(s.card().text).toContain("After:");
  s.decide("approve"); await flush();
  expect(s.prepared).toEqual(["helper"]); // sibling's mounts did not change
  expect(s.written[0]).toEqual(["work", "docs", { name: "docs", path: dir, access: "read", bots: ["sibling", "helper"] }, volume]);
  await s.requests.request("work", "sibling", { action: "delete", name: "docs", reason: "Done" });
  expect(s.card().text).toContain("the folder and its files stay");
  expect(s.card().view("waiting")).toEqual({ choices: [["Stop sharing"], ["Deny"]] });
});

test("refused without a card: Household's own folders, unknown bots, an existing name, a sideworker asking", async () => {
  const dir = tempDir();
  const state = join(dir, "state");
  await mkdir(join(state, "homes"), { recursive: true });
  const s = setup([{ name: "docs", path: dir, access: "read", bots: [] }], [state]);
  expect(await s.requests.request("work", "sibling", { name: "x", path: join(state, "homes"), reason: "r" })).toMatchObject({ status: "refused" });
  expect(await s.requests.request("work", "sibling", { name: "x", path: dir, reason: "r" })).toMatchObject({ status: "refused", message: expect.stringContaining("holds") });
  expect(await s.requests.request("work", "sibling", { name: "x", path: "/", reason: "r" })).toMatchObject({ status: "refused" });
  expect(await s.requests.request("work", "sibling", { name: "docs", path: join(dir, "a"), reason: "r" })).toMatchObject({ status: "refused" });
  expect(await s.requests.request("work", "sibling", { name: "y", path: join(dir, "a"), bots: ["ghost"], reason: "r" })).toMatchObject({ status: "refused" });
  expect(await s.requests.request("work", "w1", { name: "y", path: join(dir, "a"), reason: "r" })).toMatchObject({ status: "refused" });
  await expect(s.requests.request("work", "sibling", { action: "delete", name: "docs", path: "/x", reason: "r" })).rejects.toThrow();
  expect(s.card).toBeDefined();
});

test("folders: ~ expands, a credentials folder is flagged, files are counted up to a cap", async () => {
  const dir = tempDir();
  for (let i = 0; i < 12; i++) await writeFile(join(dir, `f${i}`), "");
  expect(await countFiles(dir, 5)).toEqual({ files: 5, capped: true });
  expect(await countFiles(dir)).toEqual({ files: 12, capped: false });
  const ssh = await inspectFolder("~/.ssh/nonexistent-household-test", []);
  expect(ssh.path.startsWith(homedir()) || ssh.path.includes(".ssh")).toBe(true);
  expect(ssh.warning).toContain(".ssh");
  expect(ssh.exists).toBe(false);
});

test("volumesOf and botsTouched: a sideworker gets its parent's, a scout none; only bots whose mounts change", () => {
  const house = { volumes: [{ name: "a", path: "/a", access: "read" as const, bots: ["sibling"] }] };
  expect(volumesOf(house, { name: "w1", sideworker: { parent: "sibling" } }).map(v => v.name)).toEqual(["a"]);
  expect(volumesOf(house, { name: "s", scout: {} })).toEqual([]);
  const before = house.volumes;
  expect(botsTouched(before, [{ ...before[0]!, note: "x" } as Volume])).toEqual([]);
  expect(botsTouched(before, [{ ...before[0]!, access: "write" }])).toEqual(["sibling"]);
  expect(botsTouched(before, [{ ...before[0]!, bots: ["sibling", "helper"] }])).toEqual(["helper"]);
});

test("no volume inside a read-write one, and a read-write one holds none: a bot could swap a folder for a link", async () => {
  const dir = await realpath(tempDir());
  await mkdir(join(dir, "sub"));
  const s = setup([{ name: "projects", path: dir, access: "write", bots: ["sibling"] }]);
  expect(await s.requests.request("work", "sibling", { name: "sub", path: join(dir, "sub"), reason: "r" })).toMatchObject({ status: "refused", message: expect.stringContaining("inside the read-write volume projects") });
  const t = setup([{ name: "sub", path: join(dir, "sub"), access: "read", bots: ["sibling"] }]);
  expect(await t.requests.request("work", "sibling", { name: "all", path: dir, access: "write", reason: "r" })).toMatchObject({ status: "refused", message: expect.stringContaining("holds the volume sub") });
  expect(await t.requests.request("work", "sibling", { name: "all", path: dir, access: "read", reason: "r" })).toMatchObject({ status: "pending" });
});

test("parallel requests get one card; refused ones count toward the hour", async () => {
  const dir = await realpath(tempDir());
  const s = setup();
  const answers = await Promise.all([1, 2, 3].map(i => s.requests.request("work", "sibling", { name: `f${i}`, path: join(dir, `f${i}`), reason: "r" })));
  expect(answers.map(a => a.status).sort()).toEqual(["busy", "busy", "pending"]);
  const t = setup();
  for (let i = 0; i < 10; i++) await t.requests.request("work", "sibling", { name: "x", path: "/", reason: "r" });
  expect(await t.requests.request("work", "sibling", { name: "y", path: join(dir, "y"), reason: "r" })).toMatchObject({ status: "busy" });
});

test("an approval checks the folder again; an unchanged path is never created", async () => {
  const dir = await realpath(tempDir());
  const gone = join(dir, "unplugged");
  const s = setup([{ name: "nas", path: gone, access: "read", bots: ["sibling"] }]);
  await s.requests.request("work", "sibling", { action: "update", name: "nas", bots: ["sibling", "helper"], reason: "r" });
  s.decide("approve"); await flush();
  expect(existsSync(gone)).toBe(false);
  expect(s.written).toHaveLength(1);
  const folder = join(dir, "real");
  await mkdir(folder);
  const t = setup();
  await t.requests.request("work", "sibling", { name: "real", path: folder, reason: "r" });
  const { rm, symlink } = await import("node:fs/promises");
  await rm(folder, { recursive: true });
  await symlink(dir, folder);
  t.decide("approve"); await flush();
  expect(t.written).toEqual([]);
  expect(t.notified.at(-1)).toContain("no longer the one that was shown");
});
