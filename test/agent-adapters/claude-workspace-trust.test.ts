import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeTmux } from "../../src/agent-adapters/claude-code-tmux";

test("workspace trust follows Git's main checkout, including linked subdirectories and separate git dirs", () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "household-trust-")));
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const paths = (cwd: string) => JSON.parse(run(["python3", "-I", join(claudeCodeTmux.imageContext, "trust-paths.py"), cwd]));
  try {
    const main = join(temp, 'project "Привет"'), worker = join(temp, "worker checkout"), subdir = join(worker, "subdir");
    run(["git", "init", "-q", main]);
    run(["git", "-C", main, "-c", "user.name=QA", "-c", "user.email=qa@example.test", "commit", "--allow-empty", "-qm", "fixture"]);
    run(["git", "-C", main, "worktree", "add", "-qb", "worker", worker]);
    mkdirSync(subdir);
    expect(paths(subdir)).toEqual([subdir, worker, main]);
    expect(paths(main)).toEqual([main]);
    const alias = join(temp, "alias");
    symlinkSync(subdir, alias);
    expect(paths(alias)).toEqual([alias, subdir, worker, main]);
    expect(paths(temp)).toEqual([temp]);
    // A separate .git directory is storage, not the project's trust key.
    const separate = join(temp, "separate"), storage = join(temp, "git storage");
    run(["git", "init", "-q", "--separate-git-dir", storage, separate]);
    expect(paths(separate)).toEqual([separate]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
