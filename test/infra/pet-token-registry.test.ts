import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PET_TOKEN_HEADER, type Caller } from "../../src/core/egress";
import { hashPetToken, PetTokenRegistry, petTokenFrom } from "../../src/infra/pet-token-registry";
import { identifyPet, type GatewayPolicy } from "../../src/infra/gateway-policy";

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "household-pet-token-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const a = { house: "work", pet: "alice" }, b = { house: "work", pet: "bob" };
const caller = (headers: Record<string, string> = {}, source = "192.0.2.10"): Caller => ({ source, header: name => headers[name] });
const basic = (token: string) => `Basic ${Buffer.from(`household:${token}`).toString("base64")}`;

test("capabilities persist privately, policy carries digests, removed identities cannot regain an old capability", () => {
  const file = join(temp(), "pet-tokens.json"), registry = new PetTokenRegistry(file);
  const token = registry.tokenFor(a), other = registry.tokenFor(b);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(other).not.toBe(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(new PetTokenRegistry(file).tokenFor(a)).toBe(token);
  expect(registry.entries([a, b])).toEqual([{ ...a, sha256: hashPetToken(token) }, { ...b, sha256: hashPetToken(other) }]);
  expect(JSON.stringify(registry.entries([a]))).not.toContain(token);
  expect(readFileSync(file, "utf8")).not.toContain(other);
  expect(registry.tokenFor(b)).not.toBe(other);
});

test("same-source callers are distinguished by token; absence, invalid, removed and conflicting credentials fail closed", () => {
  const registry = new PetTokenRegistry(join(temp(), "tokens"));
  const first = registry.tokenFor(a), second = registry.tokenFor(b);
  const policy: GatewayPolicy = { rules: [], tokens: registry.entries([a, b]) };
  expect(identifyPet(policy, caller({ [PET_TOKEN_HEADER]: first }))).toEqual(a);
  expect(identifyPet(policy, caller({ "proxy-authorization": basic(second) }))).toEqual(b);
  const invalid: Record<string, string>[] = [{}, { [PET_TOKEN_HEADER]: "" }, { [PET_TOKEN_HEADER]: "x".repeat(43) }, { [PET_TOKEN_HEADER]: first, "proxy-authorization": basic(second) }, { "proxy-authorization": "Basic !!!!" }];
  for (const headers of invalid) expect(identifyPet(policy, caller(headers))).toBeUndefined();
  policy.tokens = registry.entries([a]);
  expect(identifyPet(policy, caller({ [PET_TOKEN_HEADER]: second }))).toBeUndefined();
});

test("registry refuses malformed identities and symlinks without disclosing credential contents", () => {
  const root = temp(), file = join(root, "tokens"), external = join(root, "external");
  writeFileSync(external, "secret-contents"); symlinkSync(external, file);
  expect(() => new PetTokenRegistry(file)).toThrow("registry is invalid");
  expect(readFileSync(external, "utf8")).toBe("secret-contents");
  rmSync(file);
  writeFileSync(file, JSON.stringify({ version: 1, pets: [{ token: "s".repeat(43) }] }));
  expect(() => new PetTokenRegistry(file)).toThrow("registry is invalid");
  const registry = new PetTokenRegistry(join(root, "valid"));
  const token = registry.tokenFor(a);
  expect(() => registry.entries([{ house: "../outside", pet: "bad" }])).toThrow("invalid pet identity");
  expect(registry.tokenFor(a)).toBe(token);
});

test("proxy parser accepts only canonical Basic username and complete capability", () => {
  const token = "x".repeat(43);
  expect(petTokenFrom(caller({ "proxy-authorization": basic(token) }))).toEqual({ present: true, token });
  expect(petTokenFrom(caller({ "proxy-authorization": `Basic ${Buffer.from(`wrong:${token}`).toString("base64")}` }))).toEqual({ present: true });
});


test("pet capabilities persist for underscore names without broadening house identifiers", () => {
  const file = join(temp(), "tokens");
  const pet = { house: "work", pet: "my_pet-2" };
  const registry = new PetTokenRegistry(file);
  const token = registry.tokenFor(pet);
  expect(new PetTokenRegistry(file).tokenFor(pet)).toBe(token);
  const policy: GatewayPolicy = { rules: [], tokens: registry.entries([pet]) };
  expect(identifyPet(policy, caller({ [PET_TOKEN_HEADER]: token }))).toEqual(pet);
  expect(() => registry.tokenFor({ house: "my_house", pet: "valid" })).toThrow("invalid pet identity");
});
