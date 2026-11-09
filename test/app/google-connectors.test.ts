import { expect, test } from "bun:test";
import { GoogleConnectors } from "../../src/app/google-connectors";
import { googleConnectorTools } from "../../src/app/google-connector-tools";
import { googleConnectorRoutes } from "../../src/app/google-connector-routes";
import { GOOGLE_SCOPES, GOOGLE_WRITE_SCOPES } from "../../src/core/google-connectors";
import { googleRequest } from "../../src/infra/google/operations";
import { boundedText, type GoogleFetch } from "../../src/infra/google/client";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";

const origin = "http://127.0.0.1:7777";
const caller = { house: "home", pet: "alice" };
const allScopes = [...Object.values(GOOGLE_SCOPES), ...Object.values(GOOGLE_WRITE_SCOPES)].flat().join(" ");
function setup() {
  let now = 1000000, refreshCount = 0;
  let subject = "123", email = "me@example.com";
  const calls: { url: string; init?: RequestInit }[] = [];
  let api: GoogleFetch = async () => Response.json({ messages: [] });
  let token: GoogleFetch = async (_url, init) => {
    const params = init!.body as URLSearchParams;
    if (params.get("grant_type") === "refresh_token") refreshCount++;
    return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, scope: allScopes });
  };
  const fetcher: GoogleFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://oauth2.googleapis.com/token") return token(url, init);
    if (String(url).includes("/userinfo")) return Response.json({ sub: subject, email, email_verified: true });
    return api(url, init);
  };
  const house: House = { name: "home", pets: [{ name: "alice" }, { name: "bob" }, { name: "worker", sideworker: { parent: "alice", cwd: "/" } }, { name: "scout", scout: {} as any }], network: { kind: "allowlist", allow: [] }, people: { owners: [] }, channels: [] };
  const store = new SqliteStore(":memory:");
  const service = new GoogleConnectors(store, { id: "client-id", secret: "client-secret" }, fetcher, () => now);
  service.setHouses([house, { ...house, name: "other" }]);
  const begin = (write = false) => new URL(service.begin("home", { services: ["gmail", "drive", "calendar"], pets: ["alice"], write }, origin, "session").url);
  const callback = (start: URL) => new URL(`${start.searchParams.get("redirect_uri")}?code=code&state=${start.searchParams.get("state")}`);
  const connect = async (write = false) => { await service.finish(callback(begin(write)), "session"); return service.list("home").connections.at(-1)!.id; };
  return { service, house, calls, begin, callback, connect, store, identity: (id: string, address: string) => { subject = id; email = address; }, advance: () => { now += 3600_000; }, refreshes: () => refreshCount, api: (f: GoogleFetch) => { api = f; }, token: (f: GoogleFetch) => { token = f; } };
}

test("OAuth uses PKCE, state, exact loopback callback and selected scopes; rejects wrong session and replay", async () => {
  const s = setup(), start = s.begin();
  expect(start.searchParams.get("code_challenge_method")).toBe("S256");
  expect(start.searchParams.get("scope")).toContain("drive.readonly");
  expect(start.searchParams.get("scope")).not.toContain("gmail.modify");
  await expect(s.service.finish(s.callback(start), "another-session")).rejects.toThrow("does not match");
  await s.service.finish(s.callback(start), "session");
  await expect(s.service.finish(s.callback(start), "session")).rejects.toThrow("does not match");
  const exchange = s.calls.find(c => c.url.includes("/token"))!;
  expect((exchange.init!.body as URLSearchParams).get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
  expect(exchange.init!.redirect).toBe("error");
  expect(JSON.stringify(s.service.list("home"))).not.toContain("private-");
});

test("isolates houses and pets; sideworker inherits current grants, scout never gets access", async () => {
  const s = setup(), id = await s.connect();
  expect(s.service.accounts(caller)).toHaveLength(1);
  expect(s.service.accounts({ ...caller, pet: "worker" })).toHaveLength(1);
  for (const denied of [{ ...caller, pet: "bob" }, { ...caller, pet: "scout" }, { ...caller, house: "other" }]) {
    expect(s.service.accounts(denied)).toEqual([]);
    await expect(s.service.request(denied, id, "gmail.messages.list", {})).rejects.toThrow("unavailable");
  }
  s.service.setPets("home", id, ["bob"]);
  expect(s.service.accounts({ ...caller, pet: "worker" })).toEqual([]);
  expect(() => s.service.setPets("home", id, ["scout"])).toThrow("configured bots");
});

test("closed API registry rejects SSRF, traversal, arbitrary parameters, sharing, permanent deletes and excessive pages", () => {
  for (const name of ["https://evil.test", "__proto__", "drive.permissions.create", "drive.files.delete", "gmail.messages.delete"]) expect(() => googleRequest(name, {})).toThrow();
  for (const params of [{ id: ".." }, { id: "a/b" }, { id: "\\x" }, { id: "a", url: "https://evil.test" }]) expect(() => googleRequest("drive.files.get", params)).toThrow();
  expect(() => googleRequest("gmail.messages.list", { maxResults: 1000 })).toThrow();
  const { url } = googleRequest("calendar.events.list", { calendarId: "a@example.com", q: "a&access_token=evil" });
  expect(url.origin).toBe("https://www.googleapis.com");
  expect(url.searchParams.get("access_token")).toBeNull();
  expect(url.searchParams.get("maxResults")).toBe("20");
});

test("requests never accept a token or custom destination; Gmail text is decoded as untrusted data", async () => {
  const s = setup(), id = await s.connect();
  s.api(async () => Response.json({ payload: { mimeType: "text/plain", body: { data: Buffer.from("hello mail").toString("base64url") } } }));
  const result = await s.service.request(caller, id, "gmail.messages.get", { id: "abc" });
  expect(result).toEqual({ trust: "external", data: { payload: { mimeType: "text/plain", body: { data: undefined, text: "hello mail" } } } });
  expect(s.calls.at(-1)!.init!.headers).toEqual({ authorization: "Bearer private-access" });
  expect(s.calls.at(-1)!.init!.redirect).toBe("error");
});

test("refresh is single-flight and durable; reconnect is required after invalid_grant without leaking provider text", async () => {
  const s = setup(), id = await s.connect(); s.advance();
  await Promise.all([s.service.request(caller, id, "gmail.messages.list", {}), s.service.request(caller, id, "drive.files.list", {})]);
  expect(s.refreshes()).toBe(1);
  s.advance();
  s.token(async () => Response.json({ error: "invalid_grant", error_description: "private-refresh" }, { status: 400 }));
  await expect(s.service.request(caller, id, "gmail.messages.list", {})).rejects.toThrow("revoked");
  expect(s.service.list("home").connections[0]!.needsReconnect).toBe(true);
});

test("partial consent exposes only fully granted services and unsupported service requests fail", async () => {
  const s = setup();
  s.token(async () => Response.json({ access_token: "private-access", refresh_token: "private-refresh", scope: GOOGLE_SCOPES.gmail.join(" ") }));
  const id = await s.connect();
  expect(s.service.list("home").connections[0]!.services).toEqual(["gmail"]);
  await expect(s.service.request(caller, id, "drive.files.list", {})).rejects.toThrow("unavailable");
});

test("disconnect prevents a delayed response and cannot resurrect tokens after refresh", async () => {
  const s = setup(), id = await s.connect();
  let resolve!: (response: Response) => void;
  s.api(async () => new Promise(r => { resolve = r; }));
  const reading = s.service.request(caller, id, "gmail.messages.list", {});
  await new Promise(r => setTimeout(r, 0));
  s.service.disconnect("home", id);
  resolve(Response.json({ messages: ["private"] }));
  await expect(reading).rejects.toThrow();
  expect(s.service.list("home").connections).toEqual([]);
  expect(s.store.get("house.connectors.google.v1")).not.toContain("private-refresh");
});

test("reconciliation removes deleted-house tokens and deleted-pet grants, and cancels pending OAuth", async () => {
  const s = setup(), id = await s.connect(), pending = s.begin();
  s.service.setHouses([{ ...s.house, pets: [] }]);
  expect(s.service.list("home").connections[0]!.pets).toEqual([]);
  s.service.setHouses([]);
  s.service.setHouses([s.house]);
  expect(s.service.list("home").connections).toEqual([]);
  await expect(s.service.finish(s.callback(pending), "session")).rejects.toThrow();
  await expect(s.service.request(caller, id, "gmail.messages.list", {})).rejects.toThrow();
});

test("too-large responses cancel streaming; upstream error details stay private", async () => {
  await expect(boundedText(new Response("x".repeat(500)), 100)).rejects.toThrow("too large");
  const s = setup(), id = await s.connect();
  s.api(async () => Response.json({ error: "private-access" }, { status: 403 }));
  await expect(s.service.request(caller, id, "gmail.messages.list", {})).rejects.toThrow("Google returned 403");
});

test("MCP tools discover only allowed operations and use requested namespace", async () => {
  const s = setup(); await s.connect();
  const tools = googleConnectorTools(s.service);
  expect(tools.map(t => t.name)).toEqual(["household_connectors_google_accounts", "household_connectors_google_operations", "household_connectors_google_request"]);
  expect(tools.every(t => t.available!({ ...caller, pet: "scout" }) === false)).toBe(true);
  expect(await tools[1]!.call(caller, {})).toContain("calendar.events.list");
  expect(await tools[0]!.call(caller, {})).not.toContain("private-");
});

test("admin routes do not return tokens; callbacks are one-shot and safe on failure", async () => {
  const s = setup(), route = googleConnectorRoutes(s.service);
  const start = await route(new Request(`${origin}/api/houses/home/connectors/google/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ services: ["gmail"], pets: ["alice"] }) }));
  const auth = new URL((await start!.json()).url);
  const result = await route(new Request(s.callback(auth)));
  expect(result!.status).toBe(303);
  expect(result!.headers.get("location")).toBe("/houses/home/connectors?google=connected");
  const replay = await route(new Request(s.callback(auth)));
  expect(replay!.status).toBe(400);
  expect(await replay!.text()).not.toContain("private-");
  expect(await (await route(new Request(`${origin}/api/houses/home/connectors/google`)))!.text()).not.toContain("private-");
});


test("multiple Google accounts coexist; reconnecting and disconnecting one leaves the others unchanged", async () => {
  const s = setup();
  const first = await s.connect();
  s.identity("456", "work@example.com");
  await s.service.finish(s.callback(s.begin()), "session");
  const second = s.service.list("home").connections.find(c => c.email === "work@example.com")!;
  s.service.setPets("home", second.id, ["bob"]);
  s.identity("123", "me@example.com");
  await s.service.finish(s.callback(s.begin()), "session");
  const accounts = s.service.list("home").connections;
  expect(accounts).toHaveLength(2);
  expect(accounts.find(c => c.email === "work@example.com")).toEqual({ ...second, pets: ["bob"] });
  expect(accounts.find(c => c.email === "me@example.com")!.id).not.toBe(first);
  s.service.disconnect("home", accounts.find(c => c.email === "me@example.com")!.id);
  expect(s.service.list("home").connections).toEqual([{ ...second, pets: ["bob"] }]);
});

test("write asks for the write scopes beside the read ones; a read-only connection refuses changes", async () => {
  const s = setup();
  expect(s.begin(true).searchParams.get("scope")).toContain("gmail.modify");
  expect(s.begin(true).searchParams.get("scope")).toContain("gmail.readonly");
  const id = await s.connect();
  expect(s.service.list("home").connections[0]!.writable).toEqual([]);
  await expect(s.service.request(caller, id, "gmail.messages.send", { to: ["a@example.com"], subject: "hi", text: "x" })).rejects.toThrow("read only");
  expect(JSON.stringify(s.service.catalog(caller))).not.toContain("gmail.messages.send");
});

test("a write scope left unticked keeps its service readable, not writable", async () => {
  const s = setup();
  s.token(async () => Response.json({ access_token: "private-access", refresh_token: "private-refresh", scope: [...Object.values(GOOGLE_SCOPES).flat(), ...GOOGLE_WRITE_SCOPES.calendar].join(" ") }));
  await s.connect(true);
  const c = s.service.list("home").connections[0]!;
  expect(c.services).toEqual(["gmail", "drive", "calendar"]);
  expect(c.writable).toEqual(["calendar"]);
  const names = s.service.catalog(caller).map(o => o.name);
  expect(names).toContain("calendar.events.insert");
  expect(names).not.toContain("drive.files.create");
});

test("sending mail builds the message itself: encoded subject, reply headers, no header injection", async () => {
  const s = setup(), id = await s.connect(true);
  s.api(async () => Response.json({ id: "m1", threadId: "t1" }));
  const result = await s.service.request(caller, id, "gmail.messages.send", { to: ["Игорь <igor@example.com>"], subject: "Привет", text: "body", threadId: "t1", inReplyTo: "<x@mail>" });
  expect(result.data).toEqual({ id: "m1", threadId: "t1" });
  const call = s.calls.at(-1)!;
  expect(call.url).toBe("https://www.googleapis.com/gmail/v1/users/me/messages/send");
  expect(call.init!.method).toBe("POST");
  const sent = JSON.parse(String(call.init!.body));
  expect(sent.threadId).toBe("t1");
  const raw = Buffer.from(sent.raw, "base64url").toString();
  expect(raw).toContain(`To: =?UTF-8?B?${Buffer.from("Игорь").toString("base64")}?= <igor@example.com>`);
  expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("Привет").toString("base64")}?=`);
  expect(raw).toContain("In-Reply-To: <x@mail>");
  expect(() => googleRequest("gmail.messages.send", { to: ["a@example.com"], subject: "x\r\nBcc: evil@example.com", text: "" })).toThrow();
  expect(() => googleRequest("gmail.messages.send", { to: [], text: "" })).toThrow();
});

test("Drive uploads go multipart to the fixed upload path; trash and event deletes report done", async () => {
  const s = setup(), id = await s.connect(true);
  s.api(async () => Response.json({ id: "f1" }));
  await s.service.request(caller, id, "drive.files.create", { name: "Notes", mimeType: "application/vnd.google-apps.document", content: "# Hi", contentType: "text/markdown" });
  const upload = s.calls.at(-1)!;
  expect(new URL(upload.url).pathname).toBe("/upload/drive/v3/files");
  expect(new URL(upload.url).searchParams.get("uploadType")).toBe("multipart");
  expect((upload.init!.headers as Record<string, string>)["content-type"]).toStartWith("multipart/related; boundary=");
  expect(String(upload.init!.body)).toContain("# Hi");
  await s.service.request(caller, id, "drive.files.trash", { id: "f1" });
  expect(JSON.parse(String(s.calls.at(-1)!.init!.body))).toEqual({ trashed: true });
  s.api(async () => new Response(null, { status: 204 }));
  expect((await s.service.request(caller, id, "calendar.events.delete", { id: "e1" })).data).toEqual({ done: true });
  expect(s.calls.at(-1)!.init!.method).toBe("DELETE");
  expect(new URL(s.calls.at(-1)!.url).searchParams.get("sendUpdates")).toBe("none");
});
