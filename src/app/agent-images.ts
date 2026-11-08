import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { runCommand } from "../infra/process";
import { REPO_ROOT, VERSION } from "./version";

/** Where releases publish the agents' images (`.github/workflows/release.yml`). */
export const IMAGE_REGISTRY = "ghcr.io/underwear";

/** The registry reference of an agent image of this Household's release: `ghcr.io/underwear/<tag>:v<version>`. */
export const releasedImage = (tag: string, version = VERSION) => `${IMAGE_REGISTRY}/${tag}:v${version}`;

type Run = (command: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export interface ReleasedImageOptions {
  root?: string;
  version?: string;
  run?: Run;
  env?: Record<string, string | undefined>;
}

/**
 * The released image for an agent's build context, or undefined when this Household has to build it itself:
 * `HOUSEHOLD_BUILD_IMAGES=1`, or it runs from a git checkout where the context is not the release tag's (another
 * commit, local changes, new files, or no such tag). Outside a checkout (an installed release) it is the release's.
 */
export async function releasedImageFor(tag: string, contextDir: string, options: ReleasedImageOptions = {}): Promise<string | undefined> {
  const { root = REPO_ROOT, version = VERSION, run = runCommand, env = process.env } = options;
  if (env.HOUSEHOLD_BUILD_IMAGES === "1") return undefined;
  const image = releasedImage(tag, version);
  const top = await run(["git", "-C", root, "rev-parse", "--show-toplevel"]);
  if (!top.ok || realpathSync(top.stdout.trim()) !== realpathSync(root)) return image;
  const release = `refs/tags/v${version}`;
  const context = relative(realpathSync(root), realpathSync(contextDir)) || ".";
  if (!(await run(["git", "-C", root, "rev-parse", "--verify", "--quiet", `${release}^{commit}`])).ok) return undefined;
  if (!(await run(["git", "-C", root, "diff", "--quiet", release, "--", context])).ok) return undefined;
  const untracked = await run(["git", "-C", root, "ls-files", "--others", "--exclude-standard", "--", context]);
  return untracked.ok && untracked.stdout.trim() === "" ? image : undefined;
}
