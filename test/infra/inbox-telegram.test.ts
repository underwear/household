import {expect,test} from "bun:test";
import {createTelegramBotReader} from "../../src/infra/inbox-pollers/telegram";
import {houseInboxSchema, telegramInboxProblems} from "../../src/core/house-inboxes";
import type {House} from "../../src/core/household";
const token = "12345:ABCDEFGHIJKLMNOPQRSTUVWXYZ_test";
const source = {kind:"telegram-bot" as const,token};
const signal = () => new AbortController().signal;
function fixture() {
  let updates: Record<string,unknown>[] = [], webhook = "", failure = 0;
  const calls: URL[] = [];
  const reader = createTelegramBotReader(async (url,init) => {
    const u = new URL(url); calls.push(u);
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("error");
    expect(u.origin).toBe("https://api.telegram.org");
    expect(u.searchParams.has("allowed_updates")).toBe(false);
    const method = u.pathname.split("/").at(-1);
    if (failure) return new Response(token,{status:failure});
    if (method === "getMe") return Response.json({ok:true,result:{id:12345,is_bot:true}});
    if (method === "getWebhookInfo") return Response.json({ok:true,result:{url:webhook,pending_update_count:updates.length}});
    if (method !== "getUpdates") throw Error("Forbidden method");
    const offset = Number(u.searchParams.get("offset") ?? 0);
    expect(offset).toBeGreaterThanOrEqual(0);
    updates = updates.filter(v => Number(v.update_id) >= offset);
    return Response.json({ok:true,result:updates.slice(0,50)});
  });
  return {reader,calls,put:(n:number)=>{updates.push({update_id:n,message:{message_id:n,chat:{id:-100123,title:"Test"},from:{id:9},date:1794225600,text:`Message ${n}`}});},webhook:(s:string)=>webhook=s,fail:(n:number)=>failure=n};
}
test("Telegram probe never consumes updates or changes a webhook", async()=>{
  const f=fixture(); f.put(1);
  await f.reader.test(source,signal());
  expect(f.calls.map(u=>u.pathname.split('/').at(-1))).toEqual(["getMe","getWebhookInfo"]);
  f.webhook("https://private.example/hook");
  await expect(f.reader.test(source,signal())).rejects.toThrow("webhook");
  await expect(f.reader.poll(source,undefined,"latest",signal())).rejects.toThrow("webhook");
  expect(f.calls.some(u=>u.pathname.endsWith('/getUpdates'))).toBe(false);
});
test("Telegram baseline drains more than one page, delivers new arrivals, and acknowledges on the next poll", async()=>{
  const f=fixture(); for(let n=1;n<=75;n++)f.put(n);
  const first=await f.reader.poll(source,undefined,"new",signal());
  expect(first.items).toHaveLength(0); expect(first.baselineHandled).toBe(true);
  expect(f.calls.at(-1)!.searchParams.has('offset')).toBe(false);
  f.put(76);
  const second=await f.reader.poll(source,first.cursor,"new",signal());
  expect(second.items.map(i=>i.id)).toEqual(["76"]);
  expect(second.items[0]!.metadata).toMatchObject({type:"message",updateId:76,chat:{id:-100123},from:{id:9},message_id:76});
  expect(second.items[0]!.occurredAt).toBeDefined();
  expect(f.calls.at(-1)!.searchParams.get('offset')).toBe("51");
  const restart=await f.reader.poll(source,second.cursor,"new",signal());
  expect(restart.items).toHaveLength(0);
  expect(f.calls.at(-1)!.searchParams.get('offset')).toBe("77");
});
test("Telegram import, non-message updates, token-safe errors and idle reset", async()=>{
  const f=fixture(); f.put(10);
  expect((await f.reader.poll(source,undefined,"latest",signal())).items).toHaveLength(1);
  await f.reader.poll(source,JSON.stringify({offset:999,skip:0,lastUpdateAt:Date.now()-8*86400000}),"new",signal());
  expect(f.calls.at(-1)!.searchParams.has('offset')).toBe(false);
  f.fail(409); await expect(f.reader.poll(source,undefined,"new",signal())).rejects.toThrow("another poller");
  const broken=createTelegramBotReader(async()=>{throw Error(`fetch failed https://api.telegram.org/bot${token}/getMe`);});
  try {await broken.test(source,signal()); throw Error('expected failure');} catch(e){expect((e as Error).message).not.toContain(token);}
  const callback=createTelegramBotReader(async u=>Response.json({ok:true,result:u.endsWith('getWebhookInfo')?{url:"",pending_update_count:1}:[{update_id:2,callback_query:{id:"cb",data:"action",from:{id:4}}}]}));
  expect((await callback.poll(source,undefined,"latest",signal())).items[0]!.metadata).toMatchObject({type:"callback_query",data:"action"});
});
test("Telegram bots cannot share queues with another inbox or Household channel",()=>{
  const inbox=houseInboxSchema.parse({name:"updates",title:"Updates",channel:"one",pets:[],source});
  const h:House={name:"work",pets:[],people:{owners:[]},network:{kind:"allowlist",allow:[]},channels:[],inboxes:[inbox]};
  expect(telegramInboxProblems([h])).toEqual([]);
  expect(telegramInboxProblems([h,{...h,name:"other"}])).toHaveLength(1);
  h.channels=[{kind:"telegram-private",chat:"one",token:"12345:rotated",pets:[]}];
  expect(telegramInboxProblems([h])).toHaveLength(1);
});
