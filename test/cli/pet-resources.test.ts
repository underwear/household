import { expect, test } from "bun:test";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { resolvePaths } from "../../src/infra/paths";
import { tempDir } from "../helpers";

const cli = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const KEY = "sk-ant-oat01-cli-resources-test-key";

/** `house pet set` on a config of one pet, no daemon running. */
async function petSet(...flags: string[]) {
  const dirs = { HOUSEHOLD_CONFIG_DIR: tempDir(), HOUSEHOLD_STATE_DIR: tempDir() };
  const { configFile } = resolvePaths(dirs);
  writeFileSync(configFile, `keys:\n  claude: {provider: anthropic, value: ${KEY}}\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      owl: {key: claude}\n`);
  const proc = Bun.spawn([process.execPath, cli, "pet", "set", "work", "owl", ...flags], { env: { ...process.env, ...dirs }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + err, config: readFileSync(configFile, "utf8") };
}

test("pet set --cpus and --memory: up to this host's, not past it", async () => {
  const cpus = availableParallelism();
  const memoryGiB = Math.floor(totalmem() / 1024 ** 3);
  const tooMany = await petSet("--cpus", String(cpus + 1));
  expect(tooMany.code).toBe(1);
  expect(tooMany.out).toContain(`pet work/owl: ${cpus + 1} vCPU, more than this host's ${cpus}`);
  expect(tooMany.config).not.toContain("cpus");
  const tooMuch = await petSet("--memory", String(memoryGiB + 1));
  expect(tooMuch.code).toBe(1);
  expect(tooMuch.out).toContain("of RAM, more than this host's");
  const fits = await petSet("--cpus", String(cpus), "--memory", "0.5");
  expect(fits.code).toBe(0);
  expect(fits.config).toContain(`owl: { key: claude, cpus: ${cpus}, memoryMiB: 512 }`);
});
