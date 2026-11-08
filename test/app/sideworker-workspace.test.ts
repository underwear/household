import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorktree } from "../../src/app/sideworker-workspace";
import { tempDir } from "../helpers";

// The script runs in the parent's VM; here it runs on this machine's bash and git, against a throwaway repository.
const exec = async (command: string[]) => {
  const run = Bun.spawnSync(command, { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { ok: run.exitCode === 0, output: run.stdout.toString() };
};
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

test("a worktree on its own branch, at the same place in the repository, kept out of git status", async () => {
  const root = tempDir();
  const repo = join(root, "repo");
  mkdirSync(join(repo, "app", "src"), { recursive: true });
  writeFileSync(join(repo, "app", "src", "a.txt"), "a");
  git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "first");
  const made = await makeWorktree(exec, join(repo, "app", "src"), "sw-a");
  expect(made?.branch).toBe("sideworker/sw-a");
  expect(made?.base).toMatch(/^[0-9a-f]{7,}$/);
  expect(made?.cwd.endsWith(join("repo", ".worktrees", "sw-a", "app", "src"))).toBe(true);
  expect(readFileSync(join(made!.cwd, "a.txt"), "utf8")).toBe("a");
  expect(git(repo, "status", "--porcelain").stdout.toString()).toBe("");
  await expect(makeWorktree(exec, repo, "sw-a")).rejects.toThrow("already exists"); // never over another's branch
});

test("outside a repository there is no worktree; a repository without a commit says so", async () => {
  const root = tempDir();
  expect(await makeWorktree(exec, root, "sw-b")).toBeUndefined();
  git(root, "init", "-q");
  await expect(makeWorktree(exec, root, "sw-c")).rejects.toThrow("no commit yet");
});

test("an untracked working directory exists in the new worktree without copying uncommitted files", async () => {
  const repo = tempDir();
  writeFileSync(join(repo, "README.md"), "committed");
  git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "first");
  mkdirSync(join(repo, "new-project", "src"), { recursive: true });
  writeFileSync(join(repo, "new-project", "src", "draft.txt"), "uncommitted");
  const made = await makeWorktree(exec, join(repo, "new-project", "src"), "sw-new");
  expect(made?.cwd.endsWith(join(".worktrees", "sw-new", "new-project", "src"))).toBe(true);
  expect(Bun.spawnSync(["test", "-d", made!.cwd]).exitCode).toBe(0);
  expect(Bun.spawnSync(["test", "-e", join(made!.cwd, "draft.txt")]).exitCode).toBe(1);
  expect(git(made!.cwd, "status", "--porcelain").stdout.toString()).toBe("");
});
