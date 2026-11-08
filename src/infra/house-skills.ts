import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertName, assertPetName } from "../core/names";
import { runCommand } from "./process";
import { readFileSync, mkdirSync, lstatSync, realpathSync, readdirSync, existsSync } from "node:fs";
import helper from "./skills-files.py" with { type: "text" };
import { COMPILED, releaseShare } from "./release";

export interface SkillEntry { path: string; kind: "file" | "directory" | "unsupported"; size: number }
export interface SkillFile { path: string; content: string; revision: string }
export class SkillFileError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export const houseSkillsRoot = (stateDir: string) => join(stateDir, "house-skills");
export const GUEST_SKILLS = "/opt/household/skills";
/**
 * Household's own skills, mounted read-only into every VM that has the house's skills: in this repository, or in a
 * release's `share/` (a mount needs a real directory, not one inside a compiled binary).
 */
export const BUILTIN_SKILLS = COMPILED ? join(releaseShare(), "builtin-skills") : fileURLToPath(new URL("../builtin-skills", import.meta.url));
export const GUEST_BUILTIN_SKILLS = "/opt/household/builtin-skills";
/** Where a pet's personal skills are, in its home, whatever its agent: every harness's project skills link here. */
export const PERSONAL_SKILLS = "work/.agents/skills";

/** A built-in skill as the admin shows it: read-only. */
export interface BuiltinSkill { name: string; description: string; content: string }

/** Household's own skills, by name: each `household-*` folder's SKILL.md and the description in its frontmatter. */
export function builtinSkills(root = BUILTIN_SKILLS): BuiltinSkill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.startsWith("household-") && existsSync(join(root, name, "SKILL.md"))).sort().map((name) => {
    const content = readFileSync(join(root, name, "SKILL.md"), "utf8");
    return { name, description: /^description: (.*)$/m.exec(content)?.[1]?.trim() ?? "", content };
  });
}

/** Skill names Household keeps for its own (built-in) skills: neither the house's nor a pet's may take one. */
export const isReservedSkillPath = (path: string) => /^household-/i.test(path.split("/")[0] ?? "");

/**
 * A house skills entry that is a VM's link to one of Household's skills: shown apart, never edited. Only those names:
 * anything else under the prefix stays in sight (and the next VM start moves it aside).
 */
export const isBuiltinLink = (entry: SkillEntry, builtin: readonly string[]) => entry.kind === "unsupported" && builtin.includes(entry.path);

/** Guest-writable files are accessed by an openat/O_NOFOLLOW helper, never host path traversal. */
class SkillFiles {
  private readonly pending = new Map<string, Promise<unknown>>();
  private async call<T>(root: string, op: string, args = {}): Promise<T> {
    const result = await runCommand(["python3", "-c", helper], {
      stdin: JSON.stringify({ root: root, op, ...args }), timeoutMs: 10_000,
    });
    if (!result.ok) throw new SkillFileError("Skills storage unavailable (requires Python 3)", 503);
    const value = JSON.parse(result.stdout);
    if (value.error) throw new SkillFileError(value.error, value.status);
    return value;
  }
  async ensure(root: string) { await this.call(root, "ensure"); return root; }
  list(root: string) { return this.call<SkillEntry[]>(root, "list"); }
  read(root: string, path: string) { return this.call<SkillFile>(root, "read", { path }); }
  private serial<T>(root: string, action: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(root) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(root, next);
    void next.finally(() => { if (this.pending.get(root) === next) this.pending.delete(root); }).catch(() => {});
    return next;
  }
  write(root: string, path: string, content: string, revision: string | null) { return this.serial(root, () => this.call<SkillFile>(root, "write", { path, content, revision })); }
  delete(root: string, path: string, revision: string) { return this.serial(root, () => this.call(root, "delete", { path, revision })); }
}

export class HouseSkills {
  private readonly files = new SkillFiles();
  constructor(readonly root: string) {}
  path(house: string) {
    assertName("house", house);
    // This parent is host-owned, never mounted in a guest. Canonicalize /var on macOS here;
    // the guest-writable house directory itself is opened without following links by the helper.
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.root).isDirectory()) throw new SkillFileError("Unsafe skills root", 400);
    return join(realpathSync(this.root), house);
  }
  async ensure(house: string) { return this.files.ensure(this.path(house)); }
  list(house: string) { return this.files.list(this.path(house)); }
  read(house: string, path: string) { return this.files.read(this.path(house), path); }
  write(house: string, path: string, content: string, revision: string | null) { return this.files.write(this.path(house), path, content, revision); }
  delete(house: string, path: string, revision: string) { return this.files.delete(this.path(house), path, revision); }
}

/** Workspace skills live in the already-mounted home; the adapter chooses their native discovery path. */
export class PetSkills {
  private readonly files = new SkillFiles();
  constructor(private readonly homes: string) {}
  at(house: string, pet: string, target: string) {
    assertName("house", house); assertPetName(pet);
    if (!target || target.startsWith("/") || target.split("/").some(part => !part || part === "." || part === "..")) throw new SkillFileError("Invalid workspace skills directory", 400);
    mkdirSync(this.homes, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.homes).isDirectory()) throw new SkillFileError("Unsafe homes root", 400);
    const root = join(realpathSync(this.homes), `household.${house}.${pet}.home`, target);
    return {
      list: () => this.files.list(root),
      read: (path: string) => this.files.read(root, path),
      write: (path: string, content: string, revision: string | null) => this.files.write(root, path, content, revision),
      delete: (path: string, revision: string) => this.files.delete(root, path, revision),
    };
  }
}
