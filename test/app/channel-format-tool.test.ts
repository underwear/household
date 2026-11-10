import { expect, test } from "bun:test";
import { agentRoutes } from "../../src/app/agent-routes";

test("channel_format resolves the authenticated pet's default or requested channel and returns adapter instructions", async () => {
  const calls: unknown[][] = [];
  const format = { name: "test-format", instructions: "Use <b>bold</b>." };
  const routes = agentRoutes(
    { onPayload: async () => ({}) },
    {
      reply: async () => ({ id: "m1", channel: "c1" }),
      react: async () => ({ id: "m1", reaction: null }),
      replyFormat: (house, pet, channel) => {
        calls.push([house, pet, channel]);
        if (channel === "c9") throw new Error("not a channel you are in");
        return { channel: channel ?? "c1", ...format };
      },
    },
    { find: async () => ({ messages: [], more: false }) },
  );
  const rpc = async (method: string, params: object = {}) => {
    const response = await routes({ house: "work", pet: "sibling" }, new Request("http://house/mcp", {
      method: "POST", body: JSON.stringify({ id: 1, method, params }),
    }));
    return await response.json() as any;
  };
  const listed = await rpc("tools/list");
  expect(listed.result.tools.some((tool: { name: string }) => tool.name === "channel_format")).toBe(true);
  const call = async (args: object) => (await rpc("tools/call", { name: "channel_format", arguments: args })).result;
  expect(JSON.parse((await call({})).content[0].text)).toEqual({ channel: "c1", ...format });
  expect(JSON.parse((await call({ channel: "c2" })).content[0].text)).toEqual({ channel: "c2", ...format });
  expect(calls).toEqual([["work", "sibling", undefined], ["work", "sibling", "c2"]]);
  expect((await call({ channel: null })).isError).toBe(true);
  expect((await call({ pet: "other" })).isError).toBe(true);
  expect(calls).toHaveLength(2);
  const denied = await call({ channel: "c9" });
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain("not a channel you are in");
});

test("reply rich mode and edit_reply use authenticated identity and opaque ids", async () => {
  const calls: unknown[][] = [];
  const routes = agentRoutes({ onPayload: async () => ({}) }, {
    reply: async (...args) => { calls.push(args); return { id: "m9", channel: "c2" }; },
    editReply: async (...args) => { calls.push(args); return { id: "m9", channel: "c2" }; },
    react: async () => ({ id: "m1", reaction: null }),
  }, { find: async () => ({ messages: [], more: false }) });
  async function call(name: string, args: object) {
    return (await (await routes({ house: "work", pet: "sibling" }, new Request("http://house/mcp", {
      method: "POST", body: JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } }),
    }))).json() as any).result;
  }
  expect((await call("reply", { text: "# Report", format: "rich" })).isError).toBeUndefined();
  expect(calls[0]).toEqual(["work", "sibling", "# Report", undefined, undefined, "rich"]);
  expect((await call("edit_reply", { id: "m9", channel: "c2", text: "# Done" })).isError).toBeUndefined();
  expect(calls[1]).toEqual(["work", "sibling", "c2", "m9", "# Done"]);
  for (const args of [{ id: "m9", channel: "c2", text: "bad", pet: "other" }, { id: "m9", text: "missing channel" }, { id: "m9", channel: "c2", text: null }]) {
    expect((await call("edit_reply", args)).isError).toBe(true);
  }
  expect((await call("reply", { text: "bad", format: "unknown" })).isError).toBe(true);
  expect(calls).toHaveLength(2);
});

test("place_create uses the caller's identity and validates title and destination", async () => {
  const calls:unknown[][]=[];
  const routes=agentRoutes({onPayload:async()=>({})},{reply:async()=>({id:"m1",channel:"c1"}),react:async()=>({id:"m1",reaction:null}),createPlace:async(...args)=>{calls.push(args);return {id:"topic:new@c1",kind:"topic",title:args[2],channel:"c1"};}},{find:async()=>({messages:[],more:false})});
  const call=async(args:object)=>(await (await routes({house:"work",pet:"sibling"},new Request("http://house/mcp",{method:"POST",body:JSON.stringify({id:1,method:"tools/call",params:{name:"place_create",arguments:args}})}))).json() as any).result;
  expect(JSON.parse((await call({title:"Project",place:"inbox@c1"})).content[0].text)).toMatchObject({id:"topic:new@c1"});
  expect(calls).toEqual([["work","sibling","Project","inbox@c1"]]);
  for(const args of [{title:5},{title:""},{title:"x",pet:"other"},{title:"x",place:5}]) expect((await call(args)).isError).toBe(true);
  expect(calls).toHaveLength(1);
});

test("channel tools expose schemas and pass authenticated identity; malformed calls and sideworkers are refused", async () => {
  const calls: unknown[][] = [];
  const routes = agentRoutes({ onPayload: async () => ({}) }, {
    reply: async () => ({ id: "m1", channel: "c1" }), react: async () => ({ id: "m1", reaction: null }),
    channelTools: (...args) => { calls.push(args); return []; },
    channelTool: async (...args) => { calls.push(args.slice(0, 7)); return { id: "m7", channel: "c1", place: "chair@c1", text: "sent" }; },
  }, { find: async () => ({ messages: [], more: false }) }, undefined, undefined, undefined, undefined, [], caller => caller.pet === "helper");
  async function rpc(method: string, params: object = {}, pet = "chair") {
    return await (await routes({ house: "work", pet }, new Request("http://house/mcp", {
      method: "POST", body: JSON.stringify({ id: 1, method, params }),
    }))).json() as any;
  }
  expect((await rpc("tools/list")).result.tools.map((t: any) => t.name)).toContain("channel_tools");
  expect((await rpc("tools/list", {}, "helper")).result.tools.map((t: any) => t.name)).not.toContain("channel_tool");
  await rpc("tools/call", { name: "channel_tools", arguments: { place: "chair@c1" } });
  await rpc("tools/call", { name: "channel_tool", arguments: { name: "telegram_update_widget", arguments: { chat_data: "{}" }, place: "chair@c1", id: "m7" } });
  expect(calls).toEqual([["work", "chair", "chair@c1"], ["work", "chair", "telegram_update_widget", { chat_data: "{}" }, "chair@c1", "m7", expect.any(AbortSignal)]]);
  for (const args of [{ name: "x", arguments: [] }, { name: "x", arguments: {}, place: 4 }, { name: "x", arguments: {}, pet: "other" }]) {
    expect((await rpc("tools/call", { name: "channel_tool", arguments: args })).result.isError).toBe(true);
  }
  expect(calls).toHaveLength(2);
});
