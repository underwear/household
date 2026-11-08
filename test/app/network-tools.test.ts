import { expect, test } from "bun:test";
import { agentRoutes } from "../../src/app/agent-routes";

test("network MCP tools list current allowances, require a reason, reject extra arguments and forward cancellation", async () => {
  const requests: unknown[][] = [];
  const routes = agentRoutes(
    { onPayload: async () => ({}) },
    { reply: async () => ({ id: "m1", channel: "c1" }), react: async () => ({ id: "m1", reaction: null }) },
    { find: async () => ({ messages: [], more: false }) },
    {
      list: (house, pet) => { requests.push([house, pet]); return { allowed: [{ host: "github.com", port: 443 }], temporary: [] }; },
      request: async (house, pet, domain, reason, port, signal) => {
        requests.push([house, pet, domain, reason, port, signal]);
        return { domain, port: port ?? 443, status: "denied" };
      },
    },
  );
  const call = async (name: string, args: object, signal?: AbortSignal) => {
    const response = await routes({ house: "work", pet: "sibling" }, new Request("http://house/mcp", {
      method: "POST", signal, body: JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } }),
    }));
    return (await response.json() as { result: { content: { text: string }[]; isError?: boolean } }).result;
  };
  const listed = await call("network_list", {});
  expect(JSON.parse(listed.content[0]!.text).allowed).toEqual([{ host: "github.com", port: 443 }]);
  expect((await call("network_request", { domain: "github.com" })).isError).toBe(true);
  expect((await call("network_request", { domain: "github.com", reason: "GitHub issue lookup", wildcard: true })).isError).toBe(true);
  expect(requests).toHaveLength(1);
  for (const port of [0, 65536, 1.5, "22", null]) {
    expect((await call("network_request", { domain: "github.com", reason: "GitHub issue lookup", port })).isError).toBe(true);
  }
  expect(requests).toHaveLength(1);
  const controller = new AbortController();
  expect(JSON.parse((await call("network_request", { domain: "github.com", reason: "GitHub issue lookup" }, controller.signal)).content[0]!.text).status).toBe("denied");
  expect(requests[1]!.slice(0, 4)).toEqual(["work", "sibling", "github.com", "GitHub issue lookup"]);
  expect(requests[1]![4]).toBe(443);
  const forwarded = requests[1]![5] as AbortSignal;
  expect(forwarded.aborted).toBe(false);
  const explicit = await call("network_request", { domain: "github.com", reason: "GitHub SSH", port: 22 });
  expect(JSON.parse(explicit.content[0]!.text).port).toBe(22);
  expect(requests[2]!.slice(0, 5)).toEqual(["work", "sibling", "github.com", "GitHub SSH", 22]);
  controller.abort();
  expect(forwarded.aborted).toBe(true);
});
