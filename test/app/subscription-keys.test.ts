import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SubscriptionKeys } from "../../src/app/subscription-keys";
import { codexAppServer } from "../../src/agent-adapters/codex-app-server";
import type { CodexRefreshOptions } from "../../src/agent-adapters/codex-app-server/host-auth";
import type { PlacedPet } from "../../src/app/agents";
import { keySecret } from "../../src/app/gateway";
import { tempDir } from "../helpers";

const key = { name: "codex", provider: "openai" as const, value: "codex-chatgpt:account" };
const use = codexAppServer.useKey(key.provider, key.value);
if ("problem" in use) throw new Error(use.problem);
const pet: PlacedPet = { house: "work", pet: "sibling", agent: codexAppServer, key: key.name, keyUse: use, model: "gpt-6.1-terra" };

test("subscription staging isolates dedicated homes and publishes refresh/revocation only after commit", async () => {
  const dir = tempDir();
  const sessions: { options: CodexRefreshOptions; stopped: boolean }[] = [];
  const refresh = async (options: CodexRefreshOptions) => {
    const session = { options, stopped: false };
    sessions.push(session);
    await options.onToken("codex", "host-token");
    return { stop() { session.stopped = true; } };
  };
  const manager = new SubscriptionKeys(join(dir, "secrets"), join(dir, "config", "household.yaml"), () => {}, refresh);
  const first = await manager.prepare([pet], [key]);
  expect(sessions[0]!.options.keys[0]!.home).toBe(join(dir, "config", "codex-auth", "codex"));
  const secret = join(dir, "secrets", keySecret("codex"));
  expect(existsSync(secret)).toBe(false);
  expect(Object.values(first.credentials.secrets)).toEqual(["host-token"]);
  first.commit();
  expect(readFileSync(secret, "utf8")).toBe("host-token");
  const candidate = await manager.prepare([pet], [key]);
  candidate.cancel();
  expect(sessions[1]!.stopped).toBe(true);
  expect(sessions[0]!.stopped).toBe(false);
  await sessions[0]!.options.onToken("codex", "refreshed");
  expect(readFileSync(secret, "utf8")).toBe("refreshed");
  await sessions[0]!.options.onToken("codex", undefined);
  expect(readFileSync(secret, "utf8")).toBe("");
  manager.stop();
  expect(sessions[0]!.stopped).toBe(true);
});

test("failed initial authentication cannot inject a subscription marker as a bearer token", async () => {
  const dir = tempDir();
  let stopped = false;
  const manager = new SubscriptionKeys(dir, join(dir,"household.yaml"), () => {}, async () => ({ stop() { stopped = true; } }));
  await expect(manager.prepare([pet], [key])).rejects.toThrow("not authenticated");
  expect(stopped).toBe(true);
  expect(existsSync(join(dir, keySecret("codex")))).toBe(false);
});
