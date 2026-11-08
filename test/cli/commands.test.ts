import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiCall } from "../../src/app/daemon";
import { runMore } from "../../src/cli/commands";
import { serveControl } from "../../src/infra/control-socket";
import type { Paths } from "../../src/infra/paths";
import { tempDir } from "../helpers";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A daemon whose `/api` answers from `answers` (by "METHOD path") and records every call. */
async function daemon(answers: Record<string, { status?: number; body: unknown }> = {}) {
  const dir = tempDir();
  const paths = { socket: join(dir, "household.sock"), eventLog: join(dir, "events.jsonl") } as Paths;
  const calls: ApiCall[] = [];
  const control = await serveControl(paths.socket, {
    "/api": async (body) => {
      const call = body as ApiCall;
      calls.push(call);
      const answer = answers[`${call.method} ${call.path}`] ?? { body: { ok: true } };
      return { status: answer.status ?? 200, body: answer.body };
    },
  });
  stops.push(control.stop);
  const said: string[] = [];
  const log = spyOn(console, "log").mockImplementation((text: string) => void said.push(text));
  stops.push(async () => log.mockRestore());
  return { paths, calls, said, dir };
}

test("pet restart, disable and enable go to the web API's routes: the agent saves its work first unless --now", async () => {
  const { paths, calls } = await daemon();
  expect(await runMore(paths, "pet", ["restart", "work", "sibling"], { now: true })).toBe(true);
  expect(await runMore(paths, "pet", ["disable", "work", "sibling"], {})).toBe(true);
  expect(await runMore(paths, "pet", ["enable", "work", "sibling"], {})).toBe(true);
  expect(calls).toEqual([
    { method: "POST", path: "/api/houses/work/pets/sibling/environment/restart", body: { mode: "now" } },
    { method: "POST", path: "/api/houses/work/pets/sibling/disable", body: { mode: "notify" } },
    { method: "PATCH", path: "/api/houses/work/pets/sibling", body: { enabled: true } },
  ]);
});

test("environment scripts and instructions from a file; an empty script removes it", async () => {
  const { paths, calls, dir } = await daemon({ "GET /api/houses/work/pets/sibling/instructions": { body: { content: "old", revision: "r1", path: "AGENTS.md" } } });
  const script = join(dir, "setup.sh");
  writeFileSync(script, "#!/bin/sh\necho hi\n");
  await runMore(paths, "pet", ["env", "set", "work", "sibling", "setup", script], {});
  writeFileSync(script, "  \n");
  await runMore(paths, "pet", ["env", "set", "work", "sibling", "on-start", script], {});
  await runMore(paths, "pet", ["instructions", "set", "work", "sibling", join(dir, "setup.sh")], {});
  expect(calls).toEqual([
    { method: "PATCH", path: "/api/houses/work/pets/sibling/environment", body: { setup: "#!/bin/sh\necho hi\n" } },
    { method: "PATCH", path: "/api/houses/work/pets/sibling/environment", body: { onStart: null } },
    { method: "GET", path: "/api/houses/work/pets/sibling/instructions" },
    { method: "PUT", path: "/api/houses/work/pets/sibling/instructions", body: { content: "  \n", revision: "r1" } }, // its revision: a newer save is not overwritten
  ]);
});

test("tasks are changed and removed at their current revision; the API's errors are the command's", async () => {
  const job = { id: "j1", name: "Digest", body: "Summarize", at: "2026-11-07T08:00:00.000Z", localAt: "2026-11-07T09:00", cron: "0 9 * * *", revision: 4, state: "scheduled" };
  const { paths, calls } = await daemon({
    "GET /api/houses/work/pets/sibling/crons": { body: { timezone: "Europe/Madrid", jobs: [job], runs: [] } },
    "PUT /api/timezone": { status: 400, body: { error: "Expected an IANA timezone" } },
  });
  await runMore(paths, "pet", ["tasks", "set", "work", "sibling", "j1"], { text: "Summarize the day" });
  await runMore(paths, "pet", ["tasks", "rm", "work", "sibling", "j1"], {});
  expect(calls.filter((call) => call.method !== "GET")).toEqual([
    { method: "PUT", path: "/api/houses/work/pets/sibling/crons/j1", body: { name: "Digest", body: "Summarize the day", cron: "0 9 * * *", revision: 4 } },
    { method: "DELETE", path: "/api/houses/work/pets/sibling/crons/j1", body: { revision: 4 } },
  ]);
  await expect(runMore(paths, "timezone", ["Mars/Base"], {})).rejects.toThrow("Expected an IANA timezone");
  await expect(runMore(paths, "pet", ["tasks", "rm", "work", "sibling", "nope"], {})).rejects.toThrow("no task 'nope'");
});

test("a new memory entry is written at revision 0, a known one at its own", async () => {
  const { paths, calls } = await daemon({
    "GET /api/houses/work/pets/sibling/memory/new": { status: 404, body: { error: "memory entry not found" } },
    "GET /api/houses/work/pets/sibling/memory/core": { body: { key: "core", value: "old", revision: 3 } },
  });
  await runMore(paths, "pet", ["memory", "set", "work", "sibling", "new"], { value: "hello" });
  await runMore(paths, "pet", ["memory", "set", "work", "sibling", "core"], { value: "newer" });
  expect(calls.filter((call) => call.method === "PUT").map((call) => call.body)).toEqual([{ key: "new", value: "hello", revision: 0 }, { key: "core", value: "newer", revision: 3 }]);
});

test("without a daemon the API commands say so; other words are not theirs", async () => {
  const paths = { socket: join(tempDir(), "none.sock"), eventLog: join(tempDir(), "events.jsonl") } as Paths;
  await expect(runMore(paths, "pet", ["restart", "work", "sibling"], {})).rejects.toThrow("daemon not running");
  expect(await runMore(paths, "pet", ["dance", "work", "sibling"], {})).toBe(false);
  expect(await runMore(paths, "fly", [], {})).toBe(false);
});

test("pet logs print the text as read, byte for byte; house logs -n 0 prints no lines", async () => {
  const { paths, said, dir } = await daemon({
    "GET /api/houses/work/pets/sibling/logs?source=docker&lines=2": { body: { source: "docker", text: "one\ntwo", cursor: "7:7", missing: false } },
  });
  const written: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation((text) => {
    written.push(String(text));
    return true;
  });
  stops.push(async () => write.mockRestore());
  await runMore(paths, "pet", ["logs", "work", "sibling"], { source: "docker", lines: "2" });
  expect(written).toEqual(["one\ntwo", "\n"]); // a last line without its newline gets one at the end, no blank lines
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ ts: "2026-11-06T16:22:31.000Z", type: "daemon", level: "info", message: "ready" })}\n`);
  await runMore(paths, "logs", [], { lines: "0" });
  await runMore(paths, "logs", [], { lines: "1" });
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("ready");
});
