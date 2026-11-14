import { ConnectorWrites, type ConnectorWriteApproval } from "../../src/app/connector-writes";
import { expect, test } from "bun:test";
import { MicrosoftConnectors } from "../../src/app/microsoft-connectors";
import { microsoftConnectorTools } from "../../src/app/microsoft-connector-tools";
import { microsoftConnectorRoutes } from "../../src/app/microsoft-connector-routes";
import { microsoftRequest, microsoftPage } from "../../src/infra/microsoft/operations";
import { microsoftText, type MicrosoftFetch } from "../../src/infra/microsoft/client";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";

const caller = { house: "home", pet: "alice" };
test("Microsoft modes gate mutations and cancel a pending write when access changes", async () => {
  let answer!: (v: "approved") => void, cards = 0;
  const s = setup({ ask: async () => { cards++; return new Promise(r => { answer = r; }); } }), id = await s.connect(true);
  s.service.setPets("home", id, ["alice"], "approval");
  const count = s.calls.length;
  const pending = s.service.request(caller, id, "todo.lists.create", { displayName: "New list" }, undefined, "create-1");
  expect(s.calls).toHaveLength(count); expect(cards).toBe(1);
  answer("approved"); await pending;
  expect(s.calls).toHaveLength(count + 1);
  const cancelled = s.service.request(caller, id, "todo.lists.create", { displayName: "Another" }, undefined, "create-2");
  s.service.setPets("home", id, ["alice"], "disabled");
  await expect(cancelled).rejects.toThrow("cancelled"); answer("approved");
  expect(s.calls).toHaveLength(count + 1);
  expect(s.service.catalog(caller).some(o => o.write)).toBe(false);
  await expect(s.service.request(caller, id, "todo.lists.create", { displayName: "Blocked" })).rejects.toThrow();
  s.service.setPets("home", id, ["alice"], "auto");
  await s.service.request(caller, id, "todo.lists.create", { displayName: "Automatic" });
  expect(cards).toBe(2);
  const readOnly = await s.connect(); s.service.setPets("home", readOnly, ["alice"], "auto");
  await expect(s.service.request(caller, readOnly, "todo.lists.create", { displayName: "No grant" })).rejects.toThrow();
});

test("Microsoft approval enrollment requests Tasks.ReadWrite", async () => {
  const s = setup(), p = await s.service.begin("home", { pets: ["alice"], writePolicy: "approval" }, "session");
  expect((s.calls[0]!.init!.body as URLSearchParams).get("scope")).toContain("Tasks.ReadWrite");
  s.advance(); await s.service.poll("home", p.id, "session");
  expect(s.service.accounts(caller)[0]!.writePolicy).toBe("approval");
});

test("Microsoft approval uses tokens refreshed by a read while the card was pending", async () => {
  let answer!: (v: "approved") => void;
  const s = setup({ ask: async () => new Promise(r => { answer = r; }) }), id = await s.connect(true);
  s.service.setPets("home", id, ["alice"], "approval"); s.advance(3_600_000);
  const refreshed: string[] = [];
  s.token(async (_url, init) => {
    refreshed.push((init!.body as URLSearchParams).get("refresh_token")!);
    return refreshed.length === 1 ? Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: "User.Read Tasks.ReadWrite" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
  });
  const pending = s.service.request(caller, id, "todo.lists.create", { displayName: "After approval" }, undefined, "rotate");
  await s.service.request(caller, id, "todo.lists.list", {});
  answer("approved"); await pending;
  expect(refreshed).toEqual(["private-refresh"]);
  expect(new Headers(s.calls.at(-1)!.init!.headers).get("authorization")).toBe("Bearer rotated-access");
  expect(s.service.list("home").connections[0]!.needsReconnect).toBe(false);
});
function setup(approval?: ConnectorWriteApproval) {
  let now = 1_000_000, refreshes = 0, identity = "account-1";
  const calls: { url: string; init?: RequestInit }[] = [];
  let api: MicrosoftFetch = async () => Response.json({ value: [] });
  let token: MicrosoftFetch = async (_url, init) => {
    if ((init!.body as URLSearchParams).get("grant_type") === "refresh_token") refreshes++;
    return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, scope: "User.Read Tasks.ReadWrite" });
  };
  const fetcher: MicrosoftFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/devicecode")) return Response.json({ device_code: "private-device", user_code: "ABCD-EFGH", verification_uri: "https://login.microsoft.com/device", expires_in: 900, interval: 5 });
    if (String(url).endsWith("/token")) return token(url, init);
    if (String(url).includes("/me?$select=")) return Response.json({ id: identity, mail: `${identity}@example.com`, displayName: "Owner" });
    return api(url, init);
  };
  const house: House = { name: "home", pets: [{ name: "alice" }, { name: "bob" }, { name: "worker", sideworker: { parent: "alice", cwd: "/" } }, { name: "scout", scout: {} as any }], network: { kind: "allowlist", allow: [] }, people: { owners: [] }, channels: [] };
  const store = new SqliteStore(":memory:");
  const writes = new ConnectorWrites(store, approval);
  const service = new MicrosoftConnectors(store, { id: "client-id" }, fetcher, () => now, writes);
  service.setHouses([house, { ...house, name: "other" }]);
  const advance = (ms = 5000) => { now += ms; };
  const begin = (write = false) => service.begin("home", { pets: ["alice"], write }, "session");
  const connect = async (write = false) => { const p = await begin(write); advance(); await service.poll("home", p.id, "session"); return service.list("home").connections.at(-1)!.id; };
  return { writes, service, store, house, calls, begin, connect, advance, refreshes: () => refreshes, api: (f: MicrosoftFetch) => { api = f; }, token: (f: MicrosoftFetch) => { token = f; }, identity: (s: string) => { identity = s; } };
}

test("device enrollment asks for least privilege, no secret or callback; device code and tokens stay on host", async () => {
  const s = setup(), p = await s.begin();
  expect(p.userCode).toBe("ABCD-EFGH");
  expect(p.verificationUri).toBe("https://login.microsoft.com/device");
  expect(JSON.stringify(p)).not.toContain("private-");
  const params = s.calls[0]!.init!.body as URLSearchParams;
  expect(params.get("scope")).toBe("offline_access User.Read Tasks.Read");
  expect(params.has("client_secret")).toBe(false);
  expect(params.has("redirect_uri")).toBe(false);
  s.advance(); await s.service.poll("home", p.id, "session");
  const exchange = s.calls.find(c => c.url.endsWith("/token"))!.init!.body as URLSearchParams;
  expect(exchange.get("device_code")).toBe("private-device");
  expect(exchange.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  expect(JSON.stringify(s.service.list("home"))).not.toContain("private-");
});

test("enrollment is session/workspace bound, expires, and cannot be replayed", async () => {
  const s = setup(), p = await s.begin(); s.advance();
  await expect(s.service.poll("home", p.id, "wrong-session")).rejects.toThrow("does not match");
  await expect(s.service.poll("other", p.id, "session")).rejects.toThrow("does not match");
  expect(() => s.service.cancel("other", p.id, "session")).toThrow();
  await s.service.poll("home", p.id, "session");
  await expect(s.service.poll("home", p.id, "session")).rejects.toThrow();
  const expired = await s.begin(); s.advance(901_000);
  await expect(s.service.poll("home", expired.id, "session")).rejects.toThrow("expired");
});

test("server enforces polling interval and slow_down even if clients hammer poll", async () => {
  const s = setup(), p = await s.begin();
  expect(await s.service.poll("home", p.id, "session")).toEqual({ status: "pending", interval: 5 });
  expect(s.calls.filter(c => c.url.endsWith("/token"))).toHaveLength(0);
  s.token(async () => Response.json({ error: "slow_down", error_description: "private-device" }, { status: 400 }));
  s.advance(); expect(await s.service.poll("home", p.id, "session")).toEqual({ status: "pending", interval: 10 });
  s.advance(); await s.service.poll("home", p.id, "session");
  expect(s.calls.filter(c => c.url.endsWith("/token"))).toHaveLength(1);
});

test("single-flight polling, cancellation and reconciliation cannot save a late token", async () => {
  const s = setup(), p = await s.begin(); s.advance();
  let resolve!: (r: Response) => void;
  s.token(async () => new Promise(r => { resolve = r; }));
  const polling = s.service.poll("home", p.id, "session");
  expect((await s.service.poll("home", p.id, "session")).status).toBe("pending");
  expect(s.calls.filter(c => c.url.endsWith("/token"))).toHaveLength(1);
  s.service.cancel("home", p.id, "session");
  resolve(Response.json({ access_token: "private-late", refresh_token: "private-refresh", scope: "Tasks.Read" }));
  await expect(polling).rejects.toThrow();
  expect(s.service.list("home").connections).toEqual([]);
  const next = await s.begin(); s.service.setHouses([{ ...s.house, pets: [] }]);
  await expect(s.service.poll("home", next.id, "session")).rejects.toThrow();
});

test("denied consent and provider errors are sanitized", async () => {
  const s = setup(), p = await s.begin(); s.advance();
  s.token(async () => Response.json({ error: "authorization_declined", error_description: "private-device private-access" }, { status: 400 }));
  await expect(s.service.poll("home", p.id, "session")).rejects.toThrow("declined");
  await expect(s.service.poll("home", p.id, "session")).rejects.not.toThrow("private-");
});

test("isolates houses/bots, inherits parent grants and revokes disabled bots", async () => {
  const s = setup(), id = await s.connect();
  expect(s.service.accounts(caller)).toHaveLength(1);
  expect(s.service.accounts({ ...caller, pet: "worker" })).toHaveLength(1);
  for (const denied of [{ ...caller, pet: "bob" }, { ...caller, pet: "scout" }, { ...caller, house: "other" }]) {
    expect(s.service.accounts(denied)).toEqual([]);
    await expect(s.service.request(denied, id, "todo.lists.list", {})).rejects.toThrow("unavailable");
  }
  expect(() => s.service.setPets("home", id, ["scout"])).toThrow();
  s.service.setHouses([{ ...s.house, pets: s.house.pets.map(p => p.name === "alice" ? { ...p, enabled: false } : p) }]);
  expect(s.service.accounts({ ...caller, pet: "worker" })).toEqual([]);
});

test("write needs explicit opt-in AND granted scope, catalog respects per-account rights", async () => {
  const s = setup(), id = await s.connect();
  expect(s.service.list("home").connections[0]!.writable).toBe(false);
  await expect(s.service.request(caller, id, "todo.tasks.create", { listId: "l", title: "Task" })).rejects.toThrow("read only");
  expect(s.service.catalog(caller).map(o => o.name)).not.toContain("todo.tasks.create");
  s.token(async () => Response.json({ access_token: "a", refresh_token: "r", scope: "Tasks.Read" }));
  await s.connect(true);
  expect(s.service.list("home").connections[0]!.writable).toBe(false);
});

test("task lifecycle uses fixed Graph URLs and exact JSON fields, including optimistic concurrency", async () => {
  const s = setup(), id = await s.connect(true);
  s.api(async () => Response.json({ id: "t" }));
  await s.service.request(caller, id, "todo.tasks.create", { listId: "l=", title: "Task", dueDateTime: { dateTime: "2026-11-13T10:00:00", timeZone: "Europe/Madrid" } });
  const create = s.calls.at(-1)!;
  expect(create.url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/l%3D/tasks");
  expect(create.init!.method).toBe("POST");
  expect(JSON.parse(String(create.init!.body))).not.toHaveProperty("listId");
  s.api(async () => new Response(null, { status: 204 }));
  const result = await s.service.request(caller, id, "todo.tasks.update", { listId: "l", taskId: "t", changes: { status: "completed" }, ifMatch: 'W/"v1"' });
  expect(result).toEqual({ trust: "external", data: { done: true } });
  expect((s.calls.at(-1)!.init!.headers as Record<string, string>)["if-match"]).toBe('W/"v1"');
  expect(JSON.parse(String(s.calls.at(-1)!.init!.body))).toEqual({ status: "completed" });
});

test("closed registry and continuation tokens cannot forward credentials, traverse resources or grow pages", () => {
  for (const name of ["https://evil.test", "__proto__", "users.list", "todo.tasks.move"]) expect(() => microsoftRequest(name, {})).toThrow();
  for (const listId of ["..", "a/b", "\\x", "x\n"]) expect(() => microsoftRequest("todo.tasks.get", { listId, taskId: "t" })).toThrow();
  expect(() => microsoftRequest("todo.tasks.list", { listId: "l", headers: { authorization: "x" } })).toThrow();
  expect(() => microsoftRequest("todo.tasks.update", { listId: "l", taskId: "t", changes: {} })).toThrow();
  expect(() => microsoftRequest("todo.tasks.list", { listId: "l", top: 500 })).toThrow();
  const url = microsoftRequest("todo.tasks.list", { listId: "l" }).url;
  const next = "https://graph.microsoft.com/v1.0/me/todo/lists/l/tasks?$top=20&$skiptoken=abc%2Bdef";
  const data = microsoftPage({ value: [], "@odata.nextLink": next }, url);
  expect(microsoftRequest("todo.tasks.list", { listId: "l", pageToken: data.nextPageToken }).url.toString()).toBe(next);
  for (const bad of ["https://evil.test/v1.0/me/todo/lists/l/tasks", "https://graph.microsoft.com/v1.0/users", next + "&access_token=secret", next.replace("$top=20", "$top=500"), next.replace("/lists/l/", "/lists/other/")]) {
    expect(() => microsoftRequest("todo.tasks.list", { listId: "l", pageToken: Buffer.from(bad).toString("base64url") })).toThrow();
  }
});

test("refresh is single-flight, persists rotated refresh token, revocation requests reconnect", async () => {
  const s = setup(), id = await s.connect(true); s.advance(3600_000);
  await Promise.all([s.service.request(caller, id, "todo.lists.list", {}), s.service.request(caller, id, "todo.tasks.list", { listId: "l" })]);
  expect(s.refreshes()).toBe(1);
  s.advance(3600_000);
  s.token(async () => Response.json({ error: "invalid_grant", error_description: "private-refresh" }, { status: 400 }));
  await expect(s.service.request(caller, id, "todo.lists.list", {})).rejects.toThrow("revoked");
  expect(s.service.list("home").connections[0]!.needsReconnect).toBe(true);
});

test("refresh cannot resurrect a disconnected account or silently retain write after scope downgrade", async () => {
  const s = setup(), id = await s.connect(true); s.advance(3600_000);
  s.token(async () => Response.json({ access_token: "a2", refresh_token: "r2", scope: "Tasks.Read" }));
  await expect(s.service.request(caller, id, "todo.tasks.create", { listId: "l", title: "T" })).rejects.toThrow("read only");
  expect(s.store.get("house.connectors.microsoft.v1")).toContain("r2");
  s.advance(3600_000);
  let resolve!: (r: Response) => void;
  s.token(async () => new Promise(r => { resolve = r; }));
  const reading = s.service.request(caller, id, "todo.lists.list", {});
  s.service.disconnect("home", id);
  resolve(Response.json({ access_token: "late", refresh_token: "resurrected", scope: "Tasks.Read" }));
  await expect(reading).rejects.toThrow();
  expect(s.store.get("house.connectors.microsoft.v1")).toBe("[]");
});

test("grant removal cancels in-flight reads even when upstream ignores abort", async () => {
  const s = setup(), id = await s.connect();
  let resolve!: (r: Response) => void;
  s.api(async () => new Promise(r => { resolve = r; }));
  const reading = s.service.request(caller, id, "todo.lists.list", {});
  await new Promise(r => setTimeout(r, 0));
  s.service.setPets("home", id, ["bob"]);
  resolve(Response.json({ value: ["private task"] }));
  await expect(reading).rejects.toThrow();
});

test("uncertain writes are never retried; throttling and concurrency errors have actionable messages", async () => {
  const s = setup(), id = await s.connect(true);
  s.api(async () => { throw new Error("private-access"); });
  const before = s.calls.length;
  await expect(s.service.request(caller, id, "todo.tasks.create", { listId: "l", title: "T" })).rejects.toThrow("may have happened");
  expect(s.calls.length - before).toBe(1);
  s.api(async () => Response.json({ error: { message: "private" } }, { status: 429, headers: { "retry-after": "12" } }));
  await expect(s.service.request(caller, id, "todo.lists.list", {})).rejects.toThrow("12 seconds");
  s.api(async () => new Response(null, { status: 412 }));
  await expect(s.service.request(caller, id, "todo.tasks.update", { listId: "l", taskId: "t", changes: { title: "T" } })).rejects.toThrow("changed");
  await expect(microsoftText(new Response("x".repeat(500)), 100)).rejects.toThrow("too large");
});

test("separate accounts coexist, reconnect replaces only that account, house removal deletes tokens", async () => {
  const s = setup(), first = await s.connect();
  s.identity("account-2"); const second = await s.connect(true);
  s.identity("account-1"); await s.connect(true);
  const accounts = s.service.list("home").connections;
  expect(accounts).toHaveLength(2);
  expect(accounts.some(c => c.id === first)).toBe(false);
  expect(accounts.some(c => c.id === second)).toBe(true);
  s.service.setHouses([]); s.service.setHouses([s.house]);
  expect(s.service.list("home").connections).toEqual([]);
});

test("owner API exposes only user code; tool namespace and schemas are discoverable without secrets", async () => {
  const s = setup(), route = microsoftConnectorRoutes(s.service), url = "http://127.0.0.1:7777/api/houses/home/connectors/microsoft";
  const start = await route(new Request(`${url}/authorize`, { method: "POST", body: JSON.stringify({ pets: ["alice"], write: true }) }));
  expect(start!.headers.get("cache-control")).toBe("no-store");
  const p = await start!.json(); s.advance();
  const result = await route(new Request(`${url}/poll`, { method: "POST", body: JSON.stringify({ id: p.id }) }));
  expect(await result!.json()).toEqual({ status: "connected" });
  expect(await (await route(new Request(url)))!.text()).not.toContain("private-");
  const tools = microsoftConnectorTools(s.service);
  expect(tools.map(t => t.name)).toEqual(["household_connectors_microsoft_accounts", "household_connectors_microsoft_operations", "household_connectors_microsoft_request"]);
  expect(tools.every(t => !t.available!({ ...caller, pet: "scout" }))).toBe(true);
  expect(await tools[1]!.call(caller, {})).toContain("todo.tasks.create");
  expect(await tools[0]!.call(caller, {})).not.toContain("private-");
});


test("Graph continuations accept equivalent escaped IDs but always keep bounded page size", () => {
  const token = Buffer.from("https://graph.microsoft.com/v1.0/me/todo/lists/AQ==/tasks?$skiptoken=next").toString("base64url");
  const request = microsoftRequest("todo.tasks.list", { listId: "AQ==", pageToken: token });
  expect(request.url.pathname).toBe("/v1.0/me/todo/lists/AQ%3D%3D/tasks");
  expect(request.url.searchParams.get("$top")).toBe("20");
});

test("plain-text task bodies become escaped HTML on create and update", () => {
  const create = microsoftRequest("todo.tasks.create", { listId: "l", title: "T", body: { content: "<script>&\nsecond" } });
  expect(JSON.parse(create.init.body!).body).toEqual({ contentType: "html", content: "<div>&lt;script&gt;&amp;<br>second</div>" });
  const update = microsoftRequest("todo.tasks.update", { listId: "l", taskId: "t", changes: { body: { content: "a < b", contentType: "text" } } });
  expect(JSON.parse(update.init.body!).body.content).toBe("<div>a &lt; b</div>");
});
