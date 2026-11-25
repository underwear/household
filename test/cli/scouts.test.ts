import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiCall } from "../../src/app/daemon";
import { runScouts } from "../../src/cli/scouts";
import { serveControl } from "../../src/infra/control-socket";
import type { Paths } from "../../src/infra/paths";
import { tempDir } from "../helpers";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  process.exitCode = 0;
});

/** A daemon whose `/api` answers from `answers` (by "METHOD path", a function for a changing answer) and records every call. */
async function daemon(answers: Record<string, { status?: number; body: unknown } | (() => { status?: number; body: unknown })> = {}) {
  const dir = tempDir();
  const paths = { socket: join(dir, "household.sock"), eventLog: join(dir, "events.jsonl") } as Paths;
  const calls: ApiCall[] = [], sent: unknown[] = [];
  const control = await serveControl(paths.socket, {
    "/api": async (body) => {
      const call = body as ApiCall;
      calls.push(call);
      const found = answers[`${call.method} ${call.path}`];
      const answer = (typeof found === "function" ? found() : found) ?? { body: { ok: true } };
      return { status: answer.status ?? 200, body: answer.body };
    },
    "/send": async (body) => {
      sent.push(body);
      return { activity: "idle", queued: 1 };
    },
  });
  stops.push(control.stop);
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((text: string) => void said.push(text));
  const error = spyOn(console, "error").mockImplementation(() => {});
  stops.push(async () => { log.mockRestore(); error.mockRestore(); });
  return { paths, calls, said, sent, dir };
}

const capability = { name: "media", description: "yt-dlp", install: "pip install yt-dlp", network: { any: true, allow: [] }, keys: [{ secret: "s", via: "gateway" }], kind: "tool", usedBy: [], keyVariables: [], lastTest: null, testing: false, revisions: 1 };

test("features: one changes, the others and the preview settings stay", async () => {
  const { paths, calls, said } = await daemon({ "GET /api/houses/work": { body: { features: { scouts: false, preview: false, sideworkers: true }, preview: { bindAddress: "127.0.0.1", publicHost: "127.0.0.1" } } } });
  await runScouts(paths, "features", ["work", "scouts=on"], {});
  expect(calls.at(-1)).toEqual({ method: "PUT", path: "/api/houses/work/features", body: { features: { scouts: true, preview: false, sideworkers: true }, preview: { bindAddress: "127.0.0.1", publicHost: "127.0.0.1" } } });
  expect(said.at(-1)).toBe("workspace 'work': scouts on, preview off, sideworkers on");
  await expect(runScouts(paths, "features", ["work", "scouts=yes"], {})).rejects.toThrow("not a feature change: 'scouts=yes'");
});

test("capability set keeps what is not given, its keys and owner; install from a file; test fails the command", async () => {
  const { paths, calls, dir } = await daemon({
    "GET /api/houses/work/capabilities/media": { body: { capability: { ...capability, owner: "breaker" }, history: [], drafts: [] } },
    "POST /api/houses/work/capabilities/media/test": { body: { at: 0, ok: false, seconds: 12, output: "E: Unable to locate package" } },
  });
  const script = join(dir, "install.sh");
  writeFileSync(script, "apt-get install -y ffmpeg\n");
  await runScouts(paths, "capability", ["set", "work", "media"], { install: script, network: "github.com,*.githubusercontent.com" });
  expect(calls.at(-1)).toEqual({ method: "PUT", path: "/api/houses/work/capabilities/media", body: {
    name: "media", description: "yt-dlp", install: "apt-get install -y ffmpeg\n", network: { any: false, allow: ["github.com", "*.githubusercontent.com"] }, keys: [{ secret: "s", via: "gateway" }], owner: "breaker",
  } });
  await runScouts(paths, "capability", ["add", "work", "dev"], { network: "any", description: "tools" });
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/houses/work/capabilities", body: { name: "dev", description: "tools", network: { any: true, allow: [] } } });
  await runScouts(paths, "capability", ["test", "work", "media"], {});
  expect(process.exitCode).toBe(1);
});

test("capability keys, drafts and skills go to their routes", async () => {
  const { paths, calls } = await daemon({ "GET /api/houses/work/capabilities/media/skills/file?path=yt%2FSKILL.md": { status: 404, body: { error: "not found" } } });
  await runScouts(paths, "capability", ["key", "add", "work", "media", "yt_token"], { via: "vm", host: "youtube.com", env: "YT_TOKEN", value: "v1" });
  await runScouts(paths, "capability", ["key", "rm", "work", "media", "yt_token"], {});
  await runScouts(paths, "capability", ["draft", "apply", "work", "d1"], {});
  await runScouts(paths, "capability", ["draft", "discard", "work", "d2"], {});
  await runScouts(paths, "capability", ["restore", "work", "media", "r2"], {});
  expect(calls).toEqual([
    { method: "POST", path: "/api/houses/work/capabilities/media/keys", body: { secret: "yt_token", value: "v1", hosts: ["youtube.com"], via: "vm", env: "YT_TOKEN" } },
    { method: "DELETE", path: "/api/houses/work/capabilities/media/keys/yt_token" },
    { method: "POST", path: "/api/houses/work/capability-drafts/d1/apply" },
    { method: "DELETE", path: "/api/houses/work/capability-drafts/d2" },
    { method: "POST", path: "/api/houses/work/capabilities/media/restore", body: { rev: 2 } },
  ]);
  await expect(runScouts(paths, "capability", ["key", "add", "work", "media", "k"], { via: "browser", host: "x", env: "X", value: "v" })).rejects.toThrow("--via gateway|vm");
  await expect(runScouts(paths, "capability", ["frobnicate", "work", "media"], {})).rejects.toThrow("unknown command or missing arguments");
});

test("scout add and set: flags become the API's fields; \"\" removes; an agent merges with the scout's own", async () => {
  const { paths, calls } = await daemon({ "GET /api/houses/work/scouts/breaker": { body: { scout: { name: "breaker", description: "d", instructions: "", capabilities: [], agent: { agent: "claude-code-tmux", key: "claude", model: "opus" }, resources: { cpus: 2 } } } } });
  await runScouts(paths, "scout", ["add", "work", "media"], { description: "Downloads videos", capabilities: "media,dev", repo: "https://github.com/acme/ops", cpus: "1", memory: "1.5" });
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/houses/work/scouts", body: { name: "media", description: "Downloads videos", capabilities: ["media", "dev"], workspace: { repo: "https://github.com/acme/ops" }, resources: { cpus: 1, memoryMiB: 1536 } } });
  await runScouts(paths, "scout", ["set", "work", "breaker"], { title: "", model: "sonnet", cpus: "" });
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/houses/work/scouts/breaker", body: { title: null, agent: { agent: "claude-code-tmux", key: "claude", model: "sonnet" }, resources: null } });
  await expect(runScouts(paths, "scout", ["add", "work", "x"], {})).rejects.toThrow("needs --description");
});

test("routine bots: --routine sets them, \"\" clears them; show, ls, runs and status say who runs it without asking", async () => {
  const reader = { name: "reader", description: "Meter reading", instructions: "", capabilities: ["meter"], own: null, network: { open: false, allow: ["meter.example.com"], limitedBy: ["meter"] }, keysInVm: [], problems: [], routine: ["sibling"], routineBlocker: null };
  const routineRun = { id: "scout-3", scout: "reader", blueprint: "reader", number: 3, routine: true, capabilities: ["meter"], parent: "sibling", task: "Submit the reading", status: "done", outcome: "success", steps: 4, startedAt: "2026-11-25T10:00:00Z" };
  const { paths, calls, said } = await daemon({
    "GET /api/houses/work/scouts/reader": { body: { scout: reader, runs: [routineRun], defaults: { agent: null, limits: { cpus: 2, memoryMiB: 2048 } } } },
    "GET /api/houses/work/scouts/general": { body: { scout: { ...reader, name: "general", network: { open: true, allow: [], limitedBy: [] }, routine: undefined, routineBlocker: "Reaches the open internet" }, runs: [], defaults: { agent: null, limits: { cpus: 2, memoryMiB: 2048 } } } },
    "GET /api/houses/work/scouts": { body: { scouts: [reader], runs: [], limits: { cpus: 2, memoryMiB: 2048 }, agent: null } },
    "GET /api/houses/work/scout-runs": { body: [routineRun] },
    "GET /api/houses/work/scout-runs/scout-3": { body: { ...routineRun, createdAt: "2026-11-25T10:00:00Z", tools: {}, files: [], secretRequests: [], networkRequests: [] } },
  });
  await runScouts(paths, "scout", ["set", "work", "reader"], { routine: "sibling, helper" });
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/houses/work/scouts/reader", body: { routine: ["sibling", "helper"] } });
  await runScouts(paths, "scout", ["set", "work", "reader"], { routine: "" });
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/houses/work/scouts/reader", body: { routine: null } });
  await runScouts(paths, "scout", ["add", "work", "meter"], { description: "Meter", routine: "" });
  expect(calls.at(-1)!.body).toEqual({ name: "meter", description: "Meter" }); // none: nothing to send
  said.length = 0;
  await runScouts(paths, "scout", ["show", "work", "reader"], {});
  expect(said).toContain("routine      sibling run it without asking");
  expect(said.at(-1)).toBe("runs         scout-3 done/success (routine)");
  await runScouts(paths, "scout", ["show", "work", "general"], {});
  expect(said).toContain("routine      none: every run waits for your Run  (cannot be routine: Reaches the open internet)");
  await runScouts(paths, "scout", ["ls", "work"], {});
  expect(said.some((line) => line.includes("routine for: sibling"))).toBe(true);
  await runScouts(paths, "scout", ["runs", "work"], {});
  expect(said.at(-1)).toContain("for sibling (routine)");
  await runScouts(paths, "scout", ["status", "work", "scout-3"], {});
  expect(said.some((line) => line.includes("called by sibling, routine: no Run card, its messages without Pass"))).toBe(true);
});

test("scout drafts: listed, shown against the scout as it is (keys, staleness, before and after), applied only as the owner says, discarded", async () => {
  const draft = {
    id: "d1", scout: "meter", pet: "sibling", petTitle: "Sibling", at: Date.parse("2026-11-25T10:00:00Z"), reason: "Monthly errand on one site", change: true, wantsRoutine: true,
    stale: true, changedSince: ["capabilities"],
    definition: { name: "meter", title: "Meter reader", emoji: "📟", description: "Submits the reading", instructions: "Log in, submit.", capabilities: ["datadog"] },
    own: { install: "curl -d \"$METER_PASSWORD\" https://meter.example.com", network: { any: false, allow: ["meter.example.com"] } },
    currentOwn: { install: "apt-get install -y curl", network: { any: false, allow: ["meter.example.com"] } },
    current: { title: "Meter", description: "Submits the reading", instructions: "Log in.", capabilities: [], routine: ["sibling"] },
    keys: [{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup", via: "vm", keptWith: ["install"] }, { env: "DD_API_KEY", secret: "dd", source: "datadog", via: "gateway" }],
    ownChanges: ["install"],
    keyGate: { keys: [{ env: "METER_PASSWORD", secret: "meter-pass", source: "own setup" }], reasons: ["it would reach new hosts: api.datadoghq.eu", "its own install script changes"], choices: ["keep", "drop"] },
    needsKeys: ["METER_USER"], network: { open: false, allow: ["meter.example.com", "api.datadoghq.eu"] }, currentNetwork: { open: false, allow: ["meter.example.com"] }, routineBlocker: null, problems: [],
  };
  const { paths, calls, said } = await daemon({
    "GET /api/houses/work/scout-drafts": { body: [draft] },
    "GET /api/houses/work/scout-drafts/d1": { body: draft },
    "POST /api/houses/work/scout-drafts/d1/apply": () => {
      const sent = calls.at(-1)!.body as { routine?: string[]; keys?: string } | undefined;
      const keys = sent?.keys === "drop" ? { choice: "drop", kept: ["DD_API_KEY"], dropped: ["METER_PASSWORD"], sharedStay: ["DD_API_KEY (datadog, value in its VM)"] } : { choice: sent?.keys ?? null, kept: ["METER_PASSWORD", "DD_API_KEY"], dropped: [] };
      return { body: { scout: "meter", routine: sent?.routine ?? [], keys } };
    },
    "GET /api/houses/work/scouts": { body: { scouts: [], runs: [], limits: { cpus: 2, memoryMiB: 2048 }, agent: null, drafts: [{ id: "d1" }] } },
  });
  await runScouts(paths, "scout", ["drafts", "work"], {});
  expect(said.at(-1)).toBe("d1  meter (change)  by sibling  2026-11-25 10:00  network: only meter.example.com, api.datadoghq.eu  needs keys: METER_USER  asks for routine");
  said.length = 0;
  await runScouts(paths, "scout", ["draft", "show", "work", "d1"], {});
  expect(said).toContain("draft d1: a change to scout meter, by sibling, 2026-11-25 10:00");
  expect(said).toContain("why          Monthly errand on one site");
  expect(said).toContain("stale        changed since it was drafted: capabilities (applying it undoes that: apply --force)");
  expect(said).toContain("title        📟 Meter reader  (now Meter)");
  expect(said).toContain("description  Submits the reading"); // unchanged: once
  expect(said).toContain("capabilities - own setup\n             + datadog, own setup");
  expect(said).toContain("network      - only meter.example.com\n             + only meter.example.com, api.datadoghq.eu");
  expect(said).toContain("keys         METER_PASSWORD (own setup, value in its VM; kept, with a changed install)\n             DD_API_KEY (datadog, gateway placeholder)");
  expect(said).toContain("at stake     METER_PASSWORD: it would reach new hosts: api.datadoghq.eu; its own install script changes\n             apply needs --keep-keys or --drop-keys (drop takes its own setup's off)");
  expect(said).toContain("routine      asked: give it with apply --routine  (now routine for sibling; applying without --routine ends that)");
  expect(said).toContain("# instructions (changed)\n- Log in.\n+ Log in, submit.");
  expect(said).toContain("# own install script (changed)\n- apt-get install -y curl\n+ curl -d \"$METER_PASSWORD\" https://meter.example.com");
  await runScouts(paths, "scout", ["draft", "apply", "work", "d1"], {});
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/houses/work/scout-drafts/d1/apply" }); // no body: strict, no choices made
  expect(said.slice(-2)).toEqual(["draft d1 applied: scout 'meter' asks before every run", "keys         carries METER_PASSWORD, DD_API_KEY"]);
  said.length = 0;
  await runScouts(paths, "scout", ["draft", "apply", "work", "d1"], { routine: "sibling", "drop-keys": true, force: true });
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/houses/work/scout-drafts/d1/apply", body: { routine: ["sibling"], keys: "drop", force: true } });
  expect(said).toEqual([
    "applying over what changed since it was drafted: capabilities",
    "draft d1 applied: scout 'meter' runs without asking for sibling",
    "keys         carries DD_API_KEY; taken off its own setup: METER_PASSWORD (the workspace's secrets stay)",
    "             still carried, from shared capabilities: DD_API_KEY (datadog, value in its VM)",
  ]);
  await runScouts(paths, "scout", ["draft", "apply", "work", "d1"], { "keep-keys": true });
  expect(calls.at(-1)!.body).toEqual({ keys: "keep" });
  await expect(runScouts(paths, "scout", ["draft", "apply", "work", "d1"], { "keep-keys": true, "drop-keys": true })).rejects.toThrow("--keep-keys or --drop-keys, not both");
  await runScouts(paths, "scout", ["draft", "discard", "work", "d1"], {});
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/api/houses/work/scout-drafts/d1" });
  await runScouts(paths, "scout", ["ls", "work"], {});
  expect(said).toContain("\n1 draft(s) from bots wait for review: house scout drafts work");
  await expect(runScouts(paths, "scout", ["draft", "approve", "work", "d1"], {})).rejects.toThrow("usage:");
});

test("scout run --wait: the owner's run, followed until it says it is done; exit 1 unless it succeeded", async () => {
  let reads = 0;
  const { paths, calls, said } = await daemon({
    "POST /api/houses/work/scouts/breaker/runs": { body: { id: "scout-9", status: "waiting_approval" } },
    "GET /api/houses/work/scout-runs/scout-9": () => ({ body: reads++ === 0 ? { id: "scout-9", status: "running" } : { id: "scout-9", status: "running", outcome: "blocked", report: "Need a token" } }),
  });
  await runScouts(paths, "scout", ["run", "work", "breaker"], { task: "Find the 500s", pet: "sibling", wait: true });
  expect(calls[0]).toEqual({ method: "POST", path: "/api/houses/work/scouts/breaker/runs", body: { task: "Find the 500s", pet: "sibling" } });
  expect(said.at(-1)).toBe("its last message:\nNeed a token");
  expect(process.exitCode).toBe(1);
}, 10_000);

test("a run's logs, its screen, a message to it; an ended one is refused, its kept setup failure shown", async () => {
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  stops.push(async () => write.mockRestore());
  const { paths, calls, sent, said } = await daemon({
    "GET /api/houses/work/scout-runs/scout-1/logs?source=onStart&lines=20": { body: { source: "onStart", text: "line\n", cursor: "c", missing: false } },
    "GET /api/houses/work/scout-runs/scout-1": { body: { id: "scout-1", status: "running" } },
    "GET /api/houses/work/scout-runs/scout-2": { body: { id: "scout-2", status: "failed", setupFailure: "Setup failed: E: nope" } },
    "GET /api/houses/work/scout-runs/scout-2/logs?source=setup&lines=100": { status: 409, body: { error: "The run has ended (failed): its VM is gone" } },
  });
  await runScouts(paths, "scout", ["logs", "work", "scout-1"], { source: "on-start", lines: "20" });
  expect(write).toHaveBeenCalledWith("line\n");
  await runScouts(paths, "scout", ["send", "work", "scout-1", "try", "again"], {});
  expect(sent).toEqual([{ house: "work", pet: "scout-1", text: "try again" }]);
  await expect(runScouts(paths, "scout", ["send", "work", "scout-2", "hi"], {})).rejects.toThrow("has ended (failed)");
  await runScouts(paths, "scout", ["logs", "work", "scout-2"], {});
  expect(said.at(-1)).toBe("Setup failed: E: nope");
  await runScouts(paths, "scout", ["cancel", "work", "scout-1"], {});
  expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/api/houses/work/scout-runs/scout-1" });
});

test("--json prints what the daemon answered", async () => {
  const runs = [{ id: "scout-1", scout: "breaker", status: "done", task: "t", capabilities: [], parent: "p", steps: 0 }];
  const { paths, said } = await daemon({ "GET /api/houses/work/scout-runs": { body: runs } });
  await runScouts(paths, "scout", ["runs", "work"], { json: true });
  expect(JSON.parse(said.join("\n"))).toEqual(runs);
  expect(await runScouts(paths, "pet", ["ls"], {})).toBe(false); // not ours
});
