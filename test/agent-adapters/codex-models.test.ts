import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAppServer } from "../../src/agent-adapters/codex-app-server";
import { createPlaceholderJwt } from "../../src/agent-adapters/codex-app-server/auth";
import { runBridge } from "../../src/agent-adapters/codex-app-server/entrypoint";
import { acceptsCodexModel, codexModelOptions } from "../../src/agent-adapters/codex-app-server/models";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

test("native model records use executable model slug, omit hidden/internal entries and expose only public bounded fields", () => {
  const result = codexModelOptions([
    { id: "record-only", model: "gpt-6-astra", displayName: "Astra", description: "Large model", hidden: false, secretMetadata: "do-not-expose" },
    { id: "hidden", model: "gpt-6.1-sol", displayName: "Internal", hidden: true },
    { model: "https://bad.test", displayName: "Not a model", hidden: false },
    { model: "gpt-6-luna", displayName: "Luna\u0000", hidden: false },
  ]);
  expect(result).toEqual([{ id: "gpt-6-astra", label: "Astra", description: "Large model" }, { id: "gpt-6-luna", label: "Luna" }]);
  expect(acceptsCodexModel("gpt-6-astra")).toBe(true);
  expect(acceptsCodexModel("gpt-6-luna")).toBe(true);
  expect(acceptsCodexModel("codex-auto-review")).toBe(false);
});

async function bridge(cycle = false) {
  const root = await mkdtemp(join(tmpdir(), "household-models-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, "models.mjs"), observed = join(root, "requests.json");
  await writeFile(fake, `import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';const seen=[];const out=p=>process.stdout.write(JSON.stringify(p)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line),reply=result=>out({id:p.id,result});seen.push(p.method);
if(p.method==='initialize')reply({});if(p.method==='account/login/start')reply({type:'chatgptAuthTokens'});if(p.method==='account/read')reply({account:{type:'chatgpt'}});
if(p.method==='thread/start')reply({model:p.params.model,thread:{id:'thread1',modelProvider:'openai'}});
if(p.method==='model/list'){writeFileSync(${JSON.stringify(observed)},JSON.stringify({methods:seen,params:p.params}));
reply(!p.params.cursor?{data:[{id:'catalog-only-id',model:'gpt-6-astra',displayName:'Astra',description:'Public description',hidden:false},{model:'codex-auto-review',hidden:true}],nextCursor:'page2'}:{data:[{id:'luna-record',model:'gpt-6-luna',displayName:'Luna',description:'Fast',hidden:false}],nextCursor:${cycle ? "'page2'" : "null"}});}
});`);
  const running = await runBridge({ command: [process.execPath, fake], socket: join(root, "sock"), home: root,
    env: { ...process.env, HOUSEHOLD_CODEX_ACCOUNT: "account-one", HOUSEHOLD_CODEX_TOKEN: createPlaceholderJwt("account-one"), HOUSEHOLD_MCP_URL: "http://unused/mcp" }, post: async () => ({}) });
  cleanups.push(() => running.stop());
  return { running, observed, call: () => fetch("http://local/models", { unix: running.socket, method: "POST" }) };
}

test("bridge paginates account-native models without inference and adapter refuses a different subscription identity", async () => {
  const env = await bridge();
  expect(env.running.ready).toBe(true);
  const response = await env.call();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ models: [{ id: "gpt-6-astra", label: "Astra", description: "Public description" }, { id: "gpt-6-luna", label: "Luna", description: "Fast" }], authType: "chatgpt", accountId: "account-one" });
  const seen = JSON.parse(await readFile(env.observed, "utf8"));
  expect(seen.params).toEqual({ includeHidden: false, limit: 100, cursor: "page2" });
  expect(seen.methods).not.toContain("turn/start");
  const commands: string[][] = [];
  const exec = async (command: string[], stdin?: string) => { commands.push(command); expect(stdin).toBeUndefined(); const response = await env.call(); return { ok: response.ok, output: await response.text() }; };
  expect((await codexAppServer.listModels!(exec, { name: "one", provider: "openai", value: "codex-chatgpt:account-one" })).map(({ id }) => id)).toEqual(["gpt-6-astra", "gpt-6-luna"]);
  await expect(codexAppServer.listModels!(exec, { name: "two", provider: "openai", value: "codex-chatgpt:account-two" })).rejects.toThrow("unavailable for this account");
  await expect(codexAppServer.listModels!(exec, { name: "api", provider: "openai", value: "sk-actual-secret-not-forwarded" })).rejects.toThrow("unavailable for this account");
  expect(JSON.stringify(commands)).not.toContain("sk-actual-secret");
});

test("native model discovery rejects repeated pagination cursors rather than looping or exposing internal errors", async () => {
  const env = await bridge(true);
  const response = await env.call();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Codex model discovery is unavailable" });
});

test("native reasoning metadata preserves model-specific levels and defaults without inventing unknown capabilities", () => {
  const [model] = codexModelOptions([{ model: "gpt-6.1-terra", hidden: false, supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "high", description: "Deep\u0000reasoning", internal: "secret" },
    { reasoningEffort: "bad value", description: "Invalid" },
  ], defaultReasoningEffort: "high" }]);
  expect(model).toMatchObject({ supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "high", description: "Deep reasoning" }], defaultReasoningEffort: "high" });
  expect(JSON.stringify(model)).not.toContain("secret");
  expect(codexAppServer.modelOptions!("gpt-6-luna").supportedReasoningEfforts!.map(option => option.reasoningEffort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(codexAppServer.acceptsReasoningEffort!("gpt-6-luna", "ultra")).toBe(false);
  expect(codexAppServer.modelOptions!("gpt-6.1-terra").supportedReasoningEfforts).toBeUndefined();
});
