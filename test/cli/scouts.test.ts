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
  expect(said.at(-1)).toBe("house 'work': scouts on, preview off, sideworkers on");
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
