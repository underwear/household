import {test,expect} from 'bun:test';
import {Scouts,scoutTools,type ScoutDeps} from '../../src/app/scouts';
import {scoutDefinitionSchema} from '../../src/infra/config-schema';
import type {Household} from '../../src/core/household';
const def=scoutDefinitionSchema.parse({name:'helper',description:'QA'});
/** `run`: the owner presses Run on every launch card at once (its cards are kept in `launches`, not `cards`). */
function fixture(run=true,extra:Partial<ScoutDeps>={}){
 const state=new Map<string,string>(),sent:{pet:string;text:string}[]=[],cards:{pet:string;text:string;resolve:(s:any)=>void}[]=[],launches:{pet:string;text:string;resolve:(s:any)=>void}[]=[];
 const config:Household={daemon:{},keys:[],houses:[{name:'work',network:{kind:'allowlist',allow:[]},features:{scouts:true},scoutAgent:{agent:'codex-app-server',key:'codex'},pets:[{name:'parent'},{name:'other'}],people:{owners:[]},channels:[{kind:'telegram',pets:['parent'],token:'x'} as any],scouts:[def]}]};
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
    "🌐 Network: open internet",
  ].join("\n"));
  const risky = launchCard({ pet: "🤖 Boltun", scout: "🛠️ Prod Ops", task: "Check logs", report: "pet", capabilities: [{ name: "datadog" }, { name: "prod-ops", own: true }], network: { open: false, allow: [{ host: "api.heroku.com", port: 443 }] }, keysInVm: ["HEROKU_API_KEY"], secrets: ["card_number"], runtime: "opus · 4 vCPU · 2 GiB" });
  expect(risky).toContain("Capabilities: <code>datadog</code>, own setup");
  expect(risky).toContain("🔒 Network: only <code>api.heroku.com</code>");
  expect(risky).not.toContain("Real secrets on the open internet"); // a closed network keeps them in
  expect(risky).toContain("⚠️ Keys inside its VM: <code>$HEROKU_API_KEY</code>");
  expect(risky).toContain("Secrets from 🤖 Boltun: <code>card_number</code>");
  expect(risky).toContain("Result: to you, and to 🤖 Boltun if you pass it");
  expect(risky).toContain("Runs on: opus · 4 vCPU · 2 GiB");
  const here = launchCard({ pet: "🤖 Boltun", scout: "▶️ Content Downloader #1", task: "x", report: "owner", here: true, capabilities: [], network: { open: true, allow: [] }, keysInVm: [], secrets: [] });
  expect(here).toStartWith("<b>▶️ Content Downloader #1 scout · called by 🤖 Boltun</b>");
  expect(here).toContain("Capabilities: none");
  expect(here).not.toContain("Result");
  // Real secrets (keys in its VM, or the pet's) on the open internet: the card says what that risks.
  const warning = "⚠️ Real secrets on the open internet: a tricked scout can send them anywhere.";
  for (const real of [{ keysInVm: ["TOKEN"], secrets: [] }, { keysInVm: [], secrets: ["card_number"] }]) expect(launchCard({ pet: "p", scout: "s", task: "x", report: "owner", capabilities: [], network: { open: true, allow: [] }, ...real })).toContain(`🌐 Network: open internet\n${warning}`);
  expect(plain).not.toContain(warning);
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

/** Owner cards answered at once (`answer` for a thread deletion), each telling its handle; launch-card rewrites and thread removals recorded. */
function threadFixture(extra: Partial<ScoutDeps> = {}){
 const asked:string[]=[],rewrites:{ref:string;text:string;link:boolean}[]=[],removed:string[]=[];
 const answer={delete:'yes' as 'yes'|'no'};
 const f=fixture(true,{
  choose:async(_c,card)=>{asked.push(card.text);card.posted?.({place:'work/parent',ref:`post-${asked.length}` as any});return card.text.includes('wants to delete the thread')?answer.delete:'yes';},
  status:async(_run,_text,handle)=>handle??'status-card',
  rewrite:async(_run,notice,text,link)=>{rewrites.push({ref:notice.ref,text,link});},
  removeThread:async run=>{removed.push(run.id);return 1;},
  ...extra,
 });
 return {...f,asked,rewrites,removed,answer};
}
test('once its thread is up with its card, the launch card says the scout was spawned, with a button to its thread',async()=>{
 const {scouts,rewrites,asked}=threadFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Check this'});await settle();
 expect(rewrites).toEqual([{ref:'post-1',text:`${asked[0]}\n\n<b>✅ Spawned new scout 🧭 helper #1</b>`,link:true}]);
 expect(scouts.list('work').find(r=>r.id===id)!.announcement).toMatchObject({place:'work/parent',ref:'post-1'});
 scouts.opened();await settle();
 expect(rewrites).toHaveLength(1); // once
 await scouts.stop();
});
test('an ended scout thread is deleted only for its pet and on the owner\'s Delete',async()=>{
 const {scouts,rewrites,removed,asked,answer}=threadFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Check this'});await settle();
 await scouts.cancel(parent,id);await settle();
 expect(scouts.ended(parent)).toEqual([expect.objectContaining({id,status:'cancelled',title:'🧭 helper #1'})]);
 await expect(scouts.deleteThread({house:'work',pet:'other'},id)).rejects.toThrow('calling bot');
 answer.delete='no';
 expect(await scouts.deleteThread(parent,id)).toMatchObject({deleted:false});
 expect(removed).toEqual([]);
 expect(asked.at(-1)).toContain('<b>Delete thread</b> stops this scout if it is still active, then removes the thread with all its messages and files, for good: this cannot be undone.');
 answer.delete='yes';
 expect(await scouts.deleteThread(parent,id)).toEqual({deleted:true});
 expect(removed).toEqual([id]);
 expect(rewrites.at(-1)).toEqual({ref:'post-1',text:`${asked[0]}\n\n<b>🗑 The thread of 🧭 helper #1 was deleted.</b>`,link:false});
 expect(scouts.ended(parent)).toEqual([]);
 await expect(scouts.deleteThread(parent,id)).rejects.toThrow('deleted already');
 await scouts.stop();
});
test('the thread tools: listed for pets only; the delete tool says it is irreversible and needs the human\'s yes',()=>{
 const {scouts}=fixture();const tools=scoutTools(scouts,()=>true);
 const del=tools.find(t=>t.name==='scout_thread_delete')!;
 expect(del.available!(parent)).toBe(true);
 expect(del.description).toContain('Irreversible');
 expect(del.description).toContain('No prior chat agreement is needed');
 expect(del.description).toContain('active or ended');
 expect(tools.find(t=>t.name==='scouts_ended')!.available!(parent)).toBe(true);
});

test('a Slack-launched scout stays in its origin channel, including owner cards and later parent activity', async()=>{
 let current='slack-private:TTEST:DTEST';
 const chosen:string[]=[];
 const {scouts,config,state}=fixture(true,{
  channel:()=>current,
  choose:async(_caller,card,_signal,channel)=>{chosen.push(channel!);card.posted?.({place:`pet:parent@${channel}`,ref:'launch-card' as any});return 'yes';},
 });
 config.houses[0]!.channels=[
  {kind:'telegram-private',chat:'123',token:'test',pets:['parent']},
  {kind:'slack-private',chat:'TTEST:DTEST',token:'test',appToken:'test',pets:['parent']},
 ];
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Stay in Slack'});await settle();
 current='telegram-private:123';
 let channels=scouts.expanded(config).houses[0]!.channels;
 expect(channels[0]!.pets).toEqual(['parent']);
 expect(channels[1]!.pets).toEqual(['parent',id]);
 expect(channels[1]!.default).toBe('parent');
 expect(scouts.run('work',id)!.channel).toBe('slack-private:TTEST:DTEST');
 expect(JSON.parse(state.get('scouts.runs.v1')!)[0].channel).toBe('slack-private:TTEST:DTEST');
 await scouts.parentSend({house:'work',pet:id},'Result');await settle();
 expect(chosen.every(c=>c==='slack-private:TTEST:DTEST')).toBe(true);
 config.houses[0]!.channels.splice(1,1);
 channels=scouts.expanded(config).houses[0]!.channels;
 expect(channels[0]!.pets).toEqual(['parent']); // Removed origin never falls back to Telegram.
 await scouts.stop();
});

test('a scout refuses a missing calling conversation instead of silently using the first channel',async()=>{
 const {scouts}=fixture(true,{channel:()=>undefined});
 await expect(scouts.spawn(parent,{scout:'helper',task:'Test'})).rejects.toThrow('calling conversation');
 await scouts.stop();
});

test('explicit scout places pin launch cards while later scout cards use its own thread', async()=>{
 const chosen:{pet:string;origin?:string}[]=[];
 const {scouts,config}=fixture(true,{
  place:()=>({channel:'slack-private:T:D',origin:'inbox@slack-private:T:D',publicOrigin:'inbox@c2'}),
  choose:async(caller,_card,_signal,_channel,origin)=>{chosen.push({pet:caller.pet,origin});return 'yes';},
 });
 config.houses[0]!.channels.push({kind:'slack-private',chat:'T:D',token:'test',appToken:'test',pets:['parent']});
 const run=await scouts.spawn(parent,{scout:'helper',task:'test',place:'inbox@c2',placement:'thread'});await settle();
 expect(run.place).toBe(`pet:${run.id}@c2`);
 expect(chosen[0]).toEqual({pet:'parent',origin:'inbox@slack-private:T:D'});
 await scouts.parentSend({house:'work',pet:run.id},'Result');await settle();
 expect(chosen.at(-1)).toEqual({pet:run.id,origin:undefined});
 const same=await scouts.ownerSpawn('work','helper',{task:'same',pet:'parent',place:'inbox@c2',placement:'same'});await settle();
 expect(same.place).toBe('inbox@c2');
 expect(scouts.expanded(config).houses[0]!.pets.find(p=>p.name===same.id)?.chatPlace).toBe('inbox@slack-private:T:D');
 await scouts.stop();
});

test('an active scout may request thread deletion: Keep leaves it running, Delete stops it before removing history', async()=>{
 const ordering:string[]=[];
 const {scouts,answer,removed}=threadFixture({removeThread:async run=>{
  ordering.push(run.status);
  expect(run.cleanupPending).toBe(false);
  removed.push(run.id);return 1;
 }});
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Running task'});await settle();
 answer.delete='no';
 expect(await scouts.deleteThread(parent,id)).toMatchObject({deleted:false});
 expect(scouts.run('work',id)!.status).toBe('running');
 expect(removed).toEqual([]);
 answer.delete='yes';
 expect(await scouts.deleteThread(parent,id)).toEqual({deleted:true});
 expect(ordering).toEqual(['cancelled']);
 expect(scouts.run('work',id)).toMatchObject({status:'cancelled',threadDeleted:true});
 await scouts.stop();
});

test('an adapter without deletion support does not ask the owner or stop the scout; cancel still removes only its VM', async()=>{
 const {scouts,asked,removed}=threadFixture({canRemoveThread:()=>false});
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Keep history'});await settle();
 const before=asked.length;
 expect(await scouts.deleteThread(parent,id)).toMatchObject({deleted:false,reason:expect.stringContaining('does not support')});
 expect(asked).toHaveLength(before);
 expect(scouts.run('work',id)!.status).toBe('running');
 await scouts.cancel(parent,id);
 expect(scouts.run('work',id)).toMatchObject({status:'cancelled'});
 expect(scouts.run('work',id)!.threadDeleted).toBeUndefined();
 expect(removed).toEqual([]);
 await scouts.stop();
});

test('aborting a deletion request through the tool leaves the active scout and thread intact', async()=>{
 const {scouts,removed}=threadFixture({choose:async(_caller,card,signal)=>{
  if(!card.text.includes('wants to delete the thread')) return 'yes';
  return await new Promise<undefined>(resolve=>signal.addEventListener('abort',()=>resolve(undefined),{once:true}));
 }});
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Keep running'});await settle();
 const tool=scoutTools(scouts,()=>true).find(t=>t.name==='scout_thread_delete')!;
 const controller=new AbortController();
 const pending=tool.call(parent,{id},controller.signal);await settle();controller.abort();
 expect(JSON.parse(await pending as string)).toMatchObject({deleted:false});
 expect(scouts.run('work',id)!.status).toBe('running');
 expect(removed).toEqual([]);
 await scouts.stop();
});

test("pending scouts and probes reserve the shared pool; chosen sizes override defaults and cleanup releases it", async () => {
 const {scouts,config}=fixture(false,{otherAllocations:()=>[{name:'sw-one',kind:'sideworker',cpus:1,memoryMiB:512}]});
 config.houses[0]!.resources={cpus:7,memoryMiB:8192};
 config.houses[0]!.scoutLimits={maxScouts:0};
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Small task',cpus:1,memoryMiB:512});
 expect(scouts.allocations('work')).toEqual([expect.objectContaining({name:id,cpus:1,memoryMiB:512,state:'waiting_approval'})]);
 await expect(scouts.spawn(parent,{scout:'helper',task:'Too big',cpus:2})).rejects.toThrow('available 1 vCPU');
 await expect(scouts.launchProbe('work',{name:'test',description:'',install:'',network:{any:true,allow:[]},keys:[]})).rejects.toThrow('budget exceeded');
 await scouts.cancel(parent,id);
 expect(scouts.allocations('work')).toEqual([]);
 await scouts.spawn(parent,{scout:'helper',task:'Fits now',cpus:2,memoryMiB:1024});
 await scouts.stop();
});

test('a message from the calling pet reaches its scout only on the owner\'s Pass',async()=>{
  const {scouts,cards,sent}=fixture();const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test'});await settle();sent.length=0;
  expect(await scouts.send(parent,id,'use the staging site')).toEqual({status:'waiting_owner'});await settle();
  // The card is in the calling pet's place (asked as the pet), with the text as written; nothing is delivered yet.
  expect(cards).toHaveLength(1);expect(cards[0]!.pet).toBe('parent');expect(cards[0]!.text).toContain('wants to tell');expect(cards[0]!.text).toContain('use the staging site');
  expect(sent).toEqual([]);expect(scouts.status(parent,id).status).toBe('waiting_owner');
  cards[0]!.resolve('yes');await settle();
  expect(sent).toHaveLength(1);expect(sent[0]!.pet).toBe(id);expect(sent[0]!.text).toContain('passed by your human');expect(sent[0]!.text).toContain('use the staging site');
  // Dropped: the scout gets nothing, its pet is told.
  sent.length=0;await scouts.send(parent,id,'DROPPED TEXT');await settle();cards[1]!.resolve('no');await settle();
  expect(sent).toHaveLength(1);expect(sent[0]!.pet).toBe('parent');expect(sent[0]!.text).toContain('not passed');expect(sent[0]!.text).not.toContain('DROPPED TEXT');
  // Unanswered when the run ends: nothing reaches either side about it.
  sent.length=0;await scouts.send(parent,id,'TOO LATE');await settle();await scouts.cancel(parent,id);await settle();
  expect(sent.some(s=>s.text.includes('TOO LATE')||s.text.includes('not passed'))).toBe(false);
  await expect(scouts.send(parent,id,'after')).rejects.toThrow('ended');
});
test('no message to a scout before the owner pressed Run',async()=>{
  const {scouts,cards}=fixture(false);const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test'});await settle();
  await expect(scouts.send(parent,id,'hi')).rejects.toThrow('not started');expect(cards).toEqual([]);
});
test('a secret request escalated to the owner: given on Allow, refused on Deny or silence',async()=>{
  const given:string[]=[];
  const {scouts,cards,sent}=fixture(true,{secret:async(_r,key,value)=>{given.push(`${key}=${value}`);}});
  const {id}=await scouts.spawn(parent,{scout:'helper',task:'Test'});await settle();const self={house:'work',pet:id};
  await scouts.askSecret(self,'phone');
  expect(sent.at(-1)!.pet).toBe('parent');expect(sent.at(-1)!.text).toContain('scout_secret_escalate');
  await expect(async()=>scouts.escalation({house:'work',pet:'other'},id,'phone')).toThrow();
  await expect(async()=>scouts.escalation(parent,id,'card')).toThrow('No pending request');
  expect(scouts.escalation(parent,id,'phone').key).toBe('phone');
  const giving=scouts.ownerSecret(self,'phone','5550100');await settle();cards.at(-1)!.resolve('yes');
  expect(await giving).toEqual({status:'given'});expect(given).toEqual(['phone=5550100']);
  expect(scouts.status(parent,id).secret_requests).toEqual([{key:'phone',status:'given'}]);
  expect(sent.at(-1)!.pet).toBe(id);expect(sent.at(-1)!.text).not.toContain('5550100');
  await scouts.askSecret(self,'card');const denying=scouts.ownerSecret(self,'card','4242');await settle();cards.at(-1)!.resolve('no');
  expect(await denying).toEqual({status:'refused'});expect(given).toHaveLength(1);
  expect(sent.at(-1)).toEqual({pet:id,text:expect.stringContaining('refused by your human')});
  await scouts.askSecret(self,'otp');scouts.secretUnanswered(self,'otp');
  expect(scouts.status(parent,id).secret_requests.map(q=>q.status)).toEqual(['given','refused','refused']);
  expect(sent.at(-1)).toEqual({pet:id,text:expect.stringContaining('not supplied')});
  await expect(async()=>scouts.escalation(parent,id,'otp')).toThrow('No pending request');
});

/** A scout on one listed host, routine for `parent`; nothing answers its owner cards on its own (`run` false). */
function routineFixture(extra: Partial<ScoutDeps> = {}){
 const announced:string[]=[],notices:string[]=[],rewrites:string[]=[];
 const f=fixture(false,{
  announce:async(_r,text)=>{announced.push(text);return {place:'pet:parent@telegram:x',ref:'notice-1' as any};},
  notice:async(_r,text)=>{notices.push(text);},
  status:async(_r,_t,handle)=>handle??'status-card',
  rewrite:async(_r,_n,text)=>{rewrites.push(text);},
  ...extra,
 });
 const house=f.config.houses[0]!;
 house.capabilities=[{name:'meter',description:'',install:'',network:{any:false,allow:[{host:'meter.example.com',port:443}]},keys:[]}];
 house.scouts=[{...def,capabilities:['meter'],routine:['parent']}];
 (house.channels[0] as any).pets.push('other');
 return {...f,house,announced,notices,rewrites};
}
test('a routine run starts with no Run card: a notice in its pet\'s place says so, and the scout knows it',async()=>{
 const {scouts,launches,announced,rewrites,sent}=routineFixture();
 expect(await scouts.catalog(parent)).toEqual([expect.objectContaining({name:'helper',network:'only meter.example.com',routine:true})]);
 expect((await scouts.catalog({house:'work',pet:'other'}))[0]).not.toHaveProperty('routine');
 const spawned=await scouts.spawn(parent,{scout:'helper',task:'Submit the meter reading',report:'pet'}),{id}=spawned;await settle();
 expect(spawned).toMatchObject({routine:true});
 expect(launches).toEqual([]);
 expect(scouts.status(parent,id)).toMatchObject({status:'running',routine:true});
 expect(announced).toHaveLength(1);
 expect(announced[0]).toStartWith('<b>parent wants to run 🧭 helper scout</b>');
 expect(announced[0]).toContain('🔒 Network: only <code>meter.example.com</code>');
 expect(announced[0]).toEndWith('\n\n<b>▶ Started as routine: no approval asked.</b>');
 expect(scouts.run('work',id)!.announcement).toMatchObject({ref:'notice-1',text:announced[0]});
 expect(rewrites).toEqual([`${announced[0]}\n\n<b>✅ Spawned new scout 🧭 helper #1</b>`]); // a button to its thread, as after Run
 expect(scouts.run('work',id)!.definition).not.toHaveProperty('routine'); // who may run it stays the owner's
 const start=sent.find(s=>s.pet===id)!.text;
 expect(start).toContain('routine run your human approved in advance');
 expect(start).toContain('reach you without your human reading them first');
 expect(start).toContain('scout_finish({outcome}) closes you at once');
 await scouts.stop();
});
test('a routine run still starts when its notice cannot be posted',async()=>{
 const {scouts}=routineFixture({announce:async()=>{throw new Error('chat down');}});
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 expect(scouts.status(parent,id)).toMatchObject({status:'running',routine:true});
 expect(scouts.run('work',id)!.announcement).toBeUndefined();
 await scouts.stop();
});
test('strict again: another bot, an open network, secrets passed, or the owner\'s own run',async()=>{
 const {scouts,house,launches,announced}=routineFixture();
 house.resources={cpus:16,memoryMiB:16384};
 const other=await scouts.spawn({house:'work',pet:'other'},{scout:'helper',task:'Submit it'});await settle();
 expect(scouts.run('work',other.id)).toMatchObject({status:'waiting_approval'});expect(scouts.run('work',other.id)!.routine).toBeUndefined();
 const secret=await scouts.spawn(parent,{scout:'helper',task:'Submit it',secrets:{account:'ACC-1'}});await settle();
 expect(scouts.run('work',secret.id)!.routine).toBeUndefined();expect(launches.at(-1)!.text).toContain('<code>account</code>');
 const owner=await scouts.ownerSpawn('work','helper',{task:'Submit it',pet:'parent'});await settle();
 expect(scouts.run('work',owner.id)).toMatchObject({byOwner:true,status:'running'});expect(scouts.run('work',owner.id)!.routine).toBeUndefined();
 house.capabilities=[{...house.capabilities![0]!,network:{any:true,allow:[]}}]; // edited since: its network is open now
 expect((await scouts.catalog(parent))[0]).not.toHaveProperty('routine');
 const open=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 expect(scouts.run('work',open.id)).toMatchObject({status:'waiting_approval'});expect(scouts.run('work',open.id)!.routine).toBeUndefined();
 expect(launches).toHaveLength(3);expect(announced).toEqual([]);
 await scouts.stop();
});
test('a routine run: its pet\'s messages go at once and show in its thread; trust taken back brings Pass back',async()=>{
 const {scouts,house,cards,notices,sent}=routineFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();sent.length=0;
 expect(await scouts.send(parent,id,'the reading is 4521')).toEqual({sent:true});
 expect(cards).toEqual([]);
 expect(notices.at(-1)).toBe('💬 parent → 🧭 helper #1\n\nthe reading is 4521');
 expect(sent).toEqual([{pet:id,text:expect.stringContaining('the reading is 4521')}]);
 expect(sent[0]!.text).toContain('your human did not read it first');
 await expect(scouts.send({house:'work',pet:'other'},id,'hi')).rejects.toThrow('calling bot'); // another bot of the workspace gets nothing of it
 house.scouts=[{...house.scouts![0]!,routine:[]}];sent.length=0;
 expect(await scouts.send(parent,id,'one more')).toEqual({status:'waiting_owner'});await settle();
 expect(cards).toHaveLength(1);expect(cards[0]!.text).toContain('wants to tell');expect(sent).toEqual([]);
 expect(scouts.status(parent,id)).not.toHaveProperty('routine');
 await scouts.stop();
});
test('a routine run: what the scout sends back, and secrets for it, still wait for the owner',async()=>{
 const {scouts,cards,sent}=routineFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it',report:'pet'});await settle();const self={house:'work',pet:id};sent.length=0;
 expect(await scouts.parentSend(self,'Submitted: 4521')).toEqual({status:'waiting_owner'});await settle();
 expect(cards).toHaveLength(1);expect(sent.some(s=>s.pet==='parent'&&s.text.includes('4521'))).toBe(false);
 await scouts.askSecret(self,'password');
 expect(await scouts.giveSecret(parent,id,'password','hunter2')).toEqual({status:'waiting_owner'});await settle();
 expect(cards).toHaveLength(2);expect(cards[1]!.text).toContain('gives');
 cards[0]!.resolve('yes');await settle();
 expect(sent.some(s=>s.pet==='parent'&&s.text.includes('Submitted: 4521'))).toBe(true);
 await scouts.stop();
});
test('a routine run ends on scout_finish, with no Close card; its pet hears it is closed, and a pending Pass stays',async()=>{
 const {scouts,cards,sent}=routineFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it',report:'pet'});await settle();const self={house:'work',pet:id};
 await scouts.parentSend(self,'Submitted: 4521');await settle();
 expect(await scouts.finish(self,'success')).toMatchObject({outcome:'success',closing:expect.stringContaining('closes you now')});await settle();
 expect(scouts.status(parent,id)).toMatchObject({status:'done',outcome:'success',routine:true});
 expect(cards).toHaveLength(1); // only its Pass card, no Close card
 const told=sent.filter(s=>s.pet==='parent').map(s=>s.text);
 expect(told).toEqual([expect.stringContaining('routine scout '+id+' is done, with outcome success, and closed')]);
 expect(told[0]).not.toContain('decides');
 cards[0]!.resolve('yes');await settle();
 expect(sent.some(s=>s.pet==='parent'&&s.text.includes('Submitted: 4521'))).toBe(true); // approved after it closed: still delivered
 await scouts.stop();
});
test('a * in a capability\'s hosts makes the network open: the run is strict, its card says open internet',async()=>{
 const {scouts,house,launches}=routineFixture();
 house.capabilities=[{...house.capabilities![0]!,network:{any:false,allow:[{host:'*',port:443}]}}];
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 expect(scouts.run('work',id)!.routine).toBeUndefined();
 expect(launches[0]!.text).toContain('🌐 Network: open internet');
 await scouts.stop();
});
test('one routine run of a scout per pet at a time: a second one while it runs asks for Run',async()=>{
 const {scouts,house,launches}=routineFixture();house.resources={cpus:16,memoryMiB:16384};
 const first=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 const second=await scouts.spawn(parent,{scout:'helper',task:'Submit it again'});await settle();
 expect(first).toMatchObject({routine:true});expect(second).not.toHaveProperty('routine');
 expect(launches).toHaveLength(1);
 await scouts.cancel(parent,first.id);
 expect(await scouts.spawn(parent,{scout:'helper',task:'Next month'})).toMatchObject({routine:true}); // the first one has ended
 await scouts.stop();
});
test('no message to a routine scout before its task: refused while it boots; a strict run in boot still asks',async()=>{
 let boot!:()=>void;const booting=new Promise<void>(resolve=>{boot=resolve;});
 const {scouts,house,cards,sent}=routineFixture({launch:async()=>{await booting;}});house.resources={cpus:16,memoryMiB:16384};
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 expect(scouts.run('work',id)!.status).toBe('running'); // its VM is starting
 await expect(scouts.send(parent,id,'too early')).rejects.toThrow('wait until it runs');
 const strict=await scouts.spawn({house:'work',pet:'other'},{scout:'helper',task:'Submit it'});await settle();
 scouts.run('work',strict.id)!.status='running'; // pressed Run, still booting
 expect(await scouts.send({house:'work',pet:'other'},strict.id,'early but asked')).toEqual({status:'waiting_owner'});await settle();
 expect(cards).toHaveLength(1);
 boot();await settle();
 expect(sent.filter(s=>s.pet===id).map(s=>s.text)[0]).toContain('Task');
 expect(await scouts.send(parent,id,'now')).toEqual({sent:true});
 await scouts.stop();
});
test('trust taken back before scout_finish: the run is no longer routine, and its human gets the Close card',async()=>{
 const {scouts,house,cards,sent}=routineFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 house.scouts=[{...house.scouts![0]!,routine:[]}];
 expect(await scouts.finish({house:'work',pet:id},'success')).toMatchObject({closing:expect.stringContaining('Close or Keep')});await settle();
 expect(cards).toHaveLength(1);expect(cards[0]!.text).toContain('is done');
 expect(scouts.status(parent,id)).toMatchObject({status:'waiting_owner'});expect(scouts.status(parent,id)).not.toHaveProperty('routine');
 expect(sent.some(s=>s.pet==='parent'&&s.text.includes('Your human decides whether to close it'))).toBe(true);
 await scouts.stop();
});
test('a host granted to a routine run ends routine for the rest of it: messages need Pass, finish needs Close',async()=>{
 const {scouts,cards}=routineFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 scouts.accessFact('work',id,'cdn.example.net','pending');scouts.accessFact('work',id,'cdn.example.net','denied');
 expect(scouts.status(parent,id)).toMatchObject({routine:true}); // asked and refused: nothing widened
 scouts.accessFact('work',id,'cdn.example.net','pending');scouts.accessFact('work',id,'cdn.example.net','temporary');
 expect(scouts.status(parent,id)).not.toHaveProperty('routine');
 expect(await scouts.send(parent,id,'the reading')).toEqual({status:'waiting_owner'});
 await scouts.finish({house:'work',pet:id},'success');await settle();
 expect(cards.map(card=>card.text)).toEqual([expect.stringContaining('wants to tell'),expect.stringContaining('is done')]);
 await scouts.stop();
});
test('a wildcard host (*.github.io) keeps a scout strict: routine needs exact hosts; its card still says closed',async()=>{
 const {scouts,house,launches}=routineFixture();
 house.capabilities=[{...house.capabilities![0]!,network:{any:false,allow:[{host:'*.github.io',port:443}]}}];
 expect((await scouts.catalog(parent))[0]).not.toHaveProperty('routine');
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 expect(scouts.run('work',id)!.routine).toBeUndefined();
 expect(launches[0]!.text).toContain('🔒 Network: only <code>*.github.io</code>');
 await scouts.stop();
});
test('the owner allowing a host ends routine on the decision; the network card of a routine run says its messages went unreviewed',async()=>{
 const {scouts}=routineFixture();
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 expect(scouts.networkFacts('work',id)).toEqual(['Routine run: messages from parent reached it unreviewed.']);
 scouts.grantDecided('work',id);
 expect(scouts.status(parent,id)).not.toHaveProperty('routine');
 expect(scouts.networkFacts('work',id)).toEqual([]);
 expect(await scouts.send(parent,id,'next')).toEqual({status:'waiting_owner'});
 expect(scouts.networkFacts('work','parent')).toEqual([]); // not a scout
 await scouts.stop();
});
test('finish after the run was cancelled while the config was read: no Close card',async()=>{
 let during:(()=>Promise<unknown>)|undefined,config!:Household;
 const f=routineFixture({configured:async()=>{const hook=during;during=undefined;await hook?.();return config;}});const {scouts,house,cards}=f;
 config=f.config;
 const {id}=await scouts.spawn(parent,{scout:'helper',task:'Submit it'});await settle();
 house.scouts=[{...house.scouts![0]!,routine:[]}]; // taken back: finish reads the config
 during=()=>scouts.cancel(parent,id);
 expect(await scouts.finish({house:'work',pet:id},'success')).toMatchObject({closing:'You have ended already.'});await settle();
 expect(cards).toEqual([]);
 expect(scouts.status(parent,id).status).toBe('cancelled');
 await scouts.stop();
});
