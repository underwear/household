import { expect, test } from "bun:test";
import { SlackConnectors, type SlackConnectorFiles } from "../../src/app/slack-connectors";
import { slackConnectorRoutes } from "../../src/app/slack-connector-routes";
import { slackConnectorTools } from "../../src/app/slack-connector-tools";
import { SLACK_READ_SCOPES, SLACK_WRITE_SCOPES } from "../../src/core/slack-connectors";
import { slackOperation } from "../../src/infra/slack/operations";
import { slackRead, type SlackFetch } from "../../src/infra/slack/client";
import { mcpHandler } from "../../src/infra/mcp-server";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";

const caller = { house: "home", pet: "alice" };
function setup(files?: SlackConnectorFiles) {
  const house: House = { name: "home", pets: [{ name: "alice" }, { name: "bob" }, { name: "worker", sideworker: { parent: "alice", cwd: "/" } }, { name: "scout", scout: {} as any }], network: { kind: "allowlist", allow: [] }, people: { owners: [] }, channels: [] };
  const store = new SqliteStore(":memory:");
  const calls: { url: string; init?: RequestInit }[] = [];
  let scopes: string[] = [...SLACK_READ_SCOPES];
  let auth: Record<string, unknown> = { ok: true, team_id: "T123", team: "Personal", user_id: "U123", user: "igor" };
  let api: SlackFetch = async () => Response.json({ ok: true, messages: [{ text: "external" }], response_metadata: { next_cursor: "next" } });
  const service = new SlackConnectors(store, async (url, init) => {
    calls.push({ url: String(url), init });
    if (new URL(url).pathname.endsWith("auth.test")) return Response.json(auth, { headers: { "x-oauth-scopes": scopes.join(",") } });
    return api(url, init);
  }, undefined, undefined, files);
  service.setHouses([house, { ...house, name: "other" }]);
  const connect = async (home = "home") => (await service.connect(home, { token: "xoxp-private-token", pets: ["alice"] })).id;
  return { house, store, calls, service, connect, api: (f: SlackFetch) => { api = f; }, scopes: (s: string[]) => { scopes = s; }, auth: (value: Record<string, unknown>) => { auth = value; } };
}

test("Slack enrollment validates user identity and allowed scopes without exposing tokens", async () => {
  const s = setup(); s.scopes(["identify", ...SLACK_READ_SCOPES]); await s.connect();
  expect(JSON.stringify(s.service.list("home"))).not.toContain("private-token");
  expect(JSON.stringify(s.service.accounts(caller))).not.toContain("private-token");
  expect(s.service.list("home").connections[0]!.teamId).toBe("T123");
  for (const token of ["xoxb-bot-token", "xoxp-a\nheader", ""]) await expect(s.service.connect("home", { token, pets: [] })).rejects.toThrow();
  s.scopes(["search:read", "admin.users:write"]);
  await expect(s.connect()).rejects.toThrow("connector scopes");
  s.scopes([]); await expect(s.connect()).rejects.toThrow("connector scopes");
  s.auth({ ok: true, team_id: "T123", user_id: "U123", bot_id: "B123" });
  await expect(s.connect()).rejects.toThrow("user token");
});

test("Slack grants are house-scoped even for the same Slack identity and known connection id", async () => {
  const s = setup(), id = await s.connect(), other = await s.connect("other");
  expect(other).not.toBe(id);
  for (const denied of [{ ...caller, house: "other" }, { ...caller, pet: "bob" }, { ...caller, pet: "scout" }, { ...caller, pet: "missing" }]) {
    await expect(s.service.request(denied, id, "search.messages", { query: "hello" })).rejects.toThrow("unavailable");
  }
  expect(() => s.service.setPets("other", id, ["alice"])).toThrow("not found");
  expect(() => s.service.disconnect("other", id)).toThrow("not found");
  s.service.disconnect("home", id);
  expect(s.service.accounts({ ...caller, house: "other" })).toHaveLength(1);
});

test("sideworkers inherit live parent grants; scouts and disabled bots cannot read", async () => {
  const s = setup(), id = await s.connect();
  expect(s.service.accounts({ ...caller, pet: "worker" })).toHaveLength(1);
  expect(s.service.accounts({ ...caller, pet: "scout" })).toEqual([]);
  expect(() => s.service.setPets("home", id, ["scout"])).toThrow();
  expect(() => s.service.setPets("home", id, ["worker"])).toThrow();
  s.service.setPets("home", id, ["bob"]);
  expect(s.service.accounts({ ...caller, pet: "worker" })).toEqual([]);
  s.service.setHouses([{ ...s.house, pets: s.house.pets.map(p => p.name === "bob" ? { ...p, enabled: false } : p) }]);
  expect(s.service.accounts({ ...caller, pet: "bob" })).toEqual([]);
});

test("closed registry rejects unsupported operations, arbitrary URLs, credentials, traversal and oversized pages", () => {
  for (const operation of ["chat.postMessage", "auth.test", "__proto__", "constructor", "https://evil.test", "files.delete"]) expect(() => slackOperation(operation, {})).toThrow();
  for (const params of [{ channel: "../secret" }, { channel: "C123", token: "evil" }, { channel: "C123", limit: 101 }, { channel: "C123", url: "https://evil.test" }]) expect(() => slackOperation("conversations.history", params)).toThrow();
  expect(() => slackOperation("conversations.replies", { channel: "C123", ts: 123 })).toThrow();
});

test("Slack requests use a fixed host and bearer header, preserve pagination and mark content untrusted", async () => {
  const s = setup(), id = await s.connect();
  const result = await s.service.request(caller, id, "search.messages", { query: "in:general &token=evil" });
  expect(result.trust).toBe("external");
  expect(result.data.response_metadata.next_cursor).toBe("next");
  const call = s.calls.at(-1)!, url = new URL(call.url);
  expect(url.origin).toBe("https://slack.com");
  expect(url.searchParams.get("query")).toBe("in:general &token=evil");
  expect(url.searchParams.has("token")).toBe(false);
  expect(call.init!.headers).toEqual({ authorization: "Bearer xoxp-private-token" });
  expect(call.init!.redirect).toBe("error");
});

test("scope filtering prevents unavailable operations", async () => {
  const s = setup(); s.scopes(["search:read"]); const id = await s.connect();
  expect(s.service.catalog(caller).map(o => o.name)).toEqual(["search.messages", "search.files", "chat.getPermalink"]);
  await expect(s.service.request(caller, id, "files.info", { file: "F123" })).rejects.toThrow("scope");
});

test("revocation cancels in-flight results even if the transport ignores abort", async () => {
  for (const remove of [false, true]) {
    const s = setup(), id = await s.connect(); let finish!: (r: Response) => void;
    // The read hangs; disconnecting also revokes the token at Slack, which answers at once.
    s.api(async url => String(url).endsWith("/auth.revoke") ? Response.json({ ok: true }) : new Promise(resolve => { finish = resolve; }));
    const pending = s.service.request(caller, id, "search.messages", { query: "secret" });
    await Promise.resolve();
    if (remove) s.service.disconnect("home", id); else s.service.setPets("home", id, []);
    finish(Response.json({ ok: true, messages: ["private-result"] }));
    await expect(pending).rejects.toThrow();
    if (remove) expect(s.store.get("house.connectors.slack.v1")).not.toContain("private-token");
  }
});

test("reconciliation removes deleted house credentials and revoked token requires reconnect", async () => {
  const s = setup(), id = await s.connect();
  s.api(async () => Response.json({ ok: false, error: "token_revoked", detail: "private-token" }));
  await expect(s.service.request(caller, id, "search.messages", { query: "hi" })).rejects.toThrow("token_revoked");
  expect(s.service.list("home").connections[0]!.needsReconnect).toBe(true);
  await expect(s.service.request(caller, id, "search.messages", { query: "hi" })).rejects.toThrow("Reconnect");
  s.service.setHouses([]); expect(s.store.get("house.connectors.slack.v1")).toBe("[]");
});

test("rate limits, oversized streams and upstream failures are bounded and sanitized", async () => {
  await expect(slackRead(async () => new Response("private", { status: 429, headers: { "retry-after": "42" } }), "token", "auth.test")).rejects.toThrow("42 seconds");
  await expect(slackRead(async () => new Response("x".repeat(600 * 1024)), "token", "auth.test")).rejects.toThrow("smaller limit or count");
  const s = setup(), id = await s.connect();
  s.api(async () => { throw new Error("private-token"); });
  await expect(s.service.request(caller, id, "search.messages", { query: "hi" })).rejects.toThrow("Slack request failed or was cancelled");
  s.api(async () => Response.json({ ok: false, error: "private-token" }));
  await expect(s.service.request(caller, id, "search.messages", { query: "hi" })).rejects.toThrow("request_failed");
});

test("owner routes never return tokens and MCP hides all tools from scouts", async () => {
  const s = setup(), route = slackConnectorRoutes(s.service);
  const result = await route(new Request("http://localhost/api/houses/home/connectors/slack/connect", { method: "POST", body: JSON.stringify({ token: "xoxp-private-token", pets: ["alice"] }) }));
  expect(await result!.text()).not.toContain("private-token");
  const handler = mcpHandler({ name: "test", version: "1" }, slackConnectorTools(s.service));
  const list = () => new Request("http://localhost/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  expect((await (await handler(caller, list())).json()).result.tools).toHaveLength(3);
  expect((await (await handler({ ...caller, pet: "scout" }, list())).json()).result.tools).toEqual([]);
  const call = new Request("http://localhost/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "household_connectors_slack_request", arguments: { connection: s.service.accounts(caller)[0]!.id, operation: "chat.postMessage", params: {} } } }) });
  expect((await (await handler(caller, call)).json()).result.isError).toBe(true);
});

test("sending requires explicit opt-in and Slack scope; private grants remain enforced", async () => {
  const s = setup(); s.scopes([...SLACK_READ_SCOPES, "chat:write"]);
  const readonly = await s.connect();
  expect(s.service.catalog(caller).some(o => o.name === "chat.postMessage")).toBe(false);
  await expect(s.service.request(caller, readonly, "chat.postMessage", { channel: "D123", text: "test" })).rejects.toThrow("disabled");
  const c = await s.service.connect("home", { token: "xoxp-private-token", pets: ["alice"], allowWrite: true });
  expect(s.service.catalog(caller).find(o => o.name === "chat.postMessage")!.readOnly).toBe(false);
  for (const denied of [{ house: "other", pet: "alice" }, { house: "home", pet: "bob" }, { house: "home", pet: "scout" }]) await expect(s.service.request(denied, c.id, "chat.postMessage", { channel: "D123", text: "test" })).rejects.toThrow("unavailable");
  await s.service.request(caller, c.id, "chat.postMessage", { channel: "D123", text: "household connector test: qa" });
  const call = s.calls.at(-1)!;
  expect(call.url).toBe("https://slack.com/api/chat.postMessage");
  expect(call.init!.method).toBe("POST");
  expect(JSON.parse(call.init!.body as string)).toEqual({ channel: "D123", text: "household connector test: qa", unfurl_links: false, unfurl_media: false });
  s.api(async () => { throw new Error("network failure"); });
  const before = s.calls.length;
  await expect(s.service.request(caller, c.id, "chat.postMessage", { channel: "D123", text: "test" })).rejects.toThrow("outcome is unknown");
  expect(s.calls.length - before).toBe(1);
  s.service.setPets("home", c.id, []);
  await expect(s.service.request(caller, c.id, "chat.postMessage", { channel: "D123", text: "test" })).rejects.toThrow("unavailable");
});
test("OAuth requests write scope only on explicit opt-in", () => {
  const s = setup();
  const scopes = (allowWrite: boolean) => new URL(s.service.begin("home", { pets: ["alice"], allowWrite }, "https://vps.example", "owner").url).searchParams.get("user_scope")!.split(",");
  for (const scope of SLACK_WRITE_SCOPES) {
    expect(scopes(false)).not.toContain(scope);
    expect(scopes(true)).toContain(scope);
  }
  expect(scopes(false)).toEqual([...SLACK_READ_SCOPES]);
  for (const params of [{ channel: "D123", text: "hi", username: "fake" }, { channel: "D123", text: "hi", token: "secret" }, { channel: "D123", text: "hi", unfurl_links: true }]) expect(() => slackOperation("chat.postMessage", params)).toThrow();
});

test("disconnect revokes the token at Slack too; sending shows only when the token can send", async () => {
  const s = setup(), id = await s.connect();
  s.service.disconnect("home", id); await Bun.sleep(0);
  expect(s.calls.some(c => c.url.endsWith("/auth.revoke"))).toBe(true);
  const read = await s.service.connect("home", { token: "xoxp-private-token", pets: ["alice"], allowWrite: true });
  expect(read.allowWrite).toBe(false); // no chat:write in its scopes
});

test("a bot gaining access leaves reads in progress alone; one losing it stops them", async () => {
  const s = setup(), id = await s.connect();
  let release!: () => void;
  s.api((_url, init) => new Promise((resolve, reject) => { release = () => resolve(Response.json({ ok: true, messages: [] })); init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); }));
  const kept = s.service.request(caller, id, "search.messages", { query: "x" }); await Bun.sleep(5);
  s.service.setPets("home", id, ["alice", "bob"]);
  release(); await expect(kept).resolves.toBeDefined();
  const cut = s.service.request(caller, id, "search.messages", { query: "x" }); await Bun.sleep(5);
  s.service.setPets("home", id, ["alice"]);
  await expect(cut).rejects.toThrow();
});

test("malformed JSON to the Slack routes is a 400-class error, not a crash", async () => {
  const s = setup(), routes = slackConnectorRoutes(s.service);
  await expect(routes(new Request("http://127.0.0.1:8780/api/houses/home/connectors/slack/connect", { method: "POST", body: "{nope" }))).rejects.toThrow("not valid JSON");
});

const writeCases: [string, Record<string, unknown>][] = [
  ["chat.postMessage", { channel: "C123", text: "hello" }],
  ["chat.update", { channel: "C123", ts: "123.456", text: "fixed" }],
  ["chat.delete", { channel: "C123", ts: "123.456" }],
  ["reactions.add", { channel: "C123", timestamp: "123.456", name: "thumbsup" }],
  ["reactions.remove", { channel: "C123", timestamp: "123.456", name: "thumbsup" }],
  ["conversations.open", { users: "U123" }],
  ["conversations.mark", { channel: "C123", ts: "123.456" }],
  ["files.upload", { path: "video.mp4", channel_id: "C123" }],
];
test("every Slack mutation is hidden and blocked without allowWrite before any I/O", async () => {
  const s = setup(); s.scopes([...SLACK_READ_SCOPES, ...SLACK_WRITE_SCOPES]); const id = await s.connect();
  const before = s.calls.length;
  for (const [name, params] of writeCases) {
    expect(s.service.catalog(caller).some(op => op.name === name)).toBe(false);
    await expect(s.service.request(caller, id, name, params)).rejects.toThrow("disabled");
  }
  expect(s.calls.length).toBe(before);
});
test("new write operations dispatch as authenticated POSTs and honor their own scopes", async () => {
  for (const [name, params] of writeCases.filter(([name]) => name !== "files.upload")) {
    const s = setup(); s.scopes([...SLACK_READ_SCOPES, ...SLACK_WRITE_SCOPES]);
    const c = await s.service.connect("home", { token: "xoxp-private-token", pets: ["alice"], allowWrite: true });
    await s.service.request(caller, c.id, name, params);
    const call = s.calls.at(-1)!;
    expect(call.url).toBe(`https://slack.com/api/${name}`);
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(call.init?.body as string)).toMatchObject(params);
    expect(s.service.catalog(caller).find(op => op.name === name)?.readOnly).toBe(false);
  }
  const s = setup(); s.scopes(["reactions:write"]);
  const c = await s.service.connect("home", { token: "xoxp-private-token", pets: ["alice"], allowWrite: true });
  expect(c.allowWrite).toBe(true); // write access no longer requires chat:write
  await s.service.request(caller, c.id, "reactions.add", writeCases[3]![1]);
  await expect(s.service.request(caller, c.id, "chat.delete", writeCases[2]![1])).rejects.toThrow("scope");
});
test("catalog does not combine a read-only account's scopes with another account's allowWrite", async () => {
  const s = setup(); s.scopes(["files:write", "chat:write"]); await s.connect();
  s.auth({ ok: true, team_id: "T456", user_id: "U456" }); s.scopes(["reactions:write"]);
  await s.service.connect("home", { token: "xoxp-second-token", pets: ["alice"], allowWrite: true });
  const names = s.service.catalog(caller).map(op => op.name);
  expect(names).toContain("reactions.add");
  expect(names).not.toContain("files.upload");
  expect(names).not.toContain("chat.postMessage");
  expect(s.service.catalog({ ...caller, pet: "bob" })).toEqual([]);
});
test("new read operations preserve parameters, defaults and Slack pagination", async () => {
  const s = setup(), id = await s.connect();
  for (const [name, params] of [
    ["search.files", { query: "in:general report", page: 2 }],
    ["usergroups.list", { include_users: true }],
    ["usergroups.users.list", { usergroup: "S123" }],
    ["reactions.get", { channel: "C123", timestamp: "123.456" }],
    ["users.lookupByEmail", { email: "a@example.com" }],
    ["chat.getPermalink", { channel: "C123", message_ts: "123.456" }],
    ["users.conversations", { types: "im,mpim" }],
  ] as [string, Record<string, unknown>][]) {
    const result = await s.service.request(caller, id, name, params);
    const url = new URL(s.calls.at(-1)!.url);
    expect(url.pathname).toBe(`/api/${name}`);
    for (const [key, value] of Object.entries(params)) expect(url.searchParams.get(key)).toBe(String(value));
    expect(result.data.response_metadata.next_cursor).toBe("next");
    expect(result.trust).toBe("external");
  }
});
test("file and DM parameters reject traversal, raw URLs, mismatched sharing and invalid combinations", () => {
  for (const path of ["/etc/passwd", "../private", "a/../b", "a//b", "a\\b", "a\0b"]) expect(() => slackOperation("files.upload", { path })).toThrow();
  for (const params of [{ file: "F123", url: "https://evil.test" }, { file: "../F123" }]) expect(() => slackOperation("files.download", params)).toThrow();
  expect(() => slackOperation("files.upload", { path: "report.pdf", thread_ts: "123.456" })).toThrow();
  for (const types of ["im,im", "im,unknown", "im,", ""]) expect(() => slackOperation("users.conversations", { types })).toThrow();
  expect(slackOperation("users.conversations", { types: "private_channel,public_channel" }).params.types).toBe("private_channel,public_channel");
});
test("opening group DMs requires mpim:write, not just im:write", async () => {
  const s = setup(); s.scopes(["im:write"]);
  const c = await s.service.connect("home", { token: "xoxp-private-token", pets: ["alice"], allowWrite: true });
  await expect(s.service.request(caller, c.id, "conversations.open", { users: "U123,U456" })).rejects.toThrow("scope");
  expect(s.calls).toHaveLength(1);
});
test("downloads save binary files into the caller's inbox, returning a usable path without bytes or tokens", async () => {
  const saved: unknown[] = [];
  const s = setup({ read: async () => { throw new Error("not used"); }, save: async (...args) => { saved.push(args); return ".household/inbox/2026-11-14/F123-screenshot.png"; } });
  const id = await s.connect();
  s.api(async url => new URL(url).hostname === "slack.com" ? Response.json({ ok: true, file: { name: "screenshot.png", mimetype: "image/png", url_private_download: "https://files.slack.com/files-pri/F123" } }) : new Response(new Uint8Array([137, 80, 78, 71])));
  const result = await s.service.request({ ...caller, pet: "worker" }, id, "files.download", { file: "F123" });
  expect(saved).toEqual([[{ ...caller, pet: "worker" }, "F123-screenshot.png", Buffer.from([137, 80, 78, 71])]]);
  expect(result.data.path).toBe(".household/inbox/2026-11-14/F123-screenshot.png");
  expect(result.data.size).toBe(4);
  expect(result.trust).toBe("external");
  expect(JSON.stringify(result)).not.toContain("private-token");
});
test("uploads read caller outbox and perform allocation, byte POST, completion without exposing signed URLs", async () => {
  const reads: unknown[] = [];
  const s = setup({ read: async (...args) => { reads.push(args); return new Uint8Array([1, 2, 3]); }, save: async () => { throw new Error("not used"); } });
  s.scopes(["files:write"]);
  const c = await s.service.connect("home", { token: "xoxp-private-token", pets: ["alice"], allowWrite: true });
  s.api(async url => String(url).endsWith("getUploadURLExternal") ? Response.json({ ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/v1/private-signed" }) : new URL(url).hostname === "files.slack.com" ? new Response("OK - 3") : Response.json({ ok: true, files: [{ id: "F123" }] }));
  const result = await s.service.request(caller, c.id, "files.upload", { path: "clips/demo.mp4", channel_id: "C123", thread_ts: "123.456", initial_comment: "Demo" });
  expect(reads).toEqual([[caller, "clips/demo.mp4", 50 * 1024 * 1024]]);
  expect(s.calls).toHaveLength(4);
  expect(new URLSearchParams(s.calls[1]!.init?.body as URLSearchParams).get("filename")).toBe("demo.mp4");
  expect(new URLSearchParams(s.calls[1]!.init?.body as URLSearchParams).get("length")).toBe("3");
  expect(new Headers(s.calls[2]!.init?.headers).has("authorization")).toBe(false);
  expect(await (s.calls[2]!.init?.body as Blob).bytes()).toEqual(new Uint8Array([1, 2, 3]));
  expect(JSON.parse(s.calls[3]!.init?.body as string)).toEqual({ files: [{ id: "F123", title: "demo.mp4" }], channel_id: "C123", thread_ts: "123.456", initial_comment: "Demo" });
  expect(JSON.stringify(result)).not.toContain("private-signed");
});
test("revoking access during outbox read prevents all upload network calls", async () => {
  let resolve!: (bytes: Uint8Array) => void;
  const s = setup({ read: () => new Promise(r => { resolve = r; }), save: async () => "unused" });
  s.scopes(["files:write"]);
  const c = await s.service.connect("home", { token: "xoxp-private-token", pets: ["alice"], allowWrite: true });
  const pending = s.service.request(caller, c.id, "files.upload", { path: "video.mp4" });
  await Bun.sleep(0);
  s.service.setPets("home", c.id, []);
  resolve(new Uint8Array([1]));
  await expect(pending).rejects.toThrow();
  expect(s.calls).toHaveLength(1);
});
