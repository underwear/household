import { realpathSync } from "node:fs";
import { runCommand } from "./process";

/**
 * `git describe --always --dirty` of the checkout at `root` (a short commit, `-dirty` with local changes), or
 * undefined: no git, or `root` is not the top of a checkout of its own (a copy inside another repo, say).
 */
export async function checkoutCommit(root: string): Promise<string | undefined> {
  const top = await runCommand(["git", "-C", root, "rev-parse", "--show-toplevel"]);
  if (!top.ok || realpathSync(top.stdout) !== realpathSync(root)) return undefined;
  const described = await runCommand(["git", "-C", root, "describe", "--always", "--dirty"]);
  return (described.ok && described.stdout) || undefined;
}
