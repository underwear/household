import { expect, test } from "bun:test";
import { SlackConnectors } from "../../src/app/slack-connectors";
import { slackConnectorRoutes } from "../../src/app/slack-connector-routes";
import { slackConnectorTools } from "../../src/app/slack-connector-tools";
import { SLACK_READ_SCOPES } from "../../src/core/slack-connectors";
import { slackOperation } from "../../src/infra/slack/operations";
import { slackRead, type SlackFetch } from "../../src/infra/slack/client";
import { mcpHandler } from "../../src/infra/mcp-server";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";

const caller = { house: "home", pet: "alice" };
function setup() {
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
  });
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
  expect(s.service.catalog(caller).map(o => o.name)).toEqual(["search.messages"]);
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
  expect(scopes(false)).not.toContain("chat:write");
  expect(scopes(true)).toContain("chat:write");
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
