import { expect, test } from "bun:test";
import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { knownAgents } from "../../src/app/agents";
import { channelChecks } from "../../src/app/channel-fields";
import { formatLogLine, logLine, readLog } from "../../src/app/household-log";
import { configCheck, knownChannelKinds, knownPlatforms } from "../../src/app/kinds";
import { readPetLog } from "../../src/app/pet-logs";
import { WebAuth } from "../../src/app/web-auth";
import { webRoutes } from "../../src/app/web-routes";
import { ConfigStore } from "../../src/infra/config-store";
import { EventLog } from "../../src/infra/event-log";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { tempDir } from "../helpers";

const daemon = (message: string, level: "info" | "error" = "info") => ({ ts: "2026-11-06T16:22:31.000Z", type: "daemon", level, message });
const agent = { ts: "2026-11-06T16:22:32.000Z", type: "agent", house: "work", pet: "sibling", event: { kind: "turn-failed", error: "no\nnewline" } };
const deny = { type: "proxy", kind: "connect", ts: "2026-11-06T16:22:33.000Z", verdict: "DENY", source: "127.0.0.1", method: "CONNECT", target: "evil.example:443", subject: { kind: "house", name: "work" }, pet: "owl", reason: "not allowed" };
const request = { type: "proxy", kind: "request", ts: "2026-11-06T16:22:34.000Z", subject: { kind: "house", name: "home" }, pet: "cat", source: "127.0.0.1", method: "GET", target: "api.example:443/v1", status: 200, swapped: true };

function logFile(...records: unknown[]): string {
  const path = join(tempDir(), "events.jsonl");
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return path;
}

test("each kind of event reads as a line: where from, how bad, whose, what; controls escaped", () => {
  expect(logLine(daemon("bot work/sibling: disabled") as never)).toEqual({ at: daemon("").ts, kind: "daemon", level: "info", house: "work", pet: "sibling", text: "bot work/sibling: disabled" });
  expect(logLine(daemon("telegram house work: polling failed", "error") as never)).toMatchObject({ level: "error", house: "work" });
  expect(logLine(daemon("ready, control socket /x") as never)!.house).toBeUndefined();
  expect(logLine(agent as never)).toMatchObject({ kind: "agent", level: "warn", house: "work", pet: "sibling", text: "turn failed: no newline" });
  expect(logLine(deny as never)).toMatchObject({ kind: "network", level: "warn", house: "work", pet: "owl", text: "deny evil.example:443 — not allowed" });
  expect(logLine(request as never)).toMatchObject({ level: "info", house: "home", text: "GET api.example:443/v1 → 200 · key filled in" });
  expect(formatLogLine(logLine(deny as never)!)).toContain("network  work/owl            WARN  deny evil.example:443");
});

test("the log reads its last lines that fit, then only what was appended since its cursor", () => {
  const path = logFile(daemon("house work created"), agent, deny, request);
  const first = readLog(path, { limit: 2 });
  expect(first.lines.map((line) => line.kind)).toEqual(["network", "network"]);
  expect(readLog(path, { limit: 10, filter: { house: "work" } }).lines).toHaveLength(3);
  expect(readLog(path, { limit: 10, filter: { kinds: ["agent"] } }).lines).toHaveLength(1);
  expect(readLog(path, { limit: 10, filter: { problems: true } }).lines.map((line) => line.kind)).toEqual(["agent", "network"]);
  expect(readLog(path, { limit: 10, filter: { query: "EVIL" } }).lines).toHaveLength(1);
  expect(readLog(path, { after: first.cursor, limit: 10 }).lines).toEqual([]);
  appendFileSync(path, `${JSON.stringify(daemon("bot work/owl: enabled"))}\n{"half`);
  const next = readLog(path, { after: first.cursor, limit: 10 });
  expect(next.lines.map((line) => line.text)).toEqual(["bot work/owl: enabled"]); // a half-written line waits
  appendFileSync(path, `":1}\n`);
  expect(readLog(path, { after: next.cursor, limit: 10 }).lines).toEqual([]); // not an event: skipped, never fatal
  expect(readLog(join(tempDir(), "none.jsonl"), { limit: 5 })).toEqual({ lines: [], cursor: "none:0" });
  expect(() => readLog(path, { after: "12", limit: 5 })).toThrow("after must be the cursor of a read before");
});

test("a pet's activity excludes house-wide events, other pets and the same pet name in another house", () => {
  const path = logFile(
    daemon("house work created"), daemon("daemon ready"),
    daemon("bot work/sibling: enabled"), agent, deny,
    { ...agent, house: "home" },
  );
  const filter = { house: "work", pet: "sibling" };
  const first = readLog(path, { limit: 100, filter });
  expect(first.lines.map(({ text }) => text)).toEqual(["bot work/sibling: enabled", "turn failed: no newline"]);
  appendFileSync(path, [daemon("house work reloaded"), { ...agent, pet: "owl" }, agent].map((record) => `${JSON.stringify(record)}\n`).join(""));
  expect(readLog(path, { limit: 100, filter, after: first.cursor }).lines.map(({ text }) => text)).toEqual(["turn failed: no newline"]);
});

test("a line's id is where it is in the log: the same from a first read and a follow-up, unique, stable as lines come", () => {
  const path = logFile(daemon("one"), daemon("two"));
  const first = readLog(path, { limit: 10 });
  appendFileSync(path, `${JSON.stringify(daemon("three"))}\n`);
  const next = readLog(path, { after: first.cursor, limit: 10 });
  const again = readLog(path, { limit: 10 });
  expect(again.lines.map((line) => line.id)).toEqual([...first.lines, ...next.lines].map((line) => line.id));
  expect(new Set(again.lines.map((line) => line.id)).size).toBe(3);
  expect(next.lines[0]!.id).toBe(first.cursor); // the third line starts where the first read ended
});

test("limit 0 reads no lines but still a cursor (like tail -n 0), and a follow-up past its limit counts what it left out", () => {
  const path = logFile(daemon("one"), daemon("two"), daemon("three"));
  const none = readLog(path, { limit: 0 });
  expect(none.lines).toEqual([]);
  expect(readLog(path, { after: none.cursor, limit: 10 }).lines).toEqual([]); // at the end already
  appendFileSync(path, ["four", "five", "six"].map((text) => `${JSON.stringify(daemon(text))}\n`).join(""));
  const capped = readLog(path, { after: none.cursor, limit: 2 });
  expect(capped.lines.map((line) => line.text)).toEqual(["five", "six"]);
  expect(capped.skipped).toBe(1);
  expect(readLog(path, { after: none.cursor, limit: 0 })).toMatchObject({ lines: [], skipped: 3 });
});

test("a narrow filter looks back past the last 8 MiB, and says how far back it looked when its budget ran out", () => {
  const path = logFile(daemon("the needle"));
  const filler = `${JSON.stringify(daemon(`filler ${"x".repeat(1000)}`))}\n`.repeat(9 * 1024);
  appendFileSync(path, filler); // 9+ MiB after the needle
  const found = readLog(path, { limit: 5, filter: { query: "needle" } });
  expect(found.lines.map((line) => line.text)).toEqual(["the needle"]);
  expect(found.searchedFrom).toBeUndefined(); // it read back to the start
  const scan = { window: 64 * 1024, budget: 256 * 1024, keep: 3 };
  const short = readLog(path, { limit: 5, filter: { query: "needle" } }, scan);
  expect(short.lines).toEqual([]);
  expect(short.searchedFrom).toBe(daemon("").ts); // all lines share one time here
  expect(readLog(path, { limit: 5 }, scan).searchedFrom).toBeUndefined(); // it found its lines
});

test("events.jsonl rotates by size through one open file; reads go on across the rotation and into the old files", () => {
  const path = join(tempDir(), "events.jsonl");
  const events = new EventLog(path, () => {}, { maxBytes: 400, keep: 2 });
  const say = (from: number, to: number) => { for (let n = from; n < to; n++) events.info(`line ${n}`); };
  say(0, 3);
  const first = readLog(path, { limit: 100 }, { window: 1024, budget: 1 << 20, keep: 2 });
  say(3, 6); // past 400 bytes: events.jsonl becomes events.jsonl.1
  expect(existsSync(`${path}.1`)).toBe(true);
  const next = readLog(path, { after: first.cursor, limit: 100 }, { window: 1024, budget: 1 << 20, keep: 2 });
  expect(next.lines.map((line) => line.text)).toEqual(["line 3", "line 4", "line 5"]); // the rest of .1, then the new file
  say(6, 30);
  expect(existsSync(`${path}.3`)).toBe(false); // two old files at most
  const all = readLog(path, { limit: 100 }, { window: 128, budget: 1 << 20, keep: 2 });
  const numbers = all.lines.map((line) => Number(line.text.slice(5)));
  expect(numbers.at(-1)).toBe(29);
  expect(numbers).toEqual(numbers.map((_, index) => numbers[0]! + index)); // in order, none twice, across the files
  const live = all.cursor.split(":")[0];
  expect(readLog(path, { after: next.cursor, limit: 100 }, { window: 1024, budget: 1 << 20, keep: 2 }).lines[0]!.id).toBe(`${live}:0`); // its file rotated away: the live one from its start
});

test("a follow-up read notices a log replaced, even one that grew past its cursor again, or truncated", () => {
  const path = logFile(daemon("one"), daemon("two"));
  const first = readLog(path, { limit: 10 });
  const fresh = `${path}.new`;
  writeFileSync(fresh, [daemon("a much longer first line than before"), daemon("again")].map((record) => `${JSON.stringify(record)}\n`).join(""));
  renameSync(fresh, path);
  const replaced = readLog(path, { after: first.cursor, limit: 10 });
  expect(replaced.lines.map((line) => line.text)).toEqual(["a much longer first line than before", "again"]);
  writeFileSync(path, `${JSON.stringify(daemon("truncated"))}\n`); // the same file, shorter than its cursor
  expect(readLog(path, { after: replaced.cursor, limit: 10 }).lines.map((line) => line.text)).toEqual(["truncated"]);
});

/** A pet VM as the guest scripts see it: its files' bytes and inodes, and its kernel's lines; output trimmed as exec does. */
function guest() {
  const files = new Map<string, { inode: number; bytes: Buffer }>();
  let kernel = { boot: "boot-1", lines: [] as string[] };
  const calls: string[][] = [];
  const exec = async (command: string[]) => {
    calls.push(command);
    const script = command[2]!;
    if (script.includes("dmesg")) {
      const [since, at] = [command[4]!, Number(command[5])];
      const after = since === kernel.boot ? at : -1;
      let time = 0;
      const lines = kernel.lines.filter((line) => {
        const stamp = /^\[ *(\d+)\.(\d+)\]/.exec(line);
        if (stamp) time = Number(stamp[1]) * 1e6 + Number(stamp[2]);
        return time > after;
      });
      return { ok: true, output: `${kernel.boot}\n${Buffer.from(lines.map((line) => `${line}\n`).join("")).toString("base64")}`.trim() };
    }
    const file = files.get(command[4]!);
    if (!file) return { ok: true, output: "missing" };
    const [since, at] = [command[5]!, Number(command[6])];
    const start = since === String(file.inode) && at <= file.bytes.length ? at : Math.max(0, file.bytes.length - 256 * 1024);
    return { ok: true, output: `${file.inode} ${start}\n${file.bytes.subarray(start, start + 256 * 1024).toString("base64")}`.trim() };
  };
  return {
    exec, calls, files,
    write: (name: string, text: string, inode = 7) => files.set(name, { inode, bytes: Buffer.from(text) }),
    append: (name: string, text: string) => { const file = files.get(name)!; file.bytes = Buffer.concat([file.bytes, Buffer.from(text)]); },
    kernel: (boot: string, lines: string[]) => { kernel = { boot, lines }; },
  };
}

test("a pet's VM log: its last lines, then exactly the bytes appended since, a line or half of one at a time", async () => {
  const vm = guest();
  expect(await readPetLog(vm.exec, "onStart")).toEqual({ source: "onStart", text: "", cursor: "none:0", missing: true });
  vm.write("environment/setup.log", "line one\nline two\n");
  const first = await readPetLog(vm.exec, "setup", { lines: 1 });
  expect(first).toEqual({ source: "setup", text: "line two\n", cursor: "7:18", missing: false });
  expect(vm.calls.at(-1)!.slice(-4)).toEqual(["sh", "environment/setup.log", "", "0"]); // under the pet's home
  vm.append("environment/setup.log", "line three\n");
  const next = await readPetLog(vm.exec, "setup", { after: first.cursor });
  expect(next).toEqual({ source: "setup", text: "line three\n", cursor: "7:29", missing: false }); // its newline kept
  expect(vm.calls.at(-1)!.slice(-2)).toEqual(["7", "18"]);
  vm.append("environment/setup.log", "half ");
  const file = vm.files.get("environment/setup.log")!;
  file.bytes = Buffer.concat([file.bytes, Buffer.from([0xc3])]); // «é» half written
  const half = await readPetLog(vm.exec, "setup", { after: next.cursor });
  expect(half).toMatchObject({ text: "half ", cursor: "7:34" }); // the cut character waits
  file.bytes = Buffer.concat([file.bytes, Buffer.from([0xa9]), Buffer.from(" done\n")]);
  expect((await readPetLog(vm.exec, "setup", { after: half.cursor })).text).toBe("é done\n");
  expect(await readPetLog(vm.exec, "setup", { lines: 0 })).toMatchObject({ text: "" }); // like tail -n 0
  vm.write("environment/setup.log", "run two\n", 8); // written anew: another inode
  expect(await readPetLog(vm.exec, "setup", { after: half.cursor })).toEqual({ source: "setup", text: "run two\n", cursor: "8:8", missing: false, restarted: true });
  await expect(readPetLog(async () => ({ ok: false, output: "" }), "docker")).rejects.toThrow("could not read the docker log");
});

test("the kernel log follows by the time of its last line: a full ring buffer that drops old lines still shows new ones", async () => {
  const vm = guest();
  vm.kernel("boot-1", ["[    0.000000] Linux", "[    0.500000] a", "  more of a", "[    1.000000] b"]);
  const first = await readPetLog(vm.exec, "kernel", { lines: 2 });
  expect(first).toMatchObject({ text: "  more of a\n[    1.000000] b\n", cursor: "boot-1:1000000" });
  expect(vm.calls.at(-1)![2]).toContain("sudo -n dmesg");
  vm.kernel("boot-1", ["[    0.500000] a", "[    1.000000] b", "[    2.000000] c"]); // wrapped: as many lines as before
  const next = await readPetLog(vm.exec, "kernel", { after: first.cursor });
  expect(next).toMatchObject({ text: "[    2.000000] c\n", cursor: "boot-1:2000000" });
  vm.kernel("boot-1", ["[    2.000000] c"]); // wrapped to fewer lines: nothing sent again
  expect(await readPetLog(vm.exec, "kernel", { after: next.cursor })).toMatchObject({ text: "", cursor: "boot-1:2000000" });
  vm.kernel("boot-2", ["[    0.000000] Linux", "[    0.200000] up"]); // the VM booted again
  expect(await readPetLog(vm.exec, "kernel", { after: next.cursor })).toMatchObject({ text: "[    0.000000] Linux\n[    0.200000] up\n", cursor: "boot-2:200000", restarted: true });
});

function routes(petLog?: Parameters<typeof webRoutes>[0]["petLog"]) {
  const dir = tempDir();
  const configFile = join(dir, "household.yaml");
  writeFileSync(configFile, "keys:\n  claude: {provider: anthropic, value: sk-ant-oat01-logs-test}\nhouses:\n  work:\n    network: {allow: []}\n    pets:\n      sibling: {key: claude}\n");
  const eventLog = logFile(daemon("house work created"), deny, request);
  return webRoutes({
    auth: new WebAuth(new SqliteStore(":memory:")),
    config: new ConfigStore(configFile, configCheck(knownAgents())),
    agents: knownAgents(),
    channelKinds: knownChannelKinds(),
    platforms: knownPlatforms(),
    checks: channelChecks("http://127.0.0.1:1"),
    apply: async () => {},
    petStates: async () => [],
    channelProblem: () => undefined,
    state: () => "running",
    version: "0.1.0",
    events: new EventLog(join(dir, "own-events.jsonl"), () => {}),
    eventLog,
    petLog,
  });
}
const local = (handler: ReturnType<typeof routes>, path: string) => handler.local(new Request(`http://household${path}`));

test("the API answers the control socket without a browser session; a browser still needs one", async () => {
  const handler = routes();
  expect((await local(handler, "/api/houses")).status).toBe(200);
  expect((await handler(new Request("http://127.0.0.1:1/api/houses"), () => {}))!.status).toBe(401);
});

test("/api/logs filters the Household log and follows it by cursor", async () => {
  const handler = routes();
  const all = await (await local(handler, "/api/logs")).json();
  expect(all.lines).toHaveLength(3);
  const work = await (await local(handler, "/api/logs?house=work&kinds=network&problems=true")).json();
  expect(work.lines.map((line: { text: string }) => line.text)).toEqual(["deny evil.example:443 — not allowed"]);
  expect((await (await local(handler, `/api/logs?after=${encodeURIComponent(all.cursor)}`)).json()).lines).toEqual([]);
  expect((await (await local(handler, "/api/logs?limit=0")).json()).lines).toEqual([]);
  expect((await local(handler, "/api/logs?kinds=gossip")).status).toBe(400);
  expect((await local(handler, "/api/logs?after=-1")).status).toBe(400);
});

test("a pet's VM logs: by source, 409 while its VM is not running, 404 for no such pet", async () => {
  const asked: unknown[] = [];
  const handler = routes(async (house, pet, source, read) => {
    asked.push([house, pet, source, read]);
    return source === "kernel" ? undefined : { source, text: "ok\n", cursor: "7:3", missing: false };
  });
  expect(await (await local(handler, "/api/houses/work/pets/sibling/logs?source=docker&lines=50")).json()).toEqual({ source: "docker", text: "ok\n", cursor: "7:3", missing: false });
  expect(asked).toEqual([["work", "sibling", "docker", { lines: 50, after: undefined }]]);
  expect((await local(handler, "/api/houses/work/pets/sibling/logs?source=kernel")).status).toBe(409);
  expect((await local(handler, "/api/houses/work/pets/sibling/logs?source=journal")).status).toBe(400);
  expect((await local(handler, "/api/houses/work/pets/ghost/logs")).status).toBe(404);
});
