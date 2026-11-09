import { expect, test } from "bun:test";
import { Scouts } from "../../src/app/scouts";
import type { ScoutDeps, ScoutRun } from "../../src/app/scouts";
import { scoutDefinitionSchema } from "../../src/infra/config-schema";
const definition = { ...scoutDefinitionSchema.parse({ name: "expert", description: "Test" }), agent: "codex-app-server", key: "codex", resources: { cpus: 1, memoryMiB: 1024 } };
function fixture() {
  const values = new Map<string, string>();
  const sent: string[] = [], delivered: string[] = [];
  let decide: ((answer: "yes" | "no" | undefined) => void) | undefined;
  const run: ScoutRun = { capabilities: [], id: "scout-test", house: "work", scout: "expert", parent: "pet", task: "test", report: "owner", status: "done", createdAt: Date.now(), steps: 0, actions: [], secretRequests: [{ key: "token", status: "pending" }], files: [], definition };
  values.set("scouts.runs.v1", JSON.stringify([run]));
  const deps: ScoutDeps = {
    store: { get: key => values.get(key), set: (key, value) => { values.set(key, value); }, delete: key => { values.delete(key); } }, configured: async () => ({ daemon: {}, keys: [], secrets: [], houses: [] }),
    choose: async (_caller, _card, signal) => new Promise(resolve => { decide = resolve; signal.addEventListener("abort", () => resolve(undefined)); }),
    prepare: async () => undefined, launch: async () => {}, ready: async () => true, remove: async () => {}, closedNotice: () => async () => {}, notice: async () => {},
    send: (_h, _p, text) => { sent.push(text); }, secret: async (_r, _k, value) => { delivered.push(value); }, log: () => {},
  };
  const scouts = new Scouts(deps); scouts.run("work", "scout-test")!.status = "running";
  return { scouts, deps, sent, delivered, decide: (answer: "yes" | "no") => decide!(answer) };
}
const caller = { house: "work", pet: "pet" }, self = { house: "work", pet: "scout-test" };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test("duplicate secret approvals cannot race; later parent refusal defeats an old Allow", async () => {
  const f = fixture();
  await f.scouts.giveSecret(caller, self.pet, "token", "synthetic");
  await expect(f.scouts.giveSecret(caller, self.pet, "token", "other")).rejects.toThrow("already pending");
  f.scouts.refuseSecret(caller, self.pet, "token"); f.decide("yes"); await settle();
  expect(f.delivered).toEqual([]); expect(f.scouts.status(caller, self.pet).secret_requests[0]!.status).toBe("refused");
});
test("owner task secret needs Allow and is masked in saved report", async () => {
  const f = fixture();
  const giving = f.scouts.ownerSecret(self, "token", "synthetic-value");
  expect(f.delivered).toEqual([]); f.decide("yes"); expect(await giving).toEqual({ status: "given" });
  expect(f.delivered).toEqual(["synthetic-value"]);
  f.scouts.recordReply(self, "Result synthetic-value");
  expect(f.scouts.list("work")[0]!.reportText).toBe("Result [masked]");
});
test("cancel aborts pending secret decisions and cannot deliver a value afterwards", async () => {
  const f = fixture();
  const giving = f.scouts.ownerSecret(self, "token", "synthetic-value");
  await f.scouts.cancel(caller, self.pet);
  expect(await giving).toEqual({ status: "refused" }); expect(f.delivered).toEqual([]);
});

test("failed VM cleanup remains pending and the next tick retries it", async () => {
  const f = fixture(); let attempts=0;
  f.deps.remove=async()=>{if(++attempts===1)throw new Error("temporary cleanup failure");};
  await expect(f.scouts.cancel(caller,self.pet)).rejects.toThrow("temporary cleanup failure");
  expect(f.scouts.run("work",self.pet)!.cleanupPending).toBe(true);
  await f.scouts.tick(); expect(attempts).toBe(2); expect(f.scouts.run("work",self.pet)!.cleanupPending).toBe(false);
});
test("the lifecycle tick cancels a run when its house feature is disabled", async () => {
  const f=fixture(); await f.scouts.tick();
  expect(f.scouts.run("work",self.pet)!.status).toBe("cancelled");
  expect(f.sent).toContain("Household: scout scout-test cancelled.");
});

test("Claude Household tool activity never records secret arguments, regardless of argument order", async () => {
  const { actionOf } = await import("../../src/agent-adapters/claude-code-tmux/actions");
  const action = actionOf("mcp__household__scout_secret", { value: "synthetic-secret", id: "scout-test", key: "token" });
  expect(action.summary).toBe("scout_secret"); expect(JSON.stringify(action)).not.toContain("synthetic-secret");
});

test("parent_send retains a masked owner report even when moderation drops delivery to pet", async () => {
  const f = fixture();
  const giving = f.scouts.ownerSecret(self, "token", "synthetic-report-token");
  f.decide("yes"); await giving;
  await f.scouts.parentSend(self, "Report: synthetic-report-token");
  expect(f.scouts.list("work")[0]!.reportText).toBe("Report: [masked]");
  expect(JSON.stringify(f.scouts.status(caller, self.pet))).not.toContain("Report:");
  expect(f.sent.some(text => text.includes("Report:"))).toBe(false);
  f.decide("no"); await settle();
  expect(f.scouts.list("work")[0]!.reportText).toBe("Report: [masked]");
  expect(f.sent.some(text => text.includes("Report:"))).toBe(false);
});

test("finished runtime cleanup discards known raw secret values", async () => {
  const f=fixture();const giving=f.scouts.ownerSecret(self,"token","synthetic-value");f.decide("yes");await giving;
  expect(f.scouts.redact(self.house,self.pet,"synthetic-value")).toBe("[masked]");
  await f.scouts.cancel(caller,self.pet);
  expect(f.scouts.redact(self.house,self.pet,"synthetic-value")).toBe("synthetic-value");
});
test("capability test VMs are absent from pet observability and cannot be cancelled or read by pets", async () => {
  const f=fixture();f.scouts.run(self.house,self.pet)!.probe=true;
  expect(f.scouts.running(caller)).toEqual([]);expect(f.scouts.list(self.house)).toEqual([]);
  expect(()=>f.scouts.status(caller,self.pet)).toThrow("Unknown scout run");
  await expect(f.scouts.cancel(caller,self.pet)).rejects.toThrow("Unknown scout run");
  await expect(f.scouts.file(caller,self.pet,"credentials.json")).rejects.toThrow("Unknown scout run");
});

test("concurrent capability tests share the workspace resource budget", async () => {
  const f=fixture();f.scouts.run(self.house,self.pet)!.status="done";
  f.deps.configured=async()=>({daemon:{},keys:[],secrets:[],houses:[{name:"work",features:{scouts:true},resources:{cpus:4,memoryMiB:4096},scoutAgent:{agent:"codex-app-server",key:"codex"},scouts:[scoutDefinitionSchema.parse({ name: "expert", description: "Test" })],network:{kind:"allowlist",allow:[]},pets:[{name:"pet"}],people:{owners:[]},channels:[]}]});
  let prepares=0;f.deps.prepare=async()=>{prepares++;return {definition:definition.name,parent:"pet",homePath:"/tmp/test",instructions:"scout",network:{kind:"allowlist",allow:[]}};};
  const capability={name:"media",description:"",install:"echo",network:{any:true,allow:[]},keys:[]};
  const results=await Promise.allSettled([f.scouts.launchProbe("work",capability),f.scouts.launchProbe("work",capability)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  expect(prepares).toBe(1);
  await f.scouts.stop();
});
