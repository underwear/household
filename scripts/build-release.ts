#!/usr/bin/env bun
// Builds a release archive of Household for one platform: dist/household-v<version>-<platform>.tar.gz, holding
//   bin/house                the compiled CLI and daemon (bun build --compile)
//   bin/codex                Household's own Codex, the version pinned in package.json (checked against bun.lock)
//   msb/                     microsandbox, the pinned version, as its release ships it (msb is signed: untouched)
//   share/builtin-skills     mounted into pets' VMs, so a real directory
//   share/web                the web UI, built here (a compiled house has no bundler inputs)
// Usage: bun scripts/build-release.ts <darwin-arm64|linux-x64|linux-arm64>
// A darwin binary is built on macOS, which signs it (ad hoc); Apple silicon runs nothing unsigned.
import { cpSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { buildWebBundle, writeWebBundle } from "../src/infra/web-bundle";
import pkg from "../package.json" with { type: "json" };
import { MICROSANDBOX_VERSION } from "../src/infra/microsandbox-runtime";

const TARGETS: Record<string, { bun: string; codex: string; msb: string; msbSha256: string }> = {
  "darwin-arm64": { bun: "bun-darwin-arm64", codex: "aarch64-apple-darwin", msb: "darwin-aarch64", msbSha256: "5eb53ca1d6beb36caa64d19602284b9ce37872eff340a8db0542ab91b5808c96" },
  "linux-x64": { bun: "bun-linux-x64", codex: "x86_64-unknown-linux-musl", msb: "linux-x86_64", msbSha256: "c41aeefc050e97f42cd55ce55cc139efc13c6ee2dc371e8d30c325a305a5c3b1" },
  "linux-arm64": { bun: "bun-linux-arm64", codex: "aarch64-unknown-linux-musl", msb: "linux-aarch64", msbSha256: "bd95fbc51954c2c20077c782262157bf5aed17b3717c5d4494d9d34035f3432c" },
};

const platform = process.argv[2] ?? "";
const target = TARGETS[platform];
if (!target) throw new Error(`usage: bun scripts/build-release.ts <${Object.keys(TARGETS).join("|")}>`);
if (platform.startsWith("darwin") && process.platform !== "darwin") throw new Error("build darwin releases on macOS: it signs the binary");

const root = join(import.meta.dir, "..");
const name = `household-v${pkg.version}-${platform}`;
const dist = join(root, "dist");
const out = join(dist, name);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });

const run = (command: string[], cwd = root) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`);
};

console.log(`house for ${platform}`);
run(["bun", "build", "--compile", `--target=${target.bun}`, "--minify", "src/cli/main.ts", "--outfile", join(out, "bin", "house")]);

console.log("codex");
const codexVersion = pkg.dependencies["@openai/codex"];
const lock = await Bun.file(join(root, "bun.lock")).text();
const integrity = new RegExp(`"@openai/codex-${platform}": \\["@openai/codex@${codexVersion.replace(/\./g, "\\.")}-${platform}", "", \\{[^}]*\\}, "(sha512-[^"]+)"\\]`).exec(lock)?.[1];
if (!integrity) throw new Error(`bun.lock has no @openai/codex ${codexVersion} for ${platform}`);
const tarball = new Uint8Array(await (await fetch(`https://registry.npmjs.org/@openai/codex/-/codex-${codexVersion}-${platform}.tgz`)).arrayBuffer());
const digest = `sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}`;
if (digest !== integrity) throw new Error(`codex ${codexVersion} for ${platform}: the download does not match bun.lock`);
const unpacked = join(dist, `codex-${platform}`);
rmSync(unpacked, { recursive: true, force: true });
mkdirSync(unpacked, { recursive: true });
await Bun.write(join(unpacked, "codex.tgz"), tarball);
run(["tar", "-xzf", "codex.tgz"], unpacked);
cpSync(join(unpacked, "package", "vendor", target.codex, "bin", "codex"), join(out, "bin", "codex"));
rmSync(unpacked, { recursive: true, force: true });

console.log(`msb ${MICROSANDBOX_VERSION}`);
const msbTarball = new Uint8Array(await (await fetch(`https://github.com/superradcompany/microsandbox/releases/download/v${MICROSANDBOX_VERSION}/microsandbox-${target.msb}.tar.gz`)).arrayBuffer());
if (new Bun.CryptoHasher("sha256").update(msbTarball).digest("hex") !== target.msbSha256) throw new Error(`microsandbox ${MICROSANDBOX_VERSION} for ${platform}: the download does not match its pinned sha256`);
mkdirSync(join(out, "msb"));
await Bun.write(join(out, "msb", "msb.tgz"), msbTarball);
run(["tar", "-xzf", "msb.tgz"], join(out, "msb"));
rmSync(join(out, "msb", "msb.tgz"));
// libkrunfw is found beside msb under its ABI names (as microsandbox's own install.sh and brew formula link it).
for (const file of readdirSync(join(out, "msb"))) {
  const linux = /^libkrunfw\.so\.(\d+)\.\d+\.\d+$/.exec(file);
  if (linux) { symlinkSync(file, join(out, "msb", `libkrunfw.so.${linux[1]}`)); symlinkSync(file, join(out, "msb", "libkrunfw.so")); }
  const mac = /^libkrunfw\.\d+\.dylib$/.exec(file);
  if (mac) symlinkSync(file, join(out, "msb", "libkrunfw.dylib"));
}

console.log("share");
cpSync(join(root, "src", "builtin-skills"), join(out, "share", "builtin-skills"), { recursive: true });
await writeWebBundle(await buildWebBundle(join(root, "web", "index.html")), join(out, "share", "web"));

run(["chmod", "755", join(out, "bin", "house"), join(out, "bin", "codex")]);
// macOS tar would add its extended attributes, which Linux tar warns about.
run(["tar", ...(process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : []), "-czf", `${name}.tar.gz`, name], dist);
console.log(`dist/${name}.tar.gz`);
