import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { knownAgents, placePets } from "../../src/app/agents";
import { houseSubject } from "../../src/app/daemon";
import { configCheck } from "../../src/app/kinds";
import { decide } from "../../src/core/egress";
import { ConfigStore } from "../../src/infra/config-store";
import { tempDir } from "../helpers";

test("owner-secret hosts are intercepted but not autoallowed; provider endpoints still work", async () => {
  const path = join(tempDir(), "household.yaml");
  writeFileSync(path, `keys:\n  claude: {provider: anthropic, value: sk-ant-oat01-test-secret-network}\nsecrets:\n  weather:\n    value: synthetic-secret\n    hosts: [api.weather.example.com]\n    env: WEATHER_TOKEN\n    houses: [work]\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: {key: claude}\n`);
  const household = await new ConfigStore(path, configCheck(knownAgents())).load();
  const subject = houseSubject(household.houses[0]!, placePets(knownAgents(), household));
  const pet = { house: "work", pet: "sibling" };
  const secretTarget = { host: "api.weather.example.com", port: 443 };
  expect(subject.intercept).toContainEqual(secretTarget);
  expect(subject.policy.allow).not.toContainEqual(secretTarget);
  expect(decide([subject], pet, secretTarget)).toMatchObject({ verdict: "deny" });
  expect(decide([subject], pet, { host: "api.anthropic.com", port: 443 })).toMatchObject({ verdict: "allow", intercept: true });
  subject.policy.allow.push({ ...secretTarget, reach: "public" });
  expect(decide([subject], pet, secretTarget)).toMatchObject({ verdict: "allow", intercept: true, reach: "public" });
});
