import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { petEnvironment } from "../../src/app/environment";
import { agentRoutes } from "../../src/app/agent-routes";
import { ConfigStore } from "../../src/infra/config-store";
import { tempDir } from "../helpers";

function fixture() {
  const path = join(tempDir(), "household.yaml");
  writeFileSync(path, "keys:\n  secret: {provider: anthropic, value: private-secret}\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: {key: secret}\n      other: {key: secret, environment: {setup: other-script}}\n");
  const config = new ConfigStore(path);
  const calls: unknown[][] = [];
  const result = { status: "complete" as const, logPath: "/home/pet/environment/setup.log", statusPath: "/home/pet/environment/setup.status" };
  const environment = petEnvironment(config, {
    environmentSetupResult: (_h, _p, phase) => phase === "onStart" ? undefined : result,
    runEnvironmentSetup: async (...args) => { calls.push(args); return result; },
  }, (job) => job(), () => true);
  const routes = agentRoutes({ onPayload: async () => ({}) }, { reply: async () => ({ id: "m1", channel: "c1" }), react: async () => ({ id: "m1", reaction: null }) }, { find: async () => ({ messages: [], more: false }) }, undefined, environment);
  const call = async (name: string, args: unknown = {}) => {
    const response = await routes({ house: "work", pet: "sibling" }, new Request("http://house/mcp", { method: "POST", body: JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } }) }));
    return (await response.json()).result;
  };
  return { path, config, environment, calls, result, call };
}

test("saved environment tools persist only the authenticated pet and run latest config without reload", async () => {
  const { config, path, calls, result, call } = fixture();
  const script = "#!/bin/bash\nprintf saved\\n\n";
  const before = JSON.parse((await call("environment_get")).content[0].text);
  expect(before).toEqual({ setup: null, onStart: null, lastRun: result, onStartLastRun: null });
  expect(JSON.stringify(before)).not.toContain("private-secret");
  expect((await call("environment_update", { setup: script })).isError).toBeUndefined();
  expect((await new ConfigStore(path).load()).houses[0]!.pets[0]!.environment?.setup).toBe(script);
  await call("environment_setup");
  expect(calls).toEqual([["work", "sibling", script, "setup"]]);
  expect((await config.load()).houses[0]!.pets[1]!.environment?.setup).toBe("other-script");
  for (const args of [{ pet: "other" }, { house: "other" }, { path: "/tmp/else" }]) {
    expect((await call("environment_get", args)).isError).toBe(true);
    expect((await call("environment_update", { ...args, setup: "attack" })).isError).toBe(true);
  }
  for (const setup of [null, ""]) {
    await call("environment_update", { setup });
    expect(JSON.parse((await call("environment_get")).content[0].text).setup).toBeNull();
    await call("environment_setup");
    expect(calls.at(-1)).toEqual(["work", "sibling", undefined, "setup"]);
    await call("environment_update", { setup: script });
  }
});

test("saved environment rejects missing, malformed and oversized scripts", async () => {
  const { call } = fixture();
  for (const args of [{}, { setup: 1 }, { setup: "é".repeat(32769) }]) expect((await call("environment_update", args)).isError).toBe(true);
});

test("restart reads latest saved setup within the lifecycle queue and rejects pets no longer applied", async () => {
  const { config } = fixture();
  const calls: unknown[][] = [];
  let applied = true;
  let queued = 0;
  const environment = petEnvironment(config, {
    environmentSetupResult: () => undefined,
    runEnvironmentSetup: async () => { throw new Error("unexpected direct setup"); },
  }, async (job) => { queued++; return job(); }, () => applied, async (...args) => { calls.push(args); });
  await config.updatePetEnvironment("work", "sibling", { setup: "printf restart" });
  expect(await environment.restartEnvironment("work", "sibling")).toEqual({ setup: "printf restart", onStart: null, lastRun: null, onStartLastRun: null });
  expect(calls).toEqual([["work", "sibling", "printf restart", undefined]]);
  expect(queued).toBe(1);
  applied = false;
  await expect(environment.restartEnvironment("work", "sibling")).rejects.toThrow("no longer applied");
  await expect(environment.restartEnvironment("work", "missing")).rejects.toThrow("no longer configured");
  expect(calls).toHaveLength(1);
});

test("graceful restart waits outside lifecycle queue, rejects duplicates and releases delivery on failure", async () => {
  const { config } = fixture();
  let finish!: () => void;
  let entered = false;
  let queued = 0;
  let released = 0;
  const environment = petEnvironment(config, {
    environmentSetupResult: () => undefined,
    runEnvironmentSetup: async () => { throw new Error("unused"); },
  }, async job => { queued++; return job(); }, () => true,
  async () => { throw new Error("VM unavailable"); },
  async () => { entered = true; await new Promise<void>(r => { finish = r; }); return () => { released++; }; });
  const restart = environment.restartEnvironment("work", "sibling", "notify");
  while (!entered) await new Promise(r => setTimeout(r, 1));
  expect(queued).toBe(0);
  await expect(environment.restartEnvironment("work", "sibling")).rejects.toThrow("already restarting");
  finish();
  await expect(restart).rejects.toThrow("VM unavailable");
  expect(released).toBe(1);
  expect(queued).toBe(1);
  await expect(environment.restartEnvironment("work", "sibling")).rejects.toThrow("VM unavailable");
});

test("soft disable notifies outside queue, blocks restart, then stops without starting and releases", async () => {
  const { config } = fixture();
  const calls: string[] = [];
  let finish!: () => void;
  const environment = petEnvironment(config, {
    environmentSetupResult: () => undefined,
    runEnvironmentSetup: async () => { throw new Error("unused"); },
  }, async job => { calls.push("queue"); return job(); }, () => true,
  async () => { calls.push("restart"); },
  async (_h,_p,action) => { calls.push(action!); await new Promise<void>(r=>{finish=r;}); return ()=>{calls.push("release");}; },
  async () => { calls.push("stop"); });
  const disabled = environment.disableEnvironment!("work","sibling","notify");
  while (!finish) await new Promise(r=>setTimeout(r,1));
  expect(calls).toEqual(["disable"]);
  await expect(environment.restartEnvironment("work","sibling")).rejects.toThrow("already restarting");
  finish(); await disabled;
  expect(calls).toEqual(["disable","stop","release"]);
  await environment.disableEnvironment!("work","sibling","now");
  expect(calls.at(-1)).toBe("stop");
});

test("onStart tools preserve setup, run only their phase and clear fields independently", async () => {
  const { call, config, calls } = fixture();
  await call("environment_update", { setup: "install", onStart: "start" });
  await call("environment_update", { onStart: "start latest" });
  expect((await config.load()).houses[0]!.pets[0]!.environment).toEqual({ setup: "install", onStart: "start latest" });
  await call("environment_on_start");
  expect(calls.at(-1)).toEqual(["work", "sibling", "start latest", "onStart"]);
  await call("environment_update", { setup: null });
  expect((await config.load()).houses[0]!.pets[0]!.environment).toEqual({ onStart: "start latest" });
  for (const args of [{ onStart: 42 }, { onStart: "\0" }, { onStart: "é".repeat(32769) }]) {
    expect((await call("environment_update", args)).isError).toBe(true);
  }
  expect((await call("environment_on_start", { pet: "other" })).isError).toBe(true);
});

test("workers read parent scripts and execute in their own VM without changing parent configuration", async () => {
  const { config } = fixture();
  await config.updatePetEnvironment("work", "sibling", { setup: "install-parent-tools", onStart: "start-services" });
  const ran: unknown[][] = [];
  const environment = petEnvironment(config, {
    environmentSetupResult: () => undefined,
    runEnvironmentSetup: async (...args) => { ran.push(args); return { status: "complete", logPath: "/home/worker/environment/setup.log", statusPath: "/home/worker/environment/setup.status" }; },
  }, job => job(), () => true, undefined, undefined, undefined, (_house, pet) => pet === "sw-test" ? "sibling" : pet);
  expect((await environment.getEnvironment("work", "sw-test")).setup).toBe("install-parent-tools");
  await environment.runEnvironmentSetup("work", "sw-test");
  await environment.runEnvironmentSetup("work", "sw-test", "onStart");
  expect(ran).toEqual([["work", "sw-test", "install-parent-tools", "setup"], ["work", "sw-test", "start-services", "onStart"]]);
  await expect(environment.updateEnvironment("work", "sw-test", { setup: "oops" })).rejects.toThrow("inherit");
  expect((await environment.getEnvironment("work", "sibling")).setup).toBe("install-parent-tools");
});
