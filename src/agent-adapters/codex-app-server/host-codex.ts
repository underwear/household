import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Codex's own names for the platforms it ships a binary for (its npm package's `bin/codex.js`). */
const TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
};

/**
 * The Codex Household signs in and refreshes subscriptions with on the host: its own, pinned in package.json (the
 * version the pets' image runs), so the user needs no Codex of their own. `codex` on PATH only where that package
 * has no binary for this machine; a release ships it beside `house`. `HOUSEHOLD_CODEX` names another (tests' fakes).
 */
export function hostCodex(platform = process.platform, arch = process.arch, env = process.env): string {
  if (env.HOUSEHOLD_CODEX) return env.HOUSEHOLD_CODEX;
  // A compiled house (a release archive) has it beside itself in bin/.
  if (import.meta.url.startsWith("file:///$bunfs/")) {
    const beside = join(dirname(process.execPath), "codex");
    if (existsSync(beside)) return beside;
  }
  const key = `${platform}-${arch}`;
  const target = TARGETS[key];
  if (!target) return "codex";
  try {
    const manifest = createRequire(import.meta.url).resolve(`@openai/codex-${key}/package.json`);
    const binary = join(dirname(manifest), "vendor", target, "bin", "codex");
    return existsSync(binary) ? binary : "codex";
  } catch {
    return "codex";
  }
}
