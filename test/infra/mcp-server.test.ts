import { expect, test } from "bun:test";
import { mcpHandler } from "../../src/infra/mcp-server";

const calls: { caller: string; args: unknown }[] = [];
const handle = mcpHandler<string>({ name: "household", version: "1" }, [
  {
    name: "reply",
    description: "Say something",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
    async call(caller, args) {
      if (args.text === "boom") throw new Error("not sent");
      calls.push({ caller, args });
      return "sent";
    },
  },
]);

const rpc = async (body: unknown, method = "POST") => {
  const response = await handle("work/sibling", new Request("http://x/mcp", { method, body: method === "POST" ? JSON.stringify(body) : undefined }));
  return { status: response.status, body: (response.status === 200 ? await response.json() : await response.text()) as any };
};

test("initialize answers with the client's protocol version when known, else the newest", async () => {
  const init = (protocolVersion: string) => rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion } });
  expect((await init("2025-06-18")).body).toEqual({
    jsonrpc: "2.0",
    id: 0,
    result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "household", version: "1" } },
  });
  expect((await init("2099-01-01")).body.result.protocolVersion).toBe("2025-11-25");
});

test("notifications get 202, GET (a server stream) 405, unknown methods and bad JSON errors", async () => {
  expect(await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({ status: 202, body: "" });
  expect((await rpc(undefined, "GET")).status).toBe(405);
  // claude probes a newer protocol first and falls back on "method not found"
  expect((await rpc({ jsonrpc: "2.0", id: "probe", method: "server/discover" })).body.error.code).toBe(-32601);
  const bad = await handle("x", new Request("http://x/mcp", { method: "POST", body: "{" }));
  expect(((await bad.json()) as any).error.code).toBe(-32700);
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).body.result).toEqual({});
});

test("tools are listed and called with the caller; a failing tool is an error result, an unknown one an error", async () => {
  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list.body.result.tools[0]).toMatchObject({ name: "reply", description: "Say something" });
  const call = (args: object, name = "reply") => rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  expect((await call({ text: "hi" })).body.result).toEqual({ content: [{ type: "text", text: "sent" }] });
  expect(calls).toEqual([{ caller: "work/sibling", args: { text: "hi" } }]);
  expect((await call({ text: "boom" })).body.result).toEqual({ content: [{ type: "text", text: "not sent" }], isError: true });
  expect((await call({}, "nope")).body.error).toEqual({ code: -32602, message: "unknown tool nope" });
  // `additionalProperties: false` is enforced before the tool runs.
  expect((await call({ text: "hi", chat_id: 1 })).body.result).toEqual({
    content: [{ type: "text", text: "unknown arguments: chat_id (reply takes: text)" }],
    isError: true,
  });
  expect(calls).toHaveLength(1);
});
