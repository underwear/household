import {test,expect} from 'bun:test';
import {Scouts,scoutTools,type ScoutDeps} from '../../src/app/scouts';
import {scoutDefinitionSchema} from '../../src/infra/config-schema';
import type {Household} from '../../src/core/household';
const def=scoutDefinitionSchema.parse({name:'helper',description:'QA'});
/** `run`: the owner presses Run on every launch card at once (its cards are kept in `launches`, not `cards`). */
function fixture(run=true,extra:Partial<ScoutDeps>={}){
 const state=new Map<string,string>(),sent:{pet:string;text:string}[]=[],cards:{pet:string;text:string;resolve:(s:any)=>void}[]=[],launches:{pet:string;text:string;resolve:(s:any)=>void}[]=[];
 const config:Household={daemon:{},keys:[],secrets:[],houses:[{name:'work',network:{kind:'allowlist',allow:[]},features:{scouts:true},scoutAgent:{agent:'codex-app-server',key:'codex'},pets:[{name:'parent'},{name:'other'}],people:{owners:[]},channels:[{kind:'telegram',pets:['parent'],token:'x'} as any],scouts:[def]}]};
 const deps:ScoutDeps={store:{get:(k:string)=>state.get(k),delete:(k:string)=>{state.delete(k);},set:(k:string,v:string)=>{state.set(k,v);}} as any,configured:async()=>config,choose:async(c,card,signal)=>new Promise(resolve=>{const launch=card.text.includes(' wants to run ');if(launch&&run){launches.push({pet:c.pet,text:card.text,resolve});resolve('yes');return;}(launch?launches:cards).push({pet:c.pet,text:card.text,resolve});signal.addEventListener('abort',()=>resolve(undefined));}),prepare:async r=>({definition:r.scout,parent:r.parent,homePath:'/tmp/test',instructions:'scout',network:{kind:'allowlist',allow:[]}}),launch:async()=>{},ready:async()=>true,remove:async()=>{},closedNotice:()=>async()=>{},notice:async()=>{},send:(_h,pet,text)=>{sent.push({pet,text});},secret:async()=>{},log:()=>{},...extra};
 const scouts=new Scouts(deps);return {scouts,config,sent,cards,launches,state};
}
const parent={house:'work',pet:'parent'};
const settle=()=>new Promise(r=>setTimeout(r,10));
test('a launch the owner ran gives only catalog/facts and isolates runtime identity',async()=>{const {scouts,config,sent}=fixture();expect(await scouts.catalog(parent)).toEqual([{name:'helper',title:undefined,description:'QA',capabilities:[],network:'open internet'}]);const {id}=await scouts.spawn(parent,{scout:'helper',task:'Check this',report:'owner'});await settle();expect(scouts.status(parent,id).status).toBe('running');expect(scouts.expanded(config).houses[0]!.pets.at(-1)!.scout?.parent).toBe('parent');expect(JSON.stringify(scouts.status(parent,id))).not.toContain('Check this');expect(sent[0]?.pet).toBe(id);await scouts.stop();});
test('every launch waits for the owner; secrets show by name only, never stored raw',async()=>{const {scouts,launches:cards,state}=fixture(false);const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test',secrets:{card_number:'QA_PRIVATE_123'}});await settle();expect(scouts.status(parent,id).status).toBe('waiting_approval');expect(cards[0]?.text).toContain('card_number');expect(cards[0]?.text).not.toContain('QA_PRIVATE_123');expect([...state.values()].join('')).not.toContain('QA_PRIVATE_123');cards[0]!.resolve('yes');await settle();expect(scouts.status(parent,id).status).toBe('running');await scouts.stop();});
test('scout text is moderated and secrets masked before Pass',async()=>{const {scouts,cards,sent}=fixture();const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test',secrets:{token:'MASK_THIS_VALUE'}});await settle();await scouts.parentSend({house:'work',pet:id},'Result MASK_THIS_VALUE');await settle();expect(sent.filter(s=>s.pet==='parent')).toHaveLength(0);expect(cards[0]!.text).toContain('[masked]');cards[0]!.resolve('yes');await settle();expect(sent.find(s=>s.pet==='parent')?.text).toContain('Result [masked]');await scouts.stop();});
test('Drop never delivers, other pets cannot send or answer secrets, can cancel',async()=>{const {scouts,cards,sent}=fixture();const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test'});await settle();await scouts.parentSend({house:'work',pet:id},'DROP ME');cards[0]!.resolve('no');await settle();expect(sent.some(s=>s.pet==='parent'&&s.text.includes('DROP ME'))).toBe(false);await expect(scouts.send({house:'work',pet:'other'},id,'hi')).rejects.toThrow();await expect(scouts.askSecret({house:'work',pet:id},'bad key')).rejects.toThrow();await scouts.cancel({house:'work',pet:'other'},id);expect(scouts.status(parent,id).status).toBe('cancelled');await expect(scouts.cancel({house:'another',pet:'parent'},id)).rejects.toThrow();});
test('scout tools have separate role and feature availability',()=>{const {scouts}=fixture();const tools=scoutTools(scouts,()=>false);expect(tools.find(t=>t.name==='scout_spawn')!.available!(parent)).toBe(false);expect(tools.find(t=>t.name==='parent_send')!.available!(parent)).toBe(false);});

test('finish only asks the human to close it: the outcome reaches the pet at once, the run ends on Close',async()=>{
 const {scouts,cards,sent}=fixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test',report:'pet'});await settle();
 await scouts.parentSend({house:'work',pet:id},'MODERATED RESULT');
 expect(await scouts.finish({house:'work',pet:id},'success')).toMatchObject({outcome:'success'});await settle();
 expect(sent.some(s=>s.pet==='parent'&&s.text.includes('says it is done, with outcome success'))).toBe(true);
 expect(sent.some(s=>s.pet==='parent'&&s.text.includes('MODERATED RESULT'))).toBe(false);
 expect(cards.map(card=>card.text)).toEqual([expect.stringContaining('MODERATED RESULT'),expect.stringContaining('is done')]);
 await new Promise(resolve=>setTimeout(resolve,300));await scouts.tick();
 expect(scouts.status(parent,id).status).toBe('waiting_owner'); // nothing ends on the scout's word
 cards[0]!.resolve('yes');await settle();
 expect(sent.some(s=>s.pet==='parent'&&s.text.includes('MODERATED RESULT'))).toBe(true);
 expect(scouts.status(parent,id).status).toBe('waiting_owner'); // its Close card is still open
 cards[1]!.resolve('yes');await settle();
 expect(scouts.status(parent,id)).toMatchObject({status:'done',outcome:'success'});
 await scouts.stop();
});
test('the Close card: who is done, how it went, what each button does, block by block',async()=>{
 const {scouts,cards}=fixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test'});await settle();
 await scouts.finish({house:'work',pet:id},'success');await settle();
 const blocks=cards[0]!.text.split('\n\n');
 expect(blocks[0]).toBe('<b>🏁 🧭 helper #1 is done</b>');
 expect(blocks[1]).toMatch(/^Outcome: ✅ success · \d+ s$/);
 expect(blocks[2]).toBe('<b>Close</b> deletes its VM; what it sent you stays.\n<b>Keep</b> leaves it running for more.');
 await scouts.stop();
});
test('Keep leaves the scout running, told to wait for its human; a second finish asks again',async()=>{
 const {scouts,cards,sent}=fixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test'});await settle();
 await scouts.finish({house:'work',pet:id},'blocked');await settle();
 expect((await scouts.finish({house:'work',pet:id},'blocked')).closing).toContain('already has a Close card');
 expect(cards).toHaveLength(1);
 cards[0]!.resolve('no');await settle();
 expect(scouts.status(parent,id).status).toBe('running');
 expect(sent.some(s=>s.pet===id&&s.text.includes('Your human keeps you running'))).toBe(true);
 await scouts.finish({house:'work',pet:id},'success');await settle();
 expect(cards).toHaveLength(2);
 cards[1]!.resolve('yes');await settle();
 expect(scouts.status(parent,id)).toMatchObject({status:'done',outcome:'success'});
 await scouts.stop();
});
test('finished scout closes after Drop without delivering its report',async()=>{
 const {scouts,cards,sent}=fixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test',report:'pet'});await settle();
 await scouts.parentSend({house:'work',pet:id},'DROPPED RESULT');
 await scouts.finish({house:'work',pet:id},'blocked');await settle();
 cards[0]!.resolve('no');cards[1]!.resolve('yes');await settle();
 expect(scouts.status(parent,id)).toMatchObject({status:'done',outcome:'blocked'});
 expect(sent.some(s=>s.pet==='parent'&&s.text.includes('DROPPED RESULT'))).toBe(false);
 await scouts.stop();
});

test("runs saved before capabilities load into history without them", async () => {
  const data = new Map<string, string>();
  const store = { get: (key: string) => data.get(key), set: (key: string, value: string) => void data.set(key, value) };
  store.set("scouts.runs.v1", JSON.stringify([{ id: "scout-old", house: "work", scout: "general", parent: "sibling", task: "old", status: "done", createdAt: 1, steps: 0, definition: { name: "general" } }]));
  const { Scouts } = await import("../../src/app/scouts");
  const scouts = new Scouts({ store } as never);
  expect(scouts.run("work", "scout-old")).toMatchObject({ capabilities: [], blueprint: "general" });
});

test("a pet calls scouts only by name, never assembles one; a scout runs on the house's agent or its own", async () => {
  const { scouts, config, launches } = fixture();
  const house = config.houses[0]!;
  house.capabilities = [
    { name: "browser", description: "", install: "", network: { any: true, allow: [] }, keys: [] },
    { name: "prod", description: "", install: "", network: { any: false, allow: [{ host: "api.heroku.com", port: 443 }] }, keys: [] },
  ];
  await expect(scouts.spawn(parent, { capabilities: ["browser"], task: "Test" })).rejects.toThrow("Call a scout by name");
  await expect(scouts.spawn(parent, { task: "Test" })).rejects.toThrow("scout: a name");
  await expect(scouts.spawn(parent, { scout: "nobody", task: "Test" })).rejects.toThrow("Unknown scout");
  const { id } = await scouts.spawn(parent, { scout: "helper", task: "Test" }); await settle();
  expect(scouts.run("work", id)!.definition).toMatchObject({ agent: "codex-app-server", resources: { cpus: 2, memoryMiB: 2048 } });
  expect(scouts.run("work", id)!.blueprint).toBe("helper");
  await scouts.cancel(parent, id);
  house.scouts = [{ ...house.scouts![0]!, capabilities: ["prod"], agent: { agent: "claude-code-tmux", key: "claude", model: "opus" }, resources: { cpus: 4 } }];
  const special = await scouts.spawn(parent, { scout: "helper", task: "Test" }); await settle();
  expect(scouts.run("work", special.id)!.definition).toMatchObject({ agent: "claude-code-tmux", model: "opus", resources: { cpus: 4, memoryMiB: 2048 } });
  expect(launches.at(-1)!.text).toContain("Runs on: opus · 4 vCPU · 2 GiB"); // its own runtime shows on the card
  await scouts.stop();
});

test("no time limit: an idle scout reminds the pet that called it every 30 minutes, and keeps running", async () => {
  let now = 1_000_000, idle = true;
  const { scouts, sent } = fixture(true, { now: () => now, isIdle: async () => idle });
  const { id } = await scouts.spawn(parent, { scout: "helper", task: "Test" }); await settle();
  const reminders = () => sent.filter(each => each.pet === "parent" && each.text.includes("has been idle"));
  now += 29 * 60_000; await scouts.tick();
  expect(reminders()).toHaveLength(0);
  now += 2 * 60_000; await scouts.tick();
  expect(reminders()).toHaveLength(1);
  expect(reminders()[0]!.text).toContain(`scout_cancel({id: "${id}"})`);
  expect(reminders()[0]!.text).toContain("not a message from your human");
  await scouts.tick(); expect(reminders()).toHaveLength(1); // once per 30 minutes
  now += 31 * 60_000; await scouts.tick();
  expect(reminders()).toHaveLength(2);
  now += 24 * 60 * 60_000; idle = false; await scouts.tick(); // a day later, busy with a long command: no reminder
  expect(reminders()).toHaveLength(2);
  expect(scouts.status(parent, id).status).toBe("running"); // never stopped by Household
  await scouts.cancel(parent, id);
  expect(scouts.status(parent, id).status).toBe("cancelled");
});

test("a scout's thread is its name and its run's number, never the task", async () => {
  const { scouts, config } = fixture();
  config.houses[0]!.scoutLimits = { maxScouts: 3 };
  await scouts.spawn(parent, { scout: "helper", task: "Download https://example.com/a-very-long-link-to-a-video and send it" });
  await scouts.spawn(parent, { scout: "helper", task: "Another" }); await settle();
  const titles = scouts.expanded(config).houses[0]!.pets.filter(pet => pet.scout).map(pet => pet.title);
  expect(titles).toEqual(["helper #1", "helper #2"]);
  await scouts.stop();
});

test("the launch card: who wants to run which scout, the task, then what it can do; the default result goes unsaid", async () => {
  const { launchCard } = await import("../../src/app/scouts");
  const plain = launchCard({ pet: "🤖 Boltun", scout: "▶️ Content Downloader", task: "Download <this>", report: "owner", capabilities: [{ name: "media" }], network: { open: true, allow: [] }, keysInVm: [], secrets: [] });
  expect(plain).toBe([
    "<b>🤖 Boltun wants to run ▶️ Content Downloader scout</b>",
    "",
    "Task:",
    "<blockquote>Download &lt;this&gt;</blockquote>",
    "",
    "Capabilities: <code>media</code>",
    "Network: open internet",
  ].join("\n"));
  const risky = launchCard({ pet: "🤖 Boltun", scout: "🛠️ Prod Ops", task: "Check logs", report: "pet", capabilities: [{ name: "datadog" }, { name: "prod-ops", own: true }], network: { open: false, allow: [{ host: "api.heroku.com", port: 443 }] }, keysInVm: ["HEROKU_API_KEY"], secrets: ["card_number"], runtime: "opus · 4 vCPU · 2 GiB" });
  expect(risky).toContain("Capabilities: <code>datadog</code>, own setup");
  expect(risky).toContain("Network: only <code>api.heroku.com</code>");
  expect(risky).toContain("⚠️ Keys inside its VM: <code>$HEROKU_API_KEY</code>");
  expect(risky).toContain("Secrets from 🤖 Boltun: <code>card_number</code>");
  expect(risky).toContain("Result: to you, and to 🤖 Boltun if you pass it");
  expect(risky).toContain("Runs on: opus · 4 vCPU · 2 GiB");
  const here = launchCard({ pet: "🤖 Boltun", scout: "▶️ Content Downloader #1", task: "x", report: "owner", here: true, capabilities: [], network: { open: true, allow: [] }, keysInVm: [], secrets: [] });
  expect(here).toStartWith("<b>▶️ Content Downloader #1 scout · called by 🤖 Boltun</b>");
  expect(here).toContain("Capabilities: none");
  expect(here).not.toContain("Result");
});

test("the scout's thread opens with its task and a live status: booting, installing (its log's last line), ready, how it ended", async () => {
  let routed = false, progress: string | undefined, boot!: () => void;
  const posts: string[] = [], edits: string[] = [], notices: string[] = [];
  const booting = new Promise<void>(resolve => { boot = resolve; });
  const { scouts } = fixture(true, {
    status: async (_run, text, handle) => { if (handle) { edits.push(text); return handle; } if (!routed) return undefined; posts.push(text); return "card"; },
    setupProgress: async () => progress,
    launch: async () => { await booting; },
    notice: async (_run, text) => { notices.push(text); },
  });
  const { id } = await scouts.spawn(parent, { scout: "helper", task: "Download the video" }); await settle();
  expect(posts).toHaveLength(0); // no thread yet: nothing posted, nothing lost
  routed = true; scouts.opened(); await settle();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("<b>🧭 helper #1 scout · called by parent</b>");
  expect(posts[0]).toContain("Task:\n<blockquote>Download the video</blockquote>");
  expect(posts[0]).toContain("Network: open internet");
  expect(posts[0]).toContain("🖥 Booting its VM… 0 s");
  const tick = () => (scouts as unknown as { show(run: unknown): Promise<void> }).show(scouts.run("work", id));
  progress = "Setting up ffmpeg (7:5.1.6) <ok>"; await tick();
  expect(edits.at(-1)).toContain("📦 Setting up… 0 s\n<code>Setting up ffmpeg (7:5.1.6) &lt;ok&gt;</code>");
  boot(); await settle();
  expect(edits.at(-1)).toContain("✅ Working on it · ready in");
  expect(notices.at(-1)).toMatch(/^🧭 helper #1 is ready \(\d+ s\) and starts on the task\.$/); // a new message lifts the thread
  await scouts.cancel(parent, id); await settle();
  expect(edits.at(-1)).toContain("⏹ Stopped");
  await scouts.stop();
});

test("the owner starts a scout themself: no Run card, the pet hears nothing of it, its reminders are the owner's", async () => {
  const notices: string[] = [];
  let now = 1_000_000;
  const { scouts, launches, sent } = fixture(false, { notice: async (_r, text) => void notices.push(text), now: () => now });
  const { id } = await scouts.ownerSpawn("work", "helper", { task: "A long task\n".repeat(20) }); // past a pet's 10 lines
  await settle();
  expect(launches).toHaveLength(0);
  expect(scouts.run("work", id)).toMatchObject({ status: "running", byOwner: true, parent: "parent", report: "owner" });
  expect(sent.find((s) => s.pet === id)?.text).toStartWith("Household: Your human started you directly");
  now += 31 * 60_000;
  await scouts.tick();
  expect(sent.some((s) => s.pet === "parent")).toBe(false);
  expect(notices.at(-1)).toContain(`house scout cancel work ${id}`);
  await scouts.cancel({ house: "work", pet: "owner" }, id);
  expect(sent.some((s) => s.pet === "parent")).toBe(false); // not told it was cancelled either
  await expect(scouts.ownerSpawn("work", "helper", { task: "x", pet: "other" })).rejects.toThrow("A channel is required"); // its thread needs the pet's channel
  await expect(scouts.ownerSpawn("work", "missing", { task: "x" })).rejects.toThrow("Unknown scout");
  await scouts.stop();
});

test("a failed setup is kept on the run: its VM is gone after", async () => {
  const { scouts } = fixture(true, { setupFailure: async () => "Setup failed. Last lines:\napt-get: E: Unable to locate package nope" });
  const { id } = await scouts.ownerSpawn("work", "helper", { task: "Test" });
  await settle();
  expect(scouts.run("work", id)).toMatchObject({ status: "failed", setupFailure: expect.stringContaining("Unable to locate package") });
  await scouts.stop();
});
