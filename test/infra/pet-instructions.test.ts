import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PetInstructions, DEFAULT_AGENT_INSTRUCTIONS } from "../../src/infra/pet-instructions";
import { tempDir } from "../helpers";

test("instructions share one document through native adapter paths and reject stale saves", async () => {
  const root = tempDir(), store = new PetInstructions(root);
  const first = await store.read("work", "pet", ".codex/AGENTS.md");
  expect(first.content).toBe(DEFAULT_AGENT_INSTRUCTIONS);
  const home = join(root, "household.work.pet.home");
  expect(readlinkSync(join(home, first.path))).toBe("../.household/AGENTS.md");
  const saved = await store.write("work", "pet", first.path, [], "# Custom\n", first.revision);
  expect(readFileSync(join(home, first.path), "utf8")).toBe(saved.content);
  expect((await store.read("work", "pet", ".claude/CLAUDE.md")).content).toBe(saved.content);
  expect((await store.read("work", "other", first.path)).content).toBe(DEFAULT_AGENT_INSTRUCTIONS);
  await expect(store.write("work", "pet", first.path, [], "stale", first.revision)).rejects.toMatchObject({status:409});
  await expect(store.write("work", "pet", first.path, [], "é".repeat(20000), saved.revision)).rejects.toMatchObject({status:400});
});

test("existing native instructions migrate with a backup; conflicting originals stay intact", async () => {
  const root = tempDir(), store = new PetInstructions(root), dir = join(root, "household.work.pet.home/.claude");
  mkdirSync(dir, {recursive:true}); writeFileSync(join(dir,"CLAUDE.md"), "original");
  expect((await store.read("work","pet",".claude/CLAUDE.md")).content).toBe("original");
  expect(readdirSync(dir).some(n=>n.startsWith("CLAUDE.md.before-household-"))).toBe(true);
  const codex = join(root,"household.work.pet.home/.codex"); mkdirSync(codex);
  writeFileSync(join(codex,"AGENTS.md"),"different");
  await expect(store.read("work","pet",".codex/AGENTS.md")).rejects.toThrow("differ");
  expect(readFileSync(join(codex,"AGENTS.md"),"utf8")).toBe("different");
});

test("guest symlinks and native overrides cannot redirect or hide the edited document", async () => {
  const root = tempDir(), outside = tempDir(), store = new PetInstructions(root);
  symlinkSync(outside, join(root,"household.work.escape.home"));
  await expect(store.read("work","escape",".codex/AGENTS.md")).rejects.toMatchObject({status:400});
  const home = join(root,"household.work.pet.home"); mkdirSync(home);
  symlinkSync(outside, join(home,".household"));
  await expect(store.read("work","pet",".codex/AGENTS.md")).rejects.toMatchObject({status:400});
  expect(readdirSync(outside)).toEqual([]);
  const native = join(root,"household.work.override.home/.codex"); mkdirSync(native,{recursive:true});
  writeFileSync(join(native,"AGENTS.override.md"),"override");
  await expect(store.read("work","override",".codex/AGENTS.md",[".codex/AGENTS.override.md"])).rejects.toThrow("override");
});
