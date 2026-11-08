import { describe, expect, test } from "bun:test";
import { petCredentials } from "../../src/app/gateway";
import { parseAllowEntry } from "../../src/core/network-policy";
import type { GatewayPolicy } from "../../src/infra/gateway-policy";

const anthropic = { host: "api.anthropic.com", port: 443 };
const policy: GatewayPolicy = {
  rules: [{ subject: { kind: "house", name: "work" }, policy: { kind: "allowlist", allow: [parseAllowEntry("*.anthropic.com")!, anthropic] }, intercept: [anthropic] }],
  tokens: [],
  keys: [{ house: "work", pet: "sibling", credentials: [{ target: anthropic, header: "authorization", prefix: "Bearer ", secret: "key.claude", strip: ["authorization"] }] }],
};
const pet = { house: "work", pet: "sibling" };

describe("petCredentials", () => {
  test("a key goes only to the exact host its agent declared, never to one a wildcard allows", () => {
    expect(petCredentials(policy, pet, anthropic)).toHaveLength(1);
    expect(petCredentials(policy, pet, { host: "evil.anthropic.com", port: 443 })).toEqual({ refused: "pet work/sibling has no key for evil.anthropic.com" });
    expect(petCredentials(policy, pet, { host: "*.anthropic.com", port: 443 })).toHaveProperty("refused");
  });
});

test("* never brings a key to a host the agent did not declare", () => {
  const open: GatewayPolicy = { ...policy, rules: [{ ...policy.rules[0]!, policy: { kind: "allowlist", allow: [parseAllowEntry("*:*")!, anthropic] } }] };
  expect(petCredentials(open, pet, anthropic)).toHaveLength(1);
  for (const host of ["example.com", "api.openai.com", "anthropic.com", "*"]) {
    expect(petCredentials(open, pet, { host, port: 443 })).toHaveProperty("refused");
  }
  expect(petCredentials(open, pet, { host: anthropic.host, port: 8443 })).toHaveProperty("refused");
});
