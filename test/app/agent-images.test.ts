import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releasedImage, releasedImageFor } from "../../src/app/agent-images";
import { runCommand } from "../../src/infra/process";
import { tempDir } from "../helpers";

const git = async (root: string, ...args: string[]) => {
  const result = await runCommand(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args]);
  if (!result.ok) throw new Error(result.stderr);
};

/** A checkout with an agent context at release tag v1.0.0. */
async function checkout() {
  const root = tempDir();
  const context = join(root, "agent");
  mkdirSync(context);
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "README.md"), "readme\n");
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "release");
  await git(root, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
  return { root, context, released: (env: Record<string, string> = {}) => releasedImageFor("household-agent-x", context, { root, version: "1.0.0", env }) };
}

test("the release image lives in Household's registry under the version's tag", () => {
  expect(releasedImage("household-agent-x", "1.0.0")).toBe("ghcr.io/underwear/household-agent-x:v1.0.0");
});

test("a checkout at the release tag pulls; changes elsewhere in the checkout do not matter", async () => {
  const { root, released } = await checkout();
  expect(await released()).toBe("ghcr.io/underwear/household-agent-x:v1.0.0");
  writeFileSync(join(root, "README.md"), "changed\n");
  writeFileSync(join(root, "new.txt"), "new\n");
  expect(await released()).toBe("ghcr.io/underwear/household-agent-x:v1.0.0");
});

test("a context changed from the release, committed or not, or with new files, is built here", async () => {
  const edited = await checkout();
  writeFileSync(join(edited.context, "Dockerfile"), "FROM debian\n");
  expect(await edited.released()).toBeUndefined();
  await git(edited.root, "commit", "-q", "-am", "next");
  expect(await edited.released()).toBeUndefined();
  const added = await checkout();
  writeFileSync(join(added.context, "extra.sh"), "echo\n");
  expect(await added.released()).toBeUndefined();
});

test("no release tag in the checkout, or HOUSEHOLD_BUILD_IMAGES=1, builds here; outside a checkout it is the release", async () => {
  const { root, context, released } = await checkout();
  expect(await releasedImageFor("household-agent-x", context, { root, version: "2.0.0", env: {} })).toBeUndefined();
  expect(await released({ HOUSEHOLD_BUILD_IMAGES: "1" })).toBeUndefined();
  const plain = tempDir();
  expect(await releasedImageFor("household-agent-x", plain, { root: plain, version: "1.0.0", env: {} })).toBe("ghcr.io/underwear/household-agent-x:v1.0.0");
});
