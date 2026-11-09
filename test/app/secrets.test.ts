import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knownAgents, placePets } from "../../src/app/agents";
import { channelChecks } from "../../src/app/channel-fields";
import { petKeys } from "../../src/app/keys";
import { configCheck, knownChannelKinds, knownPlatforms } from "../../src/app/kinds";
import { WebAuth } from "../../src/app/web-auth";
import { webRoutes } from "../../src/app/web-routes";
import { envProblem, fillPlaceholder, secretHost } from "../../src/core/secrets";
import { ConfigStore } from "../../src/infra/config-store";
import { EventLog } from "../../src/infra/event-log";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { tempDir } from "../helpers";

const KEY = "sk-ant-oat01-secrets-test-key";
const CONFIG = `version: 4\nkeys:\n  claude: {provider: anthropic, value: ${KEY}}\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: {key: claude}\n  home:\n    network: {allow: []}\n    pets:\n      cat: {key: claude}\n`;

function store(config = CONFIG) {
  const path = join(tempDir(), "household.yaml");
  writeFileSync(path, config);
  return { config: new ConfigStore(path, configCheck(knownAgents())), text: () => readFileSync(path, "utf8") };
}

test("the placeholder is swapped where it stands, or inside Basic credentials; nowhere else", () => {
  expect(fillPlaceholder("token household-secret-gh", "household-secret-gh", "ghp_1")).toBe("token ghp_1");
  const basic = `Basic ${Buffer.from("x-access-token:household-secret-gh").toString("base64")}`;
  expect(fillPlaceholder(basic, "household-secret-gh", "ghp_1")).toBe(`Basic ${Buffer.from("x-access-token:ghp_1").toString("base64")}`);
  expect(fillPlaceholder("Bearer someone-elses", "household-secret-gh", "ghp_1")).toBeUndefined();
  expect(fillPlaceholder(`Basic ${Buffer.from("me:mine").toString("base64")}`, "household-secret-gh", "ghp_1")).toBeUndefined();
});

test("a secret names exact hosts and a variable of its own", () => {
  expect(secretHost("API.GitHub.com")).toEqual({ host: "api.github.com", port: 443 });
  expect(secretHost("*.github.com")).toMatchObject({ problem: expect.stringContaining("never a wildcard") });
  expect(secretHost("*")).toMatchObject({ problem: expect.stringContaining("never a wildcard") });
  expect(secretHost("10.0.0.1")).toMatchObject({ problem: expect.stringContaining("not an IP address") });
  expect(envProblem("GITHUB_TOKEN")).toBeUndefined();
  for (const reserved of ["HTTPS_PROXY", "ANTHROPIC_API_KEY", "HOUSEHOLD_X", "PATH", "NODE_EXTRA_CA_CERTS"]) expect(envProblem(reserved)).toContain("set by Household");
  expect(envProblem("github-token")).toContain("A–Z");
});

test("secrets live inside a house; values and headers change in place", async () => {
  const { config, text } = store();
  await config.addSecret("work", "github", { value: " ghp_one ", hosts: ["github.com", "api.github.com"], env: "GITHUB_TOKEN" });
  expect(text()).toContain("    secrets:");
  expect(text()).not.toMatch(/^secrets:/m);
  await config.updateSecret("work", "github", { value: "ghp_two", header: "x-token" });
  const [secret] = (await config.load()).houses[0]!.secrets!;
  expect(secret).toEqual({ name: "github", value: "ghp_two", hosts: [{ host: "github.com", port: 443 }, { host: "api.github.com", port: 443 }], header: "x-token", env: "GITHUB_TOKEN" });
  await expect(config.addSecret("work", "github", { value: "x", hosts: ["a.com"], env: "A" })).rejects.toThrow("already exists");
  await expect(config.addSecret("work", "wild", { value: "x", hosts: ["*.github.com"], env: "A" })).rejects.toThrow("never a wildcard");
  await expect(config.addSecret("work", "proxy", { value: "x", hosts: ["a.com"], env: "HTTPS_PROXY" })).rejects.toThrow("set by Household");
  await expect(config.updateSecret("mars", "github", { note: "unknown" })).rejects.toThrow("unknown workspace 'mars'");
  await config.removeSecret("work", "github");
  expect((await config.load()).houses[0]!.secrets ?? []).toEqual([]);
});

test("a key for some houses only: their pets may run on it, another house's pet is refused", async () => {
  const { config } = store();
  await expect(config.updateKey("claude", { houses: ["work"] })).rejects.toThrow("bot home/cat: key 'claude' is not for workspace 'home' (its workspaces: work)");
  await config.addKey("home-key", { provider: "anthropic", value: "sk-ant-oat01-home", houses: ["home"] });
  await config.updatePet("home", "cat", { key: "home-key" });
  await config.updateKey("claude", { houses: ["work"] });
  expect((await config.load()).keys.map(({ name, houses }) => [name, houses])).toEqual([["claude", ["work"]], ["home-key", ["home"]]]);
});

test("a house's pets get its secrets: a placeholder in their VM, a gateway rule per host that only swaps it", async () => {
  const { config } = store();
  await config.addSecret("work", "github", { value: "ghp_real", hosts: ["github.com"], env: "GITHUB_TOKEN" });
  const household = await config.load();
  const placed = placePets(knownAgents(), household);
  const sibling = placed.find(({ pet }) => pet === "sibling")!;
  expect(sibling.secrets).toEqual([{ name: "github", hosts: [{ host: "github.com", port: 443 }], header: "authorization", env: "GITHUB_TOKEN", placeholder: "household-secret-github" }]);
  expect(placed.find(({ pet }) => pet === "cat")!.secrets).toEqual([]); // another house
  const { pets, secrets } = petKeys(placed, household.keys, new Map(), household.houses);
  expect(secrets["secret.work.github"]).toBe("ghp_real");
  expect(pets.find(({ pet }) => pet === "sibling")!.credentials).toContainEqual({ target: { host: "github.com", port: 443 }, header: "authorization", prefix: "", secret: "secret.work.github", strip: [], match: "household-secret-github" });
  expect(JSON.stringify(pets.find(({ pet }) => pet === "cat"))).not.toContain("github");
});

test("the web API lists, adds, changes and removes secrets; secret hosts do not appear as network grants", async () => {
  const { config } = store();
  const handler = webRoutes({
    auth: new WebAuth(new SqliteStore(":memory:")), config, agents: knownAgents(), channelKinds: knownChannelKinds(), platforms: knownPlatforms(),
    checks: channelChecks("http://127.0.0.1:1"), apply: async () => {}, petStates: async () => [], channelProblem: () => undefined,
    state: () => "running", version: "0.1.0", events: new EventLog(join(tempDir(), "events.jsonl"), () => {}),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handler.local(new Request(`http://household${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
    return { status: response.status, body: await response.json() };
  };
  const added = await call("POST", "/api/houses/work/secrets", { name: "npm", value: "npm_x", hosts: ["registry.npmjs.org"], env: "NPM_TOKEN" });
  expect(added.status).toBe(201);
  expect((await call("GET", "/api/secrets")).status).toBe(404);
  expect((await call("GET", "/api/houses/home/secrets")).body).toEqual([]);
  expect((await call("GET", "/api/houses/missing/secrets")).status).toBe(404);
  expect((await call("PATCH", "/api/houses/home/secrets/npm", { value: "wrong" })).status).toBe(404);
  expect((await call("DELETE", "/api/houses/home/secrets/npm")).status).toBe(404);
  expect((await call("PATCH", "/api/houses/work/secrets/npm", { houses: ["home"] })).status).toBe(400);
  expect((await call("POST", "/api/houses/home/secrets", { name: "npm", value: "home-token", hosts: ["registry.npmjs.org"], env: "NPM_TOKEN" })).status).toBe(201);
  expect(added.body.secrets).toEqual([{ name: "npm", value: "npm_x", hosts: ["registry.npmjs.org"], header: "authorization", env: "NPM_TOKEN", placeholder: "household-secret-npm", note: null }]);
  const work = (await call("GET", "/api/houses/work")).body;
  expect(work.allow.some((entry: { host: string }) => entry.host === "registry.npmjs.org")).toBe(false);
  expect((await call("GET", "/api/houses/home")).body.allow.some((entry: { bySecret?: string }) => entry.bySecret)).toBe(false);
  expect((await call("PATCH", "/api/houses/work/secrets/npm", { note: "CI" })).body.secrets[0].note).toBe("CI");
  expect((await call("POST", "/api/houses/work/secrets", { name: "bad", value: "x", hosts: ["*"], env: "X" })).status).toBe(400);
  expect((await call("DELETE", "/api/houses/work/secrets/npm")).body.secrets).toEqual([]);
  expect((await call("DELETE", "/api/houses/work/secrets/npm")).status).toBe(404);
  expect((await call("GET", "/api/houses/home/secrets")).body[0].value).toBe("home-token");
});

test("placeholder names sharing a prefix select only their own token, including Basic credentials", () => {
  const short = "household-secret-github", long = "household-secret-github-atlas";
  for (const names of [[short, long], [long, short]]) {
    for (const selected of [short, long]) {
      const sent = `Bearer ${selected}`;
      let outgoing = sent;
      for (const name of names) outgoing = fillPlaceholder(sent, name, name === short ? "SHORT_TOKEN" : "LONG_TOKEN") ?? outgoing;
      expect(outgoing).toBe(`Bearer ${selected === short ? "SHORT_TOKEN" : "LONG_TOKEN"}`);
    }
  }
  const basic = `Basic ${Buffer.from(`user:${long}`).toString("base64")}`;
  expect(fillPlaceholder(basic, short, "WRONG_TOKEN")).toBeUndefined();
  expect(fillPlaceholder(basic, long, "$&VALUE")).toBe(`Basic ${Buffer.from("user:$&VALUE").toString("base64")}`);
  expect(fillPlaceholder(`Bearer prefix-${short}`, short, "WRONG_TOKEN")).toBeUndefined();
});

test("secret names and env variables are house-local; concurrent additions cannot overwrite", async () => {
  const { config } = store();
  const fields = { value: "first", hosts: ["github.com"], env: "GITHUB_TOKEN" };
  await config.addSecret("work", "github", fields);
  await config.addSecret("home", "github", { ...fields, value: "second" });
  await expect(config.addSecret("work", "other", fields)).rejects.toThrow("same environment variable");
  const results = await Promise.allSettled([
    config.addSecret("work", "atlas-one", { ...fields, env: "ATLAS_TOKEN" }),
    config.addSecret("work", "atlas-two", { ...fields, env: "ATLAS_TOKEN" }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const household = await config.load();
  const credentials = petKeys(placePets(knownAgents(), household), household.keys, new Map(), household.houses);
  expect(credentials.secrets["secret.work.github"]).toBe("first");
  expect(credentials.secrets["secret.home.github"]).toBe("second");
  expect(credentials.pets.find(pet => pet.house === "work")!.credentials.some(rule => rule.secret === "secret.home.github")).toBe(false);
  await config.updateSecret("work", "github", { value: "changed" });
  expect((await config.load()).houses[1]!.secrets![0]!.value).toBe("second");
  await config.removeSecret("work", "github");
  expect((await config.load()).houses[1]!.secrets![0]!.name).toBe("github");
});
