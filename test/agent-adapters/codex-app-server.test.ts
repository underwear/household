import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAppServer, PLACEHOLDER_API_KEY } from "../../src/agent-adapters/codex-app-server";
import { codexAccountId, createPlaceholderJwt } from "../../src/agent-adapters/codex-app-server/auth";
import { askOf, answerFor } from "../../src/agent-adapters/codex-app-server/dialogs";
import { translatePacket } from "../../src/agent-adapters/codex-app-server/translate";
import { failureFileFor, runBridge } from "../../src/agent-adapters/codex-app-server/entrypoint";
import { CODEX_MODES, codexPermissions } from "../../src/agent-adapters/codex-app-server/modes";
import { agentOf } from "../../src/app/agents";

test("subscription reference contains metadata only and refuses invalid keys without repeating them", () => {
  expect(codexAccountId("codex-chatgpt:account_123")).toBe("account_123");
  for (const bad of ["codex-chatgpt:", "codex-chatgpt:../file", "sk-secret", "codex-chatgpt:a\nb"]) expect(codexAccountId(bad)).toBeUndefined();
  const use = codexAppServer.useKey("openai", "codex-chatgpt:account_123");
  expect(use).toMatchObject({ kind: "subscription", env: { HOUSEHOLD_CODEX_ACCOUNT: "account_123" }, wire: [{ target: { host: "chatgpt.com", port: 443 }, header: "authorization", prefix: "Bearer " }] });
  if ("problem" in use) throw new Error(use.problem);
  expect(use.env).not.toHaveProperty("OPENAI_API_KEY");
  const claims = JSON.parse(Buffer.from(createPlaceholderJwt("account_123").split(".")[1]!, "base64url").toString());
  expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe("account_123");
  expect(JSON.stringify(codexAppServer.useKey("openai", "sk-secret"))).not.toContain("sk-secret");
});

test("API keys use an API-only placeholder and Terra is the economical default", () => {
  expect(codexAppServer.defaultModel).toBe("gpt-6.1-terra");
  expect(codexAppServer.useKey("openai", "sk-proj-real-test-key")).toEqual({ kind: "API key", env: { HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: PLACEHOLDER_API_KEY }, wire: [{ target: { host: "api.openai.com", port: 443 }, header: "authorization", prefix: "Bearer " }] });
  expect(JSON.stringify(codexAppServer.useKey("openai", "sk-proj-real-test-key"))).not.toContain("real-test-key");
});

test("native permission modes keep approval policy, sandbox and reviewer independent; manual remains an alias", () => {
  expect(CODEX_MODES.options.map(option => option.id)).toEqual(["auto", "autoReview", "readOnly", "bypassPermissions"]);
  expect(CODEX_MODES.default).toBe("auto");
  expect(CODEX_MODES.aliases).toEqual({ manual: "auto" });
  expect(codexPermissions("auto")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" });
  expect(codexPermissions("manual")).toEqual(codexPermissions("auto"));
  expect(codexPermissions("autoReview")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" });
  expect(codexPermissions("readOnly")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only", approvalsReviewer: "user" });
  expect(codexPermissions("bypassPermissions")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" });
  expect(() => codexPermissions("unknown")).toThrow("Unsupported Codex permission mode");
  const agents = new Map([[codexAppServer.name, codexAppServer]]);
  const keys = [{ name: "openai", provider: "openai" as const, value: "sk-household-test-key" }];
  expect(agentOf(agents, { name: "probe", agent: codexAppServer.name, key: "openai", mode: "manual" }, keys)).toMatchObject({ mode: "auto" });
  expect(agentOf(agents, { name: "probe", agent: codexAppServer.name, key: "openai" }, keys)).toMatchObject({ mode: "auto" });
});

test("automatic reviews correlate exact native target item and never produce standalone chat notices or copy private inputs", () => {
  const params = { threadId: "thread1", turnId: "turn1", reviewId: "review1", targetItemId: "command1",
    action: { type: "command", command: "curl -H Authorization:private-secret /private/path" },
    review: { status: "inProgress", rationale: "private-secret /private/path" } };
  expect(translatePacket({ method: "item/autoApprovalReview/started", params })).toEqual([
    { kind: "tool-review", review: "review1", call: "command1", turn: "turn1", status: "inProgress", scope: "command" },
  ]);
  for (const status of ["approved", "denied", "timedOut", "aborted"] as const) {
    const events = translatePacket({ method: "item/autoApprovalReview/completed", params: { ...params, review: { ...params.review, status } } });
    expect(events).toEqual([{ kind: "tool-review", review: "review1", call: "command1", turn: "turn1", status, scope: "command" }]);
    expect(JSON.stringify(events)).not.toContain("private-secret");
    expect(JSON.stringify(events)).not.toContain("/private/path");
    expect(JSON.stringify(events)).not.toContain("curl");
  }
  const noTarget = translatePacket({ method: "item/autoApprovalReview/completed", params: { ...params, targetItemId: null, itemId: "unrelated", review: { status: "approved" } } });
  expect(noTarget[0]).not.toHaveProperty("call");
  expect(translatePacket({ method: "item/autoApprovalReview/completed", params: { ...params, review: { status: "unexpected" } } })).toEqual([]);
});

const approval = { id: 30, method: "item/commandExecution/requestApproval", params: { itemId: "call1", command: "git status", reason: "Check files" } };
test("permissions grant one call; missing, stopped and timeout answers never grant session-wide access", () => {
  expect(askOf(approval)).toEqual({ kind: "permission", tool: "command", detail: "git status", about: "Check files", input: "call1" });
  expect(answerFor(approval, { kind: "allow" })).toEqual({ decision: "accept" });
  expect(answerFor(approval, { kind: "unanswered", waitedMs: 10 })).toEqual({ decision: "decline" });
  expect(answerFor(approval, { kind: "stopped" })).toEqual({ decision: "cancel" });
});

test("modern sandbox permissions display their scope and grant only the requested profile for the current turn", () => {
  const permissions = { network: { enabled: true }, fileSystem: { read: ["/data"], write: null } };
  const packet = { id: 32, method: "item/permissions/requestApproval", params: { itemId: "perm1", permissions, reason: "Read reference files" } };
  expect(askOf(packet)).toEqual({ kind: "permission", tool: "additional permissions", detail: "For this turn: network access; read /data", about: "Read reference files", input: "perm1" });
  expect(answerFor(packet, { kind: "allow" })).toEqual({ permissions, scope: "turn" });
  expect(answerFor(packet, { kind: "deny" })).toEqual({ permissions: {}, scope: "turn" });
  expect(answerFor(packet, { kind: "stopped" })).toEqual({ permissions: {}, scope: "turn" });
});

test("question answers map by protocol id; secret and oversized questions never go to Telegram", () => {
  const packet = { id: 31, method: "item/tool/requestUserInput", params: { itemId: "q1", questions: [{ id: "colour", question: "Which colour?", options: [{ label: "Blue", description: "Ocean" }, { label: "Red" }] }] } };
  expect(askOf(packet)).toMatchObject({ kind: "questions", questions: [{ text: "Which colour?", multiSelect: false }] });
  expect(answerFor(packet, { kind: "answers", answers: [{ chosen: ["Blue"] }] })).toEqual({ answers: { colour: { answers: ["Blue"] } } });
  expect(askOf({ ...packet, method: "tool/requestUserInput" })).toEqual(askOf(packet));
  expect(answerFor({ ...packet, method: "tool/requestUserInput" }, { kind: "answers", answers: [{ chosen: ["Blue"] }] })).toEqual({ answers: { colour: { answers: ["Blue"] } } });
  packet.params.questions[0]!.question = "x".repeat(1001);
  expect(askOf(packet)).toBeUndefined();
});

test("Codex progress preserves call identity, ignores assistant chatter, and closes interrupted turns", () => {
  const item = { type: "commandExecution", id: "cmd1", command: "cat file.txt", commandActions: [{ type: "read", path: "file.txt" }] };
  expect(translatePacket({ method: "item/started", params: { turnId: "t1", item } })).toEqual([{ kind: "tool-started", tool: "command", summary: "cat file.txt", action: { kind: "read", target: "file.txt" }, turn: "t1", call: "cmd1", input: "cmd1" }]);
  expect(translatePacket({ method: "item/agentMessage/delta", params: { delta: "commentary" } })).toEqual([]);
  expect(translatePacket({ method: "turn/completed", params: { turn: { id: "t1", status: "interrupted" } } })).toEqual([{ kind: "dialog-closed" }, { kind: "turn-finished", turn: "t1", text: "" }]);
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
test("bridge runs protocol in child, preserves dialogs, sends safely, interrupts and resumes persisted thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake.mjs");
  await writeFile(fake, `import {createInterface} from 'node:readline';
if(process.env.OPENAI_API_KEY || process.env.HOUSEHOLD_CODEX_TOKEN) process.exit(2);
const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);const reply=result=>out({id:p.id,result});
if(p.method==='initialize')reply({});
if(p.method==='account/login/start')reply({type:'chatgptAuthTokens'});
if(p.method==='account/read')reply({account:{type:'chatgpt'}});
if(['thread/start','thread/resume'].includes(p.method))reply({model:'gpt-6.1-sol',thread:{id:'thread1',modelProvider:'openai'}});
if(p.method==='turn/start'){reply({turn:{id:'turn1',status:'inProgress'}});out({method:'turn/started',params:{threadId:'thread1',turn:{id:'turn1'}}});out({method:'item/started',params:{threadId:'thread1',turnId:'turn1',item:{id:'u1',type:'userMessage',content:p.params.input}}});out({id:100,method:'item/commandExecution/requestApproval',params:{threadId:'thread1',turnId:'turn1',itemId:'cmd1',command:'echo hi'}});}
if(p.method==='turn/interrupt'){reply({});out({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'interrupted'}}});}
if(p.method==='thread/backgroundTerminals/list')reply({data:[],nextCursor:null});
});`);
  const posted: any[] = [];
  const env = { ...process.env, HOUSEHOLD_MODEL: "gpt-6.1-sol", HOUSEHOLD_CODEX_ACCOUNT: "account_123", HOUSEHOLD_CODEX_TOKEN: createPlaceholderJwt("account_123"), HOUSEHOLD_MCP_URL: "http://unused/mcp", OPENAI_API_KEY: "must-not-reach-child" };
  const bridge = await runBridge({ command: [process.execPath, fake], socket: join(root, "control.sock"), home: root, env, post: async (packet, signal) => {
    posted.push(packet);
    if (packet.id === 100) return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    return {};
  } });
  cleanups.push(() => bridge.stop());
  const call = async (route: string, body?: unknown) => (await fetch(`http://local/${route}`, { unix: bridge.socket, method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) })).json() as Promise<any>;
  expect(bridge.ready).toBe(true);
  expect(await call("send", { text: "Hello" })).toEqual({ sent: true });
  for (let i = 0; i < 50 && !(await call("status")).dialog; i++) await Bun.sleep(5);
  expect((await call("status")).dialog).toBe(true);
  expect(await call("send", { text: "Blocked" })).toEqual({ sent: false });
  expect(await call("interrupt")).toEqual({ status: "stopped" });
  expect((await call("status")).dialog).toBe(false);
  expect(await call("interrupt")).toEqual({ status: "idle" });
  expect(posted.some(p => p.method === "item/started")).toBe(true);
  expect((await Bun.file(join(root, ".household-codex-thread")).text()).trim()).toBe("thread1");
  await bridge.stop(); cleanups.pop();
  const resumedPackets: any[] = [];
  const resumed = await runBridge({ command: [process.execPath, fake], socket: join(root, "control.sock"), home: root, env, post: async p => { resumedPackets.push(p); return {}; } });
  cleanups.push(() => resumed.stop());
  expect(resumed.ready).toBe(true);
  expect(resumedPackets).toContainEqual({ method: "household/sessionStarted", params: { model: "gpt-6.1-sol", continues: true } });
});

test("API bridge selects API login and leaves unconfigured effort to the native harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-api-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake-api.mjs"), observed = join(root, "observed.json");
  await writeFile(fake, `import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';
const seen={args:process.argv,envKey:process.env.OPENAI_API_KEY};
const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);const reply=result=>out({id:p.id,result});
if(p.method==='initialize')reply({});
if(p.method==='account/login/start'){seen.login=p.params;reply({type:'apiKey'});}
if(p.method==='account/read')reply({account:{type:'apiKey'}});
if(p.method==='thread/start'){seen.thread=p.params;reply({model:p.params.model,thread:{id:'api-thread',modelProvider:'openai'}});}
if(p.method==='turn/start'){seen.turn=p.params;writeFileSync(${JSON.stringify(observed)},JSON.stringify(seen));reply({turn:{id:'api-turn',status:'completed'}});}
});`);
  const bridge = await runBridge({ command: [process.execPath, fake], socket: join(root, "sock"), home: root,
    env: { ...process.env, HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: PLACEHOLDER_API_KEY, HOUSEHOLD_PET_TOKEN: "x".repeat(43), HOUSEHOLD_MCP_URL: "http://unused/mcp", OPENAI_API_KEY: "do-not-pass" }, post: async () => ({}) });
  cleanups.push(() => bridge.stop());
  expect(bridge.ready).toBe(true);
  const sent = await fetch("http://local/send", { unix: bridge.socket, method: "POST", body: JSON.stringify({ text: "Hi" }), headers: { "content-type": "application/json" } });
  expect(await sent.json()).toEqual({ sent: true });
  const seen = await Bun.file(observed).json();
  expect(seen.login).toEqual({ type: "apiKey", apiKey: PLACEHOLDER_API_KEY });
  expect(seen.thread.model).toBe("gpt-6.1-terra");
  expect(seen.turn).toMatchObject({ model: "gpt-6.1-terra" });
  expect(seen.turn).not.toHaveProperty("effort");
  expect(seen.thread).not.toHaveProperty("config");
  expect(seen.args.some((arg: string) => arg.startsWith("model_reasoning_effort="))).toBe(false);
  expect(seen.args).toContain('forced_login_method="api"');
  expect(seen.args).toContain('mcp_servers.household.default_tools_approval_mode="approve"');
  expect(seen.args).toContain("mcp_servers.household.tool_timeout_sec=330");
  for (const flag of ["features.memories=false", "memories.generate_memories=false", "memories.use_memories=false"]) expect(seen.args).toContain(flag);
  expect(seen.args).toContain(`mcp_servers.household.http_headers={"x-household-token"="${"x".repeat(43)}"}`);
  expect(seen.envKey).toBeUndefined();
});

test("failed startup and a broken child pipe stop the bridge instead of leaving an adoptable wedged pet", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-failed-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "broken.mjs");
  await writeFile(fake, `process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');process.stdin.destroy();setTimeout(()=>process.exit(1),10);});`);
  const bridge = await runBridge({ command: [process.execPath, fake], socket: join(root, "sock"), home: root,
    env: { ...process.env, HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: PLACEHOLDER_API_KEY, HOUSEHOLD_MCP_URL: "http://unused/mcp" }, post: async () => ({}) });
  cleanups.push(() => bridge.stop());
  expect(bridge.ready).toBe(false);
  await expect(fetch("http://local/status", { unix: bridge.socket })).rejects.toThrow();
  await bridge.closed;
});

test("Stop kills only the active turn's real process before acknowledging; late old events cannot finish a newer turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-stop-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "terminals.mjs"), marker = join(root, "late-marker"), terminated = join(root, "terminated.json");
  await writeFile(fake, `import{createInterface}from'node:readline';import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');let count=0,job,running=false;const killed=[];
process.on('SIGTERM',()=>{job?.kill('SIGKILL');process.exit(0)});
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);const reply=result=>out({id:p.id,result});
if(p.method==='initialize')reply({});if(p.method==='account/login/start')reply({type:'apiKey'});if(p.method==='account/read')reply({account:{type:'apiKey'}});
if(p.method==='thread/start')reply({model:p.params.model,thread:{id:'thread1',modelProvider:'openai'}});
if(p.method==='turn/start'){const id=++count===1?'turn1':'turn2';out({method:'turn/started',params:{threadId:'thread1',turn:{id}}});reply({turn:{id,status:'inProgress'}});
 if(id==='turn1'){job=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'LATE'),1200)`)}],{stdio:'ignore'});running=true;job.on('exit',()=>{running=false});out({method:'item/started',params:{threadId:'thread1',turnId:id,item:{type:'commandExecution',id:'current-command',processId:'current-process',command:'sleep then write'}}});}
 else setTimeout(()=>{out({method:'item/completed',params:{threadId:'thread1',turnId:'turn1',item:{type:'agentMessage',id:'stale',text:'OLD TEXT'}}});out({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'completed'}}});out({method:'item/completed',params:{threadId:'thread1',turnId:'turn1',item:{type:'commandExecution',id:'current-command',processId:'current-process',status:'completed'}}});},50);
}
if(p.method==='turn/interrupt'){reply({});out({method:'turn/completed',params:{threadId:'thread1',turn:{id:p.params.turnId,status:'interrupted'}}});}
if(p.method==='thread/backgroundTerminals/list')reply({data:[{itemId:'unrelated-command',processId:'unrelated-process'},...(running?[{itemId:'current-command',processId:'current-process'}]:[])],nextCursor:null});
if(p.method==='thread/backgroundTerminals/terminate'){killed.push(p.params.processId);writeFileSync(${JSON.stringify(terminated)},JSON.stringify(killed));if(p.params.processId==='current-process'&&running){job.once('exit',()=>reply({terminated:true}));job.kill('SIGTERM');}else reply({terminated:false});}
});`);
  const posted: any[] = [];
  const bridge = await runBridge({ command: [process.execPath, fake], socket: join(root, "sock"), home: root,
    env: { ...process.env, HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: PLACEHOLDER_API_KEY, HOUSEHOLD_MCP_URL: "http://unused/mcp" }, post: async p => { posted.push(p); return {}; } });
  cleanups.push(() => bridge.stop());
  const call = async (route: string, body?: object) => (await fetch(`http://local/${route}`, { unix: bridge.socket, method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) })).json() as Promise<any>;
  expect(await call("send", { text: "start process" })).toEqual({ sent: true });
  for (let i = 0; i < 100 && !posted.some(p => p.params?.item?.id === "current-command"); i++) await Bun.sleep(5);
  expect(await call("interrupt")).toEqual({ status: "stopped" });
  expect(await Bun.file(terminated).json()).toEqual(["current-process"]);
  expect(await call("send", { text: "new turn" })).toEqual({ sent: true });
  await Bun.sleep(150);
  expect((await call("status")).busy).toBe(true);
  expect(posted.filter(p => p.method === "turn/completed")).toHaveLength(1);
  expect(posted.some(p => p.params?.item?.text === "OLD TEXT")).toBe(false);
  await Bun.sleep(1200);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("bridge passes each native mode to start/resume and forwards native automatic review lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-modes-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "modes.mjs");
  await writeFile(fake, `import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';
const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);const reply=result=>out({id:p.id,result});
if(p.method==='initialize')reply({});if(p.method==='account/login/start')reply({type:'apiKey'});if(p.method==='account/read')reply({account:{type:'apiKey'}});
if(['thread/start','thread/resume'].includes(p.method)){writeFileSync(process.env.HOME+'/mode.json',JSON.stringify({method:p.method,args:process.argv,config:p.params}));reply({model:p.params.model,thread:{id:'thread1',modelProvider:'openai'}});}
if(p.method==='turn/start'){out({method:'turn/started',params:{threadId:'thread1',turn:{id:'turn1'}}});reply({turn:{id:'turn1',status:'inProgress'}});const base={threadId:'thread1',turnId:'turn1',reviewId:'r1',startedAtMs:1000,action:{type:'command'},review:{status:'inProgress'}};out({method:'item/autoApprovalReview/started',params:base});out({method:'item/autoApprovalReview/completed',params:{...base,completedAtMs:1200,review:{status:'approved',riskLevel:'low'}}});out({method:'turn/completed',params:{threadId:'thread1',turn:{id:'turn1',status:'completed'}}});}
});`);
  for (const mode of ["auto", "manual", "autoReview", "readOnly", "bypassPermissions"]) {
    const home = join(root, mode), posted: any[] = [];
    const options = { command: [process.execPath, fake], socket: join(root, `${mode}.sock`), home,
      env: { ...process.env, HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: PLACEHOLDER_API_KEY, HOUSEHOLD_MCP_URL: "http://unused/mcp", HOUSEHOLD_PERMISSION_MODE: mode, HOUSEHOLD_INSTRUCTIONS: "Household instructions" }, post: async (p: any) => { posted.push(p); return {}; } };
    let bridge = await runBridge(options); cleanups.push(() => bridge.stop());
    expect(bridge.ready).toBe(true);
    const observed = await Bun.file(join(home, "mode.json")).json(), expected = codexPermissions(mode);
    expect(observed.config).toMatchObject({ ...expected, developerInstructions: "Household instructions" });
    expect(observed.args).toContain(`approvals_reviewer=${JSON.stringify(expected.approvalsReviewer)}`);
    expect(observed.args).toContain(`sandbox_mode=${JSON.stringify(expected.sandbox)}`);
    expect(observed.args).toContain(`approval_policy=${JSON.stringify(expected.approvalPolicy)}`);
    if (mode === "autoReview") {
      await fetch("http://local/send", { unix: bridge.socket, method: "POST", body: JSON.stringify({ text: "Test review" }) });
      for (let i = 0; i < 100 && !posted.some(p => p.method === "item/autoApprovalReview/completed"); i++) await Bun.sleep(5);
      expect(posted.some(p => p.method === "item/autoApprovalReview/started")).toBe(true);
      expect(posted.some(p => p.method === "item/autoApprovalReview/completed")).toBe(true);
    }
    await bridge.stop(); cleanups.pop();
    bridge = await runBridge(options); cleanups.push(() => bridge.stop());
    expect(bridge.ready).toBe(true);
    expect(await Bun.file(join(home, "mode.json")).json()).toMatchObject({ method: "thread/resume", config: expected });
    await bridge.stop(); cleanups.pop();
  }
});

test("explicit reasoning reaches native process, new/resumed threads and every turn; live catalog rejects unsupported levels", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-effort-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "effort.mjs");
  await writeFile(fake, `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);const reply=result=>out({id:p.id,result});
appendFileSync(process.env.HOME+'/requests.jsonl',JSON.stringify({...p,args:process.argv})+'\\n');
if(p.method==='initialize')reply({});if(p.method==='account/login/start')reply({});if(p.method==='account/read')reply({account:{type:'apiKey'}});
if(p.method==='model/list')reply({data:[{model:'gpt-6.1-terra',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Fast'},{reasoningEffort:'high',description:'Deep'}],defaultReasoningEffort:'low'}],nextCursor:null});
if(['thread/start','thread/resume'].includes(p.method))reply({model:p.params.model,thread:{id:'thread1',modelProvider:'openai'}});
if(p.method==='turn/start')reply({turn:{id:'turn1',status:'completed'}});
});`);
  const home = join(root, "home");
  const options = { command: [process.execPath, fake], socket: join(root, "sock"), home,
    env: { ...process.env, HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: PLACEHOLDER_API_KEY, HOUSEHOLD_MCP_URL: "http://unused/mcp", HOUSEHOLD_REASONING_EFFORT: "high" }, post: async () => ({}) };
  for (const method of ["thread/start", "thread/resume"]) {
    const bridge = await runBridge(options); cleanups.push(() => bridge.stop());
    expect(bridge.ready).toBe(true);
    expect(await (await fetch("http://local/send", { unix: bridge.socket, method: "POST", body: JSON.stringify({ text: "Hello" }) })).json()).toEqual({ sent: true });
    const requests = (await Bun.file(join(home, "requests.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.findLast(p => p.method === method).params.config).toEqual({ model_reasoning_effort: "high" });
    expect(requests.findLast(p => p.method === "turn/start").params.effort).toBe("high");
    expect(requests.at(-1).args).toContain('model_reasoning_effort="high"');
    await bridge.stop(); cleanups.pop();
  }
  const unsupported = await runBridge({ ...options, env: { ...options.env, HOUSEHOLD_REASONING_EFFORT: "max" } });
  cleanups.push(() => unsupported.stop());
  expect(unsupported.ready).toBe(false);
  const requests = (await Bun.file(join(home, "requests.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(requests.filter(p => ["thread/start", "thread/resume"].includes(p.method))).toHaveLength(2);
  const context = { caCertPath: "/ca", eventsUrl: "http://unused/events", mcpUrl: "http://unused/mcp", instructions: "", model: "gpt-6.1-terra" };
  expect(codexAppServer.env(context)).not.toHaveProperty("HOUSEHOLD_REASONING_EFFORT");
  expect(codexAppServer.env({ ...context, reasoningEffort: "high" }).HOUSEHOLD_REASONING_EFFORT).toBe("high");
});


test("scheduled readiness requires explicit idle Codex status", async () => {
  for (const [state, idle] of [
    [{ ready: true, busy: false, dialog: false }, true],
    [{ ready: true, busy: true, dialog: false }, false],
    [{ ready: true, busy: false, dialog: true }, false],
    [{ ready: false, busy: false, dialog: false }, false],
    [{ ready: true }, false],
  ] as const) {
    expect(await codexAppServer.isIdle!(async () => ({ ok: true, output: JSON.stringify(state) }))).toBe(idle);
  }
});

test("bridge disconnect explicitly fails the whole session", () => {
  expect(translatePacket({ method: "household/failed", params: {} })).toContainEqual({ kind: "turn-failed", scope: "session", error: "Codex bridge disconnected" });
});


test("both native compaction notifications reset Household memory context without losing the turn",()=>{
  for(const packet of [{method:"thread/compacted",params:{}},{method:"item/completed",params:{item:{type:"contextCompaction"}}}])
    expect(translatePacket(packet)).toEqual([{kind:"session-started",continues:true}]);
});

test("Codex declares its resume pointer for explicit VM restart", () => {
  expect(codexAppServer.sessionFile).toBe(".household-codex-thread");
});

for (const missing of [true, false]) test(`resume ${missing ? "recovers an unpersisted empty thread" : "does not replace a thread on unrelated errors"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-resume-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake.mjs");
  await writeFile(join(root, ".household-codex-thread"), "old-thread\n");
  await writeFile(fake, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);const reply=result=>out({id:p.id,result});
if(p.id)appendFileSync(process.env.HOME+'/calls',p.method+'\\n');
if(p.method==='initialize')reply({});
if(p.method==='account/login/start')reply({});
if(p.method==='account/read')reply({account:{type:'apiKey'}});
if(p.method==='thread/resume')out({id:p.id,error:{code:-32600,message:${JSON.stringify(missing ? "no rollout found for thread id old-thread" : "Could not load rollout: access denied")}}});
if(p.method==='thread/start')reply({model:p.params.model,thread:{id:'new-thread',modelProvider:'openai'}});
});`);
  const packets: any[] = [];
  const bridge = await runBridge({ command: [process.execPath, fake], socket: join(root, "control.sock"), home: root,
    env: { PATH: process.env.PATH, HOUSEHOLD_MODEL: "gpt-6.1-sol", HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: "placeholder", HOUSEHOLD_MCP_URL: "http://unused/mcp" },
    post: async packet => { packets.push(packet); return {}; },
  });
  cleanups.push(() => bridge.stop());
  expect(bridge.ready).toBe(missing);
  const calls = await Bun.file(join(root, "calls")).text();
  expect(calls.includes("thread/resume")).toBe(true);
  expect(calls.includes("thread/start")).toBe(missing);
  expect((await Bun.file(join(root, ".household-codex-thread")).text()).trim()).toBe(missing ? "new-thread" : "old-thread");
  expect(packets.some(p => p.method === "household/sessionStarted" && p.params.continues === false)).toBe(missing);
});

test("a failed startup names its step, keeps native details private and leaves its reason for the status check", async () => {
  const root = await mkdtemp(join(tmpdir(), "household-codex-failure-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "fake.mjs");
  await writeFile(join(root, ".household-codex-thread"), "old-thread\n");
  await writeFile(fake, `import {createInterface} from 'node:readline';
const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);const reply=result=>out({id:p.id,result});
if(p.method==='initialize')reply({});
if(p.method==='account/login/start')reply({});
if(p.method==='account/read')reply({account:{type:'apiKey'}});
if(p.method==='thread/resume')out({id:p.id,error:{code:-32603,message:'thread locked by account user@example.com'}});
});`);
  const bridge = await runBridge({ command: [process.execPath, fake], socket: join(root, "control.sock"), home: root,
    env: { PATH: process.env.PATH, HOUSEHOLD_MODEL: "gpt-6.1-sol", HOUSEHOLD_CODEX_AUTH: "apiKey", HOUSEHOLD_CODEX_TOKEN: "placeholder", HOUSEHOLD_MCP_URL: "http://unused/mcp" },
    post: async () => ({}),
  });
  cleanups.push(() => bridge.stop());
  const reason = "Codex startup failed while resuming the saved conversation: Codex rejected the request (code -32603)";
  expect(bridge.ready).toBe(false);
  expect(bridge.failure).toBe(reason);
  // The socket is gone with the bridge; the reason stays where the control script looks.
  await expect(fetch("http://local/status", { unix: bridge.socket })).rejects.toThrow();
  expect(await Bun.file(failureFileFor(bridge.socket)).json()).toEqual({ failure: reason });
});

test("a failed Codex bridge answers status with its reason instead of nothing", async () => {
  const status = { ready: false, failure: "Codex startup failed while signing in: Codex request timed out" };
  const exec = async () => ({ ok: true, output: JSON.stringify(status) });
  expect(await codexAppServer.isReady(exec)).toEqual({ ready: false, output: status.failure });
  expect(await codexAppServer.dialogVisible(exec)).toBe(true);
});
