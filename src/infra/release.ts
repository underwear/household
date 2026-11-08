import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Whether this is a compiled house (`bun build --compile`, a release archive), not `bun src/cli/main.ts` in a
 * checkout: its sources then live in Bun's virtual filesystem.
 */
export const COMPILED = import.meta.url.startsWith("file:///$bunfs/");

/**
 * A release archive, unpacked: `bin/house` (this binary; process.execPath is its real path, links resolved),
 * `bin/codex`, `msb/` (microsandbox as its release ships it), `share/builtin-skills`, `share/web`. Only for a
 * compiled house.
 */
export const releaseBin = () => dirname(process.execPath);
export const releaseShare = () => join(releaseBin(), "..", "share");

/** Where install.sh puts Household: `releases/<tag>`, `current` (a link to one), `bin/house` (`HOUSEHOLD_HOME`). */
export const householdHome = (env: Record<string, string | undefined> = process.env) => env.HOUSEHOLD_HOME || join(homedir(), ".household");

/** The microsandbox CLI: a compiled house's own (its release's `msb/`), when it is there; else `msb` on PATH. */
export function msbCommand(env: Record<string, string | undefined> = process.env): string {
  if (env.HOUSEHOLD_MSB) return env.HOUSEHOLD_MSB;
  const own = join(releaseBin(), "..", "msb", "msb");
  return COMPILED && existsSync(own) ? own : "msb";
}
