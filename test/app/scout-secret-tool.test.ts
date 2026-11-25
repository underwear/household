import { expect, test } from "bun:test";
import { ScoutSecretRequests } from "../../src/app/scout-secrets";
import { secretRequestTool, type SecretRequests } from "../../src/app/secret-requests";
import type { Scouts } from "../../src/app/scouts";
import { scoutDecision } from "../../src/app/scouts";
import { mcpHandler } from "../../src/infra/mcp-server";
import type { PetIdentity } from "../../src/infra/agent-api";

test("a scout has no secret_request: only its calling pet asks the owner, with scout_secret_escalate", async () => {
  const notices:string[]=[],unanswered:string[]=[],given:unknown[]=[];
  const isScout=(caller:PetIdentity)=>caller.pet==="scout-test";
  const scouts={isScout,
    escalation:(c:PetIdentity,id:string,key:string)=>{if(c.pet!=="sibling"||id!=="scout-test")throw new Error("Only the calling bot may do this");return {run:{id},key,pet:"🤖 Sibling",scout:"🧭 General #1"};},
    ownerSecret:async(...args:unknown[])=>{given.push(args.slice(0,3));return {status:"given"};},
    secretUnanswered:(_:PetIdentity,key:string)=>{unanswered.push(key);}} as unknown as Scouts;
  const scoutRequests=new ScoutSecretRequests(scouts,async(c,text)=>{notices.push(`${c.pet}: ${text}`);});
  const requested:unknown[]=[];
  const petRequests={request:async(...args:unknown[])=>{requested.push(args);return {status:"pending"};}} as unknown as SecretRequests;
  const handler=mcpHandler({name:"test",version:"1"},[scoutRequests.tool(()=>true),{...secretRequestTool(petRequests),available:(caller:PetIdentity)=>!isScout(caller)}]);
  const rpc=async(pet:string,method:string,params?:unknown)=>await (await handler({house:"work",pet},new Request("http://localhost/mcp",{method:"POST",body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}))).json();
  expect((await rpc("scout-test","tools/list")).result.tools).toEqual([]);
  expect((await rpc("sibling","tools/list")).result.tools.map((tool:{name:string})=>tool.name)).toEqual(["scout_secret_escalate","secret_request"]);
  for (const name of ["secret_request","scout_secret_escalate"]) expect((await rpc("scout-test","tools/call",{name,arguments:{key:"phone",id:"scout-test"}})).result?.isError??true).toBe(true);
  expect((await rpc("other","tools/call",{name:"scout_secret_escalate",arguments:{id:"scout-test",key:"phone"}})).result.isError).toBe(true);
  expect(notices).toEqual([]);
  // The owner is asked in the scout's thread, in the pet's name; a second request waits for the first.
  const asked=await rpc("sibling","tools/call",{name:"scout_secret_escalate",arguments:{id:"scout-test",key:"phone",reason:"SMS code <b>"}});
  expect(JSON.parse(asked.result.content[0].text)).toEqual({status:"waiting_owner"});
  expect(notices).toHaveLength(1);expect(notices[0]).toStartWith("scout-test: ");
  for (const part of ["🤖 Sibling asks you","<code>phone</code>","SMS code &lt;b&gt;","/secret"]) expect(notices[0]).toContain(part);
  expect(JSON.parse((await rpc("sibling","tools/call",{name:"scout_secret_escalate",arguments:{id:"scout-test",key:"card"}})).result.content[0].text)).toEqual({status:"busy",key:"phone"});
  // Only the owner's /secret in that thread answers it; the value goes to the run under the asked key.
  const said:string[]=[];let removed=0;
  const input=(owner:boolean,text:string)=>({house:"work",pet:"scout-test",text,owner,edited:false,relayed:false,remove:async()=>{removed++;},notice:async(text:string)=>{said.push(text);},choose:async()=>undefined});
  expect(await scoutRequests.handle(input(false,"/secret nope"))).toBe(true);expect(given).toEqual([]);
  expect(await scoutRequests.handle(input(true,"/secret 5550100"))).toBe(true);
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(removed).toBe(1);expect(given).toEqual([[{house:"work",pet:"scout-test"},"phone","5550100"]]);
  expect(await scoutRequests.handle(input(true,"/secret again"))).toBe(true);expect(said.at(-1)).toContain("No active secret request");
  expect(unanswered).toEqual([]);
  scoutRequests.stop();
});

test("scout decisions replace the question with an explicit completed decision",()=>{
  for(const [yes,no,approved,declined] of [
    ["Run","Cancel","Scout launch approved.","Scout launch cancelled."],
    ["Pass text","Drop","Text passed to 🤖 Sibling.","Text dropped. Nothing of it was sent."],
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
