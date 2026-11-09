import { existsSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { VERSION } from "../app/version";
import { HouseholdError } from "../core/errors";
import { runCommand } from "../infra/process";
import { COMPILED } from "../infra/release";

const REPO = "underwear/household";

/** This machine's name in release archives, as install.sh tells it. */
export function releasePlatform(platform = process.platform, arch = process.arch): string {
  const name = ["darwin-arm64", "linux-x64", "linux-arm64"].find((each) => each === `${platform}-${arch}`);
  if (!name) throw new HouseholdError(`no Household release for ${platform} ${arch}`);
  return name;
}

export interface UpdateOptions {
  /** A release tag (`v0.3.0`); the newest when left out. */
  tag?: string;
  /** Where releases are downloaded from (`<downloads>/<tag>/<archive>`); GitHub's when left out. */
  downloads?: string;
  /** The installed house binary (`<home>/releases/<tag>/bin/house`): this one. */
  binary?: string;
  fetchImpl?: typeof fetch;
  log?: (text: string) => void;
}

/**
 * `house update`: what install.sh does, from the house it installed. The release is downloaded, checked against its
 * SHA256SUMS, unpacked into `<home>/releases/<tag>`, and `<home>/current` moved to it in one rename; the release
 * before stays, to go back to. A running daemon goes on with its files until it is restarted.
 */
export async function update(options: UpdateOptions = {}): Promise<{ tag: string; changed: boolean }> {
  const log = options.log ?? console.log;
  const fetchImpl = options.fetchImpl ?? fetch;
  const binary = options.binary ?? (COMPILED ? process.execPath : undefined);
  if (!binary) throw new HouseholdError("this Household runs from a checkout: `git fetch --tags`, check out the newest tag, then `bun run setup`");
  const releases = dirname(dirname(dirname(binary)));
  const home = dirname(releases);
  if (basename(releases) !== "releases" || !existsSync(join(home, "current"))) {
    throw new HouseholdError(`this workspace was not installed by install.sh (${binary}): run it to install, curl -fsSL https://agents-household.dev/install.sh | sh`);
  }
  const tag = options.tag ?? await newestTag(fetchImpl);
  if (tag === `v${VERSION}` && readlinkSync(join(home, "current")) === join("releases", tag)) {
    log(`Household ${tag} is the newest: nothing to do`);
    return { tag, changed: false };
  }
  const platform = releasePlatform();
  const archive = `household-${tag}-${platform}.tar.gz`;
  const downloads = options.downloads ?? process.env.HOUSEHOLD_DOWNLOADS ?? `https://github.com/${REPO}/releases/download`;
  log(`Household ${tag} for ${platform}`);
  const [bytes, sums] = await Promise.all([download(fetchImpl, `${downloads}/${tag}/${archive}`), download(fetchImpl, `${downloads}/${tag}/SHA256SUMS`)]);
  const expected = new TextDecoder().decode(sums).split("\n").find((line) => line.endsWith(`  ${archive}`) || line.endsWith(` ${archive}`))?.split(/\s+/)[0];
  if (!expected) throw new HouseholdError(`SHA256SUMS of ${tag} has no line for ${archive}`);
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected) throw new HouseholdError(`${archive} does not match its checksum: not installed`);

  const staging = mkdtempSync(join(tmpdir(), "household-update-"));
  try {
    await Bun.write(join(staging, archive), bytes);
    const unpacked = await runCommand(["tar", "-xzf", join(staging, archive), "-C", staging], { timeoutMs: 120_000 });
    if (!unpacked.ok) throw new HouseholdError(`could not unpack ${archive}: ${unpacked.stderr.trim()}`);
    const previous = readlinkSync(join(home, "current"));
    rmSync(join(releases, tag), { recursive: true, force: true });
    renameSync(join(staging, `household-${tag}-${platform}`), join(releases, tag));
    const ok = await runCommand([join(releases, tag, "bin", "house"), "--version"]);
    if (!ok.ok) throw new HouseholdError(`the downloaded workspace does not run; ${previous} stays current`);
    // One rename: a link swapped over another, never a moment without one.
    symlinkSync(join("releases", tag), join(home, "current.new"));
    renameSync(join(home, "current.new"), join(home, "current"));
    for (const old of readdirSync(releases)) if (old !== tag && join("releases", old) !== previous) rmSync(join(releases, old), { recursive: true, force: true });
    log(`✓ Household ${tag} installed (${previous.replace("releases/", "")} kept, to go back to)`);
    log("Restart the daemon to run it: Ctrl-C and `house start`, or restart its service. It migrates and backs up on start.");
    return { tag, changed: true };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(join(home, "current.new"), { force: true });
  }
}

async function newestTag(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } }).catch(() => undefined);
  const tag = response?.ok ? ((await response.json()) as { tag_name?: string }).tag_name : undefined;
  if (!tag) throw new HouseholdError("could not ask GitHub for the newest release; give one: house update v0.3.0");
  return tag;
}

async function download(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetchImpl(url).catch(() => undefined);
  if (!response?.ok) throw new HouseholdError(`could not download ${url}${response ? ` (${response.status})` : ""}`);
  return new Uint8Array(await response.arrayBuffer());
}
