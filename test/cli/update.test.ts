import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releasePlatform, update } from "../../src/cli/update";
import { tempDir } from "../helpers";

const platform = releasePlatform();

/** A home as install.sh leaves it: releases/<tags>, current → the first, bin/house. */
function installed(tags: string[]) {
  const home = tempDir();
  for (const tag of tags) {
    mkdirSync(join(home, "releases", tag, "bin"), { recursive: true });
    writeFileSync(join(home, "releases", tag, "bin", "house"), "#!/bin/sh\necho old\n", { mode: 0o755 });
  }
  symlinkSync(join("releases", tags[0]!), join(home, "current"));
  return { home, binary: join(home, "releases", tags[0]!, "bin", "house") };
}

/** A release archive of `tag` and its SHA256SUMS, served by a fake fetch; `corrupt` breaks the checksum. */
async function release(tag: string, { corrupt = false, runs = true } = {}) {
  const dir = tempDir();
  const name = `household-${tag}-${platform}`;
  mkdirSync(join(dir, name, "bin"), { recursive: true });
  writeFileSync(join(dir, name, "bin", "house"), runs ? `#!/bin/sh\necho household ${tag}\n` : "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  Bun.spawnSync(["tar", "-czf", `${name}.tar.gz`, name], { cwd: dir });
  const bytes = new Uint8Array(await Bun.file(join(dir, `${name}.tar.gz`)).arrayBuffer());
  const sum = corrupt ? "0".repeat(64) : new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    if (url.endsWith("/latest")) return Response.json({ tag_name: tag });
    if (url.endsWith(`/${tag}/${name}.tar.gz`)) return new Response(bytes);
    if (url.endsWith(`/${tag}/SHA256SUMS`)) return new Response(`${sum}  ${name}.tar.gz\n`);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

test("the newest release is unpacked beside the others and made current; the one before stays, older ones go", async () => {
  const { home, binary } = installed(["v0.1.0", "v0.0.9"]);
  const { fetchImpl, asked } = await release("v9.9.9");
  const said: string[] = [];
  expect(await update({ binary, fetchImpl, downloads: "https://dl.test", log: (text) => said.push(text) })).toEqual({ tag: "v9.9.9", changed: true });
  expect(readlinkSync(join(home, "current"))).toBe(join("releases", "v9.9.9"));
  expect(readdirSync(join(home, "releases")).sort()).toEqual(["v0.1.0", "v9.9.9"]);
  expect(existsSync(join(home, "current.new"))).toBe(false);
  expect(asked).toContain(`https://dl.test/v9.9.9/household-v9.9.9-${platform}.tar.gz`);
  expect(said.join("\n")).toContain("Restart the daemon");
});

test("a download that does not match its checksum, or a house that does not run, changes nothing", async () => {
  for (const broken of [{ corrupt: true }, { runs: false }]) {
    const { home, binary } = installed(["v0.1.0"]);
    const { fetchImpl } = await release("v9.9.9", broken);
    await expect(update({ binary, fetchImpl, downloads: "https://dl.test", log: () => {} })).rejects.toThrow(broken.corrupt ? "does not match its checksum" : "does not run");
    expect(readlinkSync(join(home, "current"))).toBe(join("releases", "v0.1.0"));
  }
});

test("a house that install.sh did not put there, or a checkout, is told how to update instead", async () => {
  const { fetchImpl } = await release("v9.9.9");
  await expect(update({ binary: join(tempDir(), "house"), fetchImpl, log: () => {} })).rejects.toThrow("not installed by install.sh");
  await expect(update({ fetchImpl, log: () => {} })).rejects.toThrow("runs from a checkout");
});
