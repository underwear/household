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
