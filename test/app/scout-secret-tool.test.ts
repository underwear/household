import { expect, test } from "bun:test";
import { ScoutSecretRequests } from "../../src/app/scout-secrets";
import { secretRequestTool, type SecretRequests } from "../../src/app/secret-requests";
import type { Scouts } from "../../src/app/scouts";
import { scoutDecision } from "../../src/app/scouts";
import { mcpHandler } from "../../src/infra/mcp-server";
import type { PetIdentity } from "../../src/infra/agent-api";

test("secret_request exposes exactly one role-specific schema and dispatches by caller", async () => {
  const notices:string[]=[];
  const isScout=(caller:PetIdentity)=>caller.pet==="scout-test";
  const scouts={isScout,run:()=>({status:"running"})} as unknown as Scouts;
  const scoutRequests=new ScoutSecretRequests(scouts,async(_,text)=>{notices.push(text);});
  const requested:unknown[]=[];
  const petRequests={request:async(...args:unknown[])=>{requested.push(args);return {status:"pending"};}} as unknown as SecretRequests;
  const handler=mcpHandler({name:"test",version:"1"},[scoutRequests.tool(),{...secretRequestTool(petRequests),available:(caller:PetIdentity)=>!isScout(caller)}]);
  const rpc=async(pet:string,method:string,params?:unknown)=>await (await handler({house:"work",pet},new Request("http://localhost/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}))).json();
  const scoutTools=(await rpc("scout-test","tools/list")).result.tools;
  const petTools=(await rpc("sibling","tools/list")).result.tools;
  expect(scoutTools).toHaveLength(1);expect(petTools).toHaveLength(1);
  expect(scoutTools[0].name).toBe("secret_request");expect(scoutTools[0].inputSchema.required).toEqual(["key"]);
  expect(petTools[0].inputSchema.required).toEqual(["name","env","domains","reason"]);
  expect((await rpc("scout-test","tools/call",{name:"secret_request",arguments:{key:"phone"}})).result.isError).toBeUndefined();
  expect(notices).toHaveLength(1);expect(requested).toHaveLength(0);
  expect((await rpc("scout-test","tools/call",{name:"secret_request",arguments:{name:"token",env:"TOKEN",domains:["example.com"],reason:"test"}})).result.isError).toBe(true);
  expect((await rpc("sibling","tools/call",{name:"secret_request",arguments:{key:"phone"}})).result.isError).toBe(true);
  expect((await rpc("sibling","tools/call",{name:"secret_request",arguments:{name:"token",env:"TOKEN",domains:["example.com"],reason:"test"}})).result.isError).toBeUndefined();
  expect(requested).toHaveLength(1);
});

test("scout decisions replace the question with an explicit completed decision",()=>{
  for(const [yes,no,approved,declined] of [
    ["Run","Cancel","Scout launch approved.","Scout launch cancelled."],
    ["Pass text","Drop","Text passed to 🐾 Sibling.","Text dropped. Nothing of it was sent."],
    ["Allow","Deny","Secret transfer approved.","Secret transfer denied."],
  ]) {
    const card=scoutDecision("Original question",yes!,no!,approved,declined);
    expect(card.view("yes").text).toBe(`<b>${approved}</b>`);
    expect(card.view("no").text).toBe(`<b>${declined}</b>`);
    expect("choices" in card.view("yes")).toBe(false);
  }
  const launch=scoutDecision("<b>Sibling wants to run General</b>","Run","Cancel","▶ Launched.","Cancelled.",true);
  expect(launch.view("yes").text).toBe("<b>Sibling wants to run General</b>\n\n<b>▶ Launched.</b>"); // a launch card keeps what was run
});
