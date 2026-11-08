import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUEST_SKILLS_SETUP } from "../../src/infra/guest-skills";
import { BUILTIN_SKILLS } from "../../src/infra/house-skills";
import { runCommand } from "../../src/infra/process";
import { tempDir } from "../helpers";

function fixture() {
  const home = tempDir(), shared = tempDir();
  const script = GUEST_SKILLS_SETUP.replace("pathlib.Path('/opt/household/skills')", `pathlib.Path(${JSON.stringify(shared)})`);
  const file = (path: string, content: string) => { mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), content); };
  const run = (primary = ".claude/skills") => runCommand(["python3", "-c", script], { env: { HOME: home, HOUSEHOLD_SKILLS_DIRECTORY: primary } });
  return { home, shared, file, run, script };
}

test("the agent's skills directory becomes a link to the house's skills; what stood there is moved aside, untouched", async () => {
  const f = fixture();
  f.file(".claude/skills/review/SKILL.md", "# Mine");
  expect((await f.run()).ok).toBe(true);
  expect(readlinkSync(join(f.home, ".claude/skills"))).toBe(f.shared);
  const aside = readdirSync(join(f.home, ".claude")).find((name) => name.startsWith("skills.before-household-"))!;
  expect(readFileSync(join(f.home, ".claude", aside, "review/SKILL.md"), "utf8")).toBe("# Mine");
  expect((await f.run()).ok).toBe(true); // repeatable: the link stays
  expect(readdirSync(join(f.home, ".claude")).filter((name) => name.startsWith("skills.before-household-"))).toHaveLength(1);
});

test("a link elsewhere is moved aside too; a fresh home just gets the link", async () => {
  const f = fixture();
  mkdirSync(join(f.home, ".agents"), { recursive: true });
  symlinkSync(tempDir(), join(f.home, ".agents/skills"));
  expect((await f.run(".agents/skills")).ok).toBe(true);
  expect(readlinkSync(join(f.home, ".agents/skills"))).toBe(f.shared);
  const fresh = fixture();
  expect((await fresh.run(".agents/skills")).ok).toBe(true);
  expect(readlinkSync(join(fresh.home, ".agents/skills"))).toBe(fresh.shared);
});

test("Household's own skills are linked into the shared ones; anything else under their prefix moves out of sight", async () => {
  const f = fixture(), builtin = tempDir();
  for (const name of ["household-network", "household-memory"]) { mkdirSync(join(builtin, name)); writeFileSync(join(builtin, name, "SKILL.md"), `# ${name}`); }
  mkdirSync(join(builtin, "not-ours")); writeFileSync(join(builtin, "not-ours", "SKILL.md"), "#");
  mkdirSync(join(f.shared, "household-memory")); writeFileSync(join(f.shared, "household-memory", "SKILL.md"), "# a pet's");
  symlinkSync(join(builtin, "household-old"), join(f.shared, "household-old")); // from an older Household
  mkdirSync(join(f.shared, ".x")); symlinkSync(join(f.shared, ".x"), join(f.shared, "household-zzz")); // a pet's, posing as one
  mkdirSync(join(f.shared, "review")); writeFileSync(join(f.shared, "review", "SKILL.md"), "# review");
  const script = GUEST_SKILLS_SETUP.replace("pathlib.Path('/opt/household/skills')", `pathlib.Path(${JSON.stringify(f.shared)})`).replace("pathlib.Path('/opt/household/builtin-skills')", `pathlib.Path(${JSON.stringify(builtin)})`);
  const run = () => runCommand(["python3", "-c", script], { env: { HOME: f.home, HOUSEHOLD_SKILLS_DIRECTORY: ".claude/skills" } });
  expect((await run()).ok).toBe(true);
  expect(readlinkSync(join(f.shared, "household-network"))).toBe(join(builtin, "household-network"));
  expect(readlinkSync(join(f.shared, "household-memory"))).toBe(join(builtin, "household-memory"));
  const aside = readdirSync(join(f.shared, ".household-aside"));
  expect(aside.some((name) => name.startsWith("household-memory.before-household-"))).toBe(true); // hidden: it no longer loads as a skill
  expect(aside.some((name) => name.startsWith("household-zzz.before-household-"))).toBe(true);
  expect(readdirSync(f.shared).filter((name) => !name.startsWith(".")).sort()).toEqual(["household-memory", "household-network", "review"]);
  expect((await run()).ok).toBe(true); // repeatable
  expect(readdirSync(join(f.shared, ".household-aside"))).toHaveLength(2);
});

test("every harness reads the same skills: shared through each user directory, a pet's own through each project one", async () => {
  const f = fixture();
  f.file("work/.claude/skills/mine/SKILL.md", "# mine"); // a Claude pet's, before
  f.file("work/.claude/skills/twice/SKILL.md", "# claude's");
  f.file("work/.agents/skills/twice/SKILL.md", "# codex's");
  const env = { HOME: f.home, HOUSEHOLD_SKILLS_DIRECTORY: ".agents/skills", HOUSEHOLD_SKILLS_LINKS: ".claude/skills:.agents/skills", HOUSEHOLD_WORKSPACE_SKILLS: "work/.agents/skills", HOUSEHOLD_WORKSPACE_SKILLS_LINKS: "work/.claude/skills" };
  const run = () => runCommand(["python3", "-c", f.script], { env });
  expect((await run()).ok).toBe(true);
  expect(readlinkSync(join(f.home, ".claude/skills"))).toBe(f.shared);
  expect(readlinkSync(join(f.home, ".agents/skills"))).toBe(f.shared);
  expect(readlinkSync(join(f.home, "work/.claude/skills"))).toBe("../.agents/skills");
  expect(readFileSync(join(f.home, "work/.claude/skills/mine/SKILL.md"), "utf8")).toBe("# mine"); // moved over, read through the link
  expect(readFileSync(join(f.home, "work/.agents/skills/twice/SKILL.md"), "utf8")).toBe("# codex's"); // never over one there
  const kept = readdirSync(join(f.home, "work/.claude")).find((name) => name.startsWith("skills.before-household-"))!;
  expect(readFileSync(join(f.home, "work/.claude", kept, "twice/SKILL.md"), "utf8")).toBe("# claude's");
  expect((await run()).ok).toBe(true); // repeatable
  expect(readdirSync(join(f.home, "work/.claude")).filter((name) => name.includes(".before-household-"))).toHaveLength(1);
});

test("the built-in skills in this repository are well formed", () => {
  const root = BUILTIN_SKILLS;
  const names = readdirSync(root).filter((name) => name.startsWith("household-"));
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const text = readFileSync(join(root, name, "SKILL.md"), "utf8");
    expect(text).toStartWith(`---\nname: ${name}\ndescription: `);
    expect(text.split("\n")[2]!.length).toBeLessThan(400);
  }
});
