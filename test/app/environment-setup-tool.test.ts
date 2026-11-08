import { expect, test } from "bun:test";
import { agentRoutes } from "../../src/app/agent-routes";

function setup(run: (house: string, pet: string) => Promise<{ status: "complete" | "failed" | "skipped"; logPath: string; statusPath: string }>) {
  const routes = agentRoutes(
    { onPayload: async () => ({}) },
    { reply: async () => ({ id: "m1", channel: "c1" }), react: async () => ({ id: "m1", reaction: null }) },
    { find: async () => ({ messages: [], more: false }) },
    undefined, { runEnvironmentSetup: run },
  );
  return async (args: object) => {
    const response = await routes({ house: "work", pet: "sibling" }, new Request("http://house/mcp", {
      method: "POST", body: JSON.stringify({ id: 1, method: "tools/call", params: { name: "environment_setup", arguments: args } }),
    }));
    return (await response.json() as { result: { content: { text: string }[]; isError?: boolean } }).result;
  };
}

test("environment setup tool uses only authenticated pet identity, with no command, path or other pet arguments", async () => {
  const calls: string[][] = [];
  const result = { status: "complete" as const, logPath: "/home/pet/environment/setup.log", statusPath: "/home/pet/environment/setup.status" };
  const call = setup(async (house, pet) => { calls.push([house, pet]); return result; });
  for (const args of [{ house: "other" }, { pet: "other" }, { command: "id" }, { path: "/tmp/setup.sh" }]) {
    expect((await call(args)).isError).toBe(true);
  }
  expect(calls).toEqual([]);
  expect(JSON.parse((await call({})).content[0]!.text)).toEqual(result);
  expect(calls).toEqual([["work", "sibling"]]);
});

test("environment setup tool returns failed setup diagnostics without exposing host errors", async () => {
  const failed = { status: "failed" as const, logPath: "/home/pet/environment/setup.log", statusPath: "/home/pet/environment/setup.status" };
  const result = await setup(async () => failed)({});
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0]!.text)).toEqual(failed);
  const error = await setup(async () => { throw new Error("host /private/secret token=secret"); })({});
  expect(error.isError).toBe(true);
  expect(error.content[0]!.text).toContain("~/environment/setup.log");
  expect(error.content[0]!.text).not.toContain("secret");
});
