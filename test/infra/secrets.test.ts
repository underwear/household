import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pruneSecrets, writeSecrets } from "../../src/infra/secrets";
import { tempDir } from "../helpers";

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

test("the gateway's dir: values written as 600 files in a 700 dir, a new value replacing the old; others removed only when pruned", () => {
  const dir = join(tempDir(), "gateway-secrets");
  writeSecrets(dir, { "key.claude": "a", "household-agent-api": "s" });
  expect(mode(dir)).toBe("700");
  expect(mode(join(dir, "key.claude"))).toBe("600");
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "stale"), "x");
  mkdirSync(join(dir, "a-dir"), { recursive: true });
  writeSecrets(dir, { "key.claude": "b" });
  expect(readdirSync(dir).sort()).toEqual(["a-dir", "household-agent-api", "key.claude", "stale"]); // nothing goes before the policy moved on
  expect(readFileSync(join(dir, "key.claude"), "utf8")).toBe("b");
  expect(mode(dir)).toBe("700");
  pruneSecrets(dir, ["key.claude"]);
  expect(readdirSync(dir)).toEqual(["key.claude"]);
});
