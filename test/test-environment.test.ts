import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/infra/process";
import { tempDir } from "./helpers";

test("the preload removes inherited launch settings and proxies but retains explicit native QA opt-in", async () => {
  const fixture = join(tempDir(), "environment.test.ts");
  writeFileSync(fixture, `import { expect, test } from "bun:test";
test("isolated environment", () => {
  expect(process.env.HOUSEHOLD_NATIVE_ADAPTER_SMOKE).toBe("1");
  expect(process.env.HOUSEHOLD_QA_BASE_IMAGE).toBe("fixture-image");
  expect(process.env.HOUSEHOLD_PRIVATE_BACKUP).toBe("fixture-backup");
  expect(process.env.HOUSEHOLD_MODEL).toBeUndefined();
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"])
    expect(process.env[key]).toBeUndefined();
});`);
  const proxies = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"].map(key => [key, "unwanted-fixture-proxy"]));
  const result = await runCommand([process.execPath, "test", "--preload", join(import.meta.dir, "helpers.ts"), fixture], {
    timeoutMs: 10_000,
    env: { ...proxies, HOUSEHOLD_NATIVE_ADAPTER_SMOKE: "1", HOUSEHOLD_QA_BASE_IMAGE: "fixture-image", HOUSEHOLD_PRIVATE_BACKUP: "fixture-backup", HOUSEHOLD_MODEL: "inherited-model" },
  });
  expect(result).toMatchObject({ ok: true });
});
