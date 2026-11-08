import { join } from "node:path";
import { checkoutCommit } from "../infra/git";
import { version } from "../../package.json" with { type: "json" };

/** The checkout Household runs from: the build context of its images. */
export const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Household's version: package.json's, the single source of it. */
export const VERSION = version;

/** Which Household this is: the version and, when it runs from a git checkout, its commit (`-dirty` if changed). */
export interface HouseholdVersion {
  version: string;
  commit?: string;
}

export async function householdVersion(): Promise<HouseholdVersion> {
  return { version: VERSION, commit: await checkoutCommit(REPO_ROOT) };
}

/** `0.1.0 (abc1234)`, or just the version. */
export const formatVersion = ({ version, commit }: HouseholdVersion) => (commit ? `${version} (${commit})` : version);
