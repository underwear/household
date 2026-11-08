import { afterEach, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readlink, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexAuthEnvironment, readLocalCodexAuth, refreshLocalCodexAuth, runCodexAuthServer, startCodexRefresh } from "../../src/agent-adapters/codex-app-server/host-auth";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function home() { const dir = await mkdtemp(join(tmpdir(), "household-auth-test-")); dirs.push(dir); return dir; }
const jwt = (exp: number, account = "account-1") => `e30.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.test-signature`;
const auth = (token = jwt(2000), account = "account-1") => ({ auth_mode: "chatgpt", tokens: { account_id: account, access_token: token, refresh_token: "refresh-test-secret" } });
const key = { name: "codex", value: "codex-chatgpt:account-1", home: "/dedicated/auth-1" };

test("managed ChatGPT access token is account-bound and expires at JWT exp, without returning refresh credentials", async () => {
  const dir = await home();
  await writeFile(join(dir, "auth.json"), JSON.stringify(auth()));
  expect(await readLocalCodexAuth("account-1", { home: dir, now: 1000 })).toEqual({ accountId: "account-1", accessToken: jwt(2000), expiresAt: 2_000_000 });
  await expect(readLocalCodexAuth("other", { home: dir, now: 1000 })).rejects.toThrow("authentication is unavailable or invalid");
  await expect(readLocalCodexAuth(undefined, { home: dir, now: 2_000_000 })).rejects.toThrow("authentication is unavailable or invalid");
});

test("API auth, malformed tokens, wrong claims, absent auth and parse errors fail with a fixed secret-free message", async () => {
  const dir = await home();
  const fixtures = [
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "api-test-secret", tokens: auth().tokens }),
    JSON.stringify(auth("malformed-token-secret")), JSON.stringify(auth(jwt(2000, "wrong-account"))),
    JSON.stringify(auth(jwt(Infinity))), '{"token":"parse-error-secret', "null",
  ];
  for (const fixture of fixtures) {
    await writeFile(join(dir, "auth.json"), fixture);
    try { await readLocalCodexAuth(undefined, { home: dir, now: 1000 }); throw new Error("unexpected success"); }
    catch (error) { expect((error as Error).message).toBe("Codex ChatGPT authentication is unavailable or invalid; sign in to Codex again"); }
  }
  await unlink(join(dir, "auth.json"));
  await expect(readLocalCodexAuth(undefined, { home: dir })).rejects.toThrow("authentication is unavailable or invalid");
});

test("auth-only process environment discards provider/proxy credentials and configuration", () => {
  expect(codexAuthEnvironment("/isolated", { PATH: "/bin", HOME: "/host", OPENAI_API_KEY: "secret", CODEX_HOME: "/old", OPENAI_BASE_URL: "https://untrusted", HTTPS_PROXY: "http://untrusted", CODEX_ACCESS_TOKEN: "secret" })).toEqual({ CODEX_HOME: "/isolated", PATH: "/bin", HOME: "/host" });
});

test("refresh shares one managed credential file, coalesces concurrent callers, cleans isolated workspace", async () => {
  const dir = await home();
  const source = join(dir, "auth.json");
  await writeFile(source, JSON.stringify(auth()));
  let count = 0;
  let isolated = "";
  let release!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const run = async (tempHome: string, workspace: string) => {
    count++;
    isolated = workspace;
    expect(await readlink(join(tempHome, "auth.json"))).toBe(await realpath(source));
    expect((await lstat(tempHome)).mode & 0o777).toBe(0o700);
    await held;
    await writeFile(join(tempHome, "auth.json"), JSON.stringify(auth(jwt(3000))));
  };
  const a = refreshLocalCodexAuth(dir, run);
  const b = refreshLocalCodexAuth(dir, run);
  await Bun.sleep(20);
  release();
  await Promise.all([a, b]);
  expect(count).toBe(1);
  expect((await readLocalCodexAuth(undefined, { home: dir, now: 1000 })).accessToken).toBe(jwt(3000));
  expect(await lstat(isolated).catch(() => undefined)).toBeUndefined();
});

test("an app-server atomic auth replacement updates managed store without keeping a credential copy", async () => {
  const dir = await home();
  await writeFile(join(dir, "auth.json"), JSON.stringify(auth()));
  await refreshLocalCodexAuth(dir, async (tempHome) => {
    await unlink(join(tempHome, "auth.json"));
    await writeFile(join(tempHome, "auth.json"), JSON.stringify(auth(jwt(3000))));
  });
  expect((await readLocalCodexAuth(undefined, { home: dir, now: 1000 })).accessToken).toBe(jwt(3000));
  expect((await lstat(join(dir, "auth.json"))).mode & 0o777).toBe(0o600);
});

test("concurrent external account changes are never overwritten by an isolated atomic refresh", async () => {
  const dir = await home();
  await writeFile(join(dir, "auth.json"), JSON.stringify(auth()));
  await expect(refreshLocalCodexAuth(dir, async (tempHome) => {
    await unlink(join(tempHome, "auth.json"));
    await writeFile(join(tempHome, "auth.json"), JSON.stringify(auth(jwt(3000))));
    await writeFile(join(dir, "auth.json"), JSON.stringify(auth(jwt(4000, "different-account"), "different-account")));
  })).rejects.toThrow("authentication is unavailable or invalid");
  expect(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).tokens.account_id).toBe("different-account");
});

test("zero keys starts no auth process; malformed markers and absent dedicated stores are refused", async () => {
  let called = false;
  const deps = { refresh: async () => { called = true; } };
  (await startCodexRefresh({ keys: [], onToken() {} }, deps)).stop();
  expect(called).toBe(false);
  for (const keys of [[{ ...key, value: "api-key" }], [{ ...key, home: "" }]]) {
    await expect(startCodexRefresh({ keys, onToken() {} }, deps)).rejects.toThrow("authentication is unavailable or invalid");
  }
  expect(called).toBe(false);
});

test("initial refresh completes before token publication; failed readiness revokes rather than reuses credentials", async () => {
  const calls: string[] = [];
  const callbacks: unknown[] = [];
  const deps = {
    refresh: async () => { calls.push("refresh"); },
    read: async (accountId: string) => { calls.push(accountId); return { accountId, accessToken: "access-test-token", expiresAt: Date.now() + 3_600_000 }; },
  };
  const broker = await startCodexRefresh({ keys: [key], onToken(name, token) { calls.push("publish"); callbacks.push([name, token]); } }, deps);
  broker.stop();
  expect(calls).toEqual(["refresh", "account-1", "publish"]);
  expect(callbacks).toEqual([["codex", "access-test-token"]]);
  callbacks.length = 0;
  await expect(startCodexRefresh({ keys: [key], onToken(name, token) { callbacks.push([name, token]); } }, { refresh: async () => { throw new Error("secret failure"); } })).rejects.toThrow("authentication is unavailable or invalid");
  expect(callbacks).toEqual([["codex", undefined]]);
});

test("background refresh failure revokes; stopped watchers never publish a late refreshed token", async () => {
  const published: unknown[] = [];
  const logs: string[] = [];
  let count = 0;
  let refreshed!: () => void;
  const background = new Promise<void>((done) => { refreshed = done; });
  const broker = await startCodexRefresh({ keys: [key], onToken(_name, token) { published.push(token); }, log(text) { logs.push(text); refreshed(); } }, {
    intervalMs: 10,
    refresh: async () => { if (++count > 1) throw new Error("secret failure"); },
    read: async (accountId) => ({ accountId, accessToken: "first", expiresAt: Date.now() + 3_600_000 }),
  });
  await background;
  broker.stop();
  expect(published).toEqual(["first", undefined]);
  expect(logs).toEqual(["Codex subscription refresh failed; its gateway credential was revoked"]);

  published.length = 0;
  count = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  const late = await startCodexRefresh({ keys: [key], onToken(_name, token) { published.push(token); } }, {
    intervalMs: 10,
    refresh: async () => { if (++count > 1) { entered(); await held; } },
    read: async (accountId) => ({ accountId, accessToken: "token", expiresAt: Date.now() + 3_600_000 }),
  });
  await started;
  late.stop();
  release();
  await Bun.sleep(20);
  expect(published).toEqual(["token"]);
});


test("auth-only child sends only initialization and refresh RPCs and rejects non-subscription auth", async () => {
  const dir = await home();
  const packets = join(dir, "packets.jsonl");
  const script = join(dir, "fake-codex");
  await writeFile(script, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line', line => {
  const packet=JSON.parse(line);
  appendFileSync(${JSON.stringify(packets)}, line+'\\n');
  if (packet.id===1) console.log(JSON.stringify({id:1,result:{}}));
  if (packet.id===2) console.log(JSON.stringify({id:2,result:{account:{type:'chatgpt'}}}));
});`, { mode: 0o700 });
  await runCodexAuthServer(dir, dir, script, 1000);
  const sent = (await readFile(packets, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(sent.map((packet) => packet.method)).toEqual(["initialize", "initialized", "account/read"]);
  expect(sent[2].params).toEqual({ refreshToken: true });
  await writeFile(script, `#!${process.execPath}
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
 const packet=JSON.parse(line);
 if(packet.id===1) console.log(JSON.stringify({id:1,result:{}}));
 if(packet.id===2) console.log(JSON.stringify({id:2,result:{account:{type:'apiKey'}}}));
});`);
  await expect(runCodexAuthServer(dir, dir, script, 1000)).rejects.toThrow("authentication is unavailable or invalid");
});

test("auth-only child startup failure and timeout terminate cleanly without exposing raw protocol errors", async () => {
  const dir = await home();
  await expect(runCodexAuthServer(dir, dir, join(dir, "missing-command"), 1000)).rejects.toThrow("authentication is unavailable or invalid");
  const script = join(dir, "stalled-codex");
  await writeFile(script, `#!${process.execPath}
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, { mode: 0o700 });
  const start = Date.now();
  await expect(runCodexAuthServer(dir, dir, script, 50)).rejects.toThrow("authentication is unavailable or invalid");
  expect(Date.now() - start).toBeLessThan(2000);
});


test("dedicated homes support distinct portable subscriptions without consulting a global CLI login", async () => {
  await expect(readLocalCodexAuth()).rejects.toThrow("authentication is unavailable or invalid");
  const homes: string[] = [];
  const tokens: unknown[] = [];
  const broker = await startCodexRefresh({
    keys: [key, { name: "second", value: "codex-chatgpt:account-2", home: "/dedicated/auth-2" }],
    onToken(name, token) { tokens.push([name, token]); },
  }, {
    refresh: async (home) => { homes.push(home); },
    read: async (accountId, home) => ({ accountId, accessToken: home, expiresAt: Date.now() + 3_600_000 }),
  });
  broker.stop();
  expect(homes).toEqual(["/dedicated/auth-1", "/dedicated/auth-2"]);
  expect(tokens).toEqual([["codex", "/dedicated/auth-1"], ["second", "/dedicated/auth-2"]]);
});
