import type { Exec } from "../core/agent";

/** Where a sideworker works when its directory is in a git repository: its own worktree, on its own branch. */
export interface SideworkerWorktree {
  /** The worker's directory: the same place in the worktree as the one asked for in the repository. */
  cwd: string;
  branch: string;
  /** The commit the branch starts from (the parent's HEAD, short). */
  base: string;
}

/** The last line the script prints when the worktree is there. */
const DONE = "household-worktree";
/** What the script prints for a directory outside any git repository. */
const NOT_GIT_MARK = "household-not-git";

/**
 * Makes the worktree, run in the parent's VM as its user (`$1` the directory asked for, `$2` the worker's name):
 * git runs there, never on the host, so the repository's hooks and filters only ever run inside a VM. The worktree
 * goes under the repository's `.worktrees/` (kept out of `git status` through `info/exclude`) on `sideworker/<name>`
 * from HEAD. Prints git's own words when it fails.
 */
export const WORKTREE_SCRIPT = String.raw`
set -eu
exec 2>&1
cwd=$1 name=$2
top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || { echo ${NOT_GIT_MARK}; exit 3; }
prefix=$(git -C "$cwd" rev-parse --show-prefix)
if ! git -C "$top" rev-parse --verify --quiet HEAD >/dev/null; then echo "the repository has no commit yet"; exit 4; fi
common=$(git -C "$top" rev-parse --path-format=absolute --git-common-dir)
mkdir -p "$common/info"
grep -qxF '/.worktrees/' "$common/info/exclude" 2>/dev/null || printf '/.worktrees/\n' >> "$common/info/exclude"
git -C "$top" worktree add --quiet -b "sideworker/$name" "$top/.worktrees/$name" HEAD
# Git does not track empty directories; an existing untracked cwd still needs a place in the new checkout.
mkdir -p "$top/.worktrees/$name/$prefix"
dir=$(cd "$top/.worktrees/$name/$prefix" && pwd)
printf '${DONE}\t%s\t%s\n' "$dir" "$(git -C "$top" rev-parse --short HEAD)"
`;

/**
 * Gives a sideworker its own worktree of the repository `cwd` is in, through the parent's VM (`exec`): undefined
 * when `cwd` is in no repository (it then works in the shared directory), an error with git's words when the
 * repository has one but the worktree could not be made.
 */
export async function makeWorktree(exec: Exec, cwd: string, name: string): Promise<SideworkerWorktree | undefined> {
  const { ok, output } = await exec(["bash", "-c", WORKTREE_SCRIPT, "worktree", cwd, name]);
  const done = output.trim().split("\n").at(-1)?.split("\t");
  if (ok && done?.[0] === DONE && done[1] && done[2]) return { cwd: done[1], branch: `sideworker/${name}`, base: done[2] };
  if (!ok && output.trim() === NOT_GIT_MARK) return undefined;
  throw new Error(`Could not make a git worktree for the sideworker: ${output.trim().split("\n").slice(-3).join(" ") || "git failed"}. Pass worktree: false to work in the shared directory instead.`);
}
