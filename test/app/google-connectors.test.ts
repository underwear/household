import { expect, test } from "bun:test";
import { GoogleConnectors } from "../../src/app/google-connectors";
import { googleConnectorTools } from "../../src/app/google-connector-tools";
import { googleConnectorRoutes } from "../../src/app/google-connector-routes";
import { GOOGLE_SCOPES } from "../../src/core/google-connectors";
import { googleRequest } from "../../src/infra/google/operations";
import { boundedText, type GoogleFetch } from "../../src/infra/google/client";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";

const origin = "http://127.0.0.1:7777";
const caller = { house: "home", pet: "alice" };
const allScopes = Object.values(GOOGLE_SCOPES).flat().join(" ");
function setup() {
  let now = 1000000, refreshCount = 0;
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
    if (String(url).includes("/userinfo")) return Response.json({ sub: "123", email: "me@example.com", email_verified: true });
    return api(url, init);
  };
  const house: House = { name: "home", pets: [{ name: "alice" }, { name: "bob" }, { name: "worker", sideworker: { parent: "alice", cwd: "/" } }, { name: "scout", scout: {} as any }], network: { kind: "allowlist", allow: [] }, people: { owners: [] }, channels: [] };
  const store = new SqliteStore(":memory:");
  const service = new GoogleConnectors(store, { id: "client-id", secret: "client-secret" }, fetcher, () => now);
  service.setHouses([house, { ...house, name: "other" }]);
  const begin = () => new URL(service.begin("home", { services: ["gmail", "drive", "calendar"], pets: ["alice"] }, origin, "session").url);
  const callback = (start: URL) => new URL(`${start.searchParams.get("redirect_uri")}?code=code&state=${start.searchParams.get("state")}`);
  const connect = async () => { await service.finish(callback(begin()), "session"); return service.list("home").connections[0]!.id; };
  return { service, house, calls, begin, callback, connect, store, advance: () => { now += 3600_000; }, refreshes: () => refreshCount, api: (f: GoogleFetch) => { api = f; }, token: (f: GoogleFetch) => { token = f; } };
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
  expect(() => s.service.setPets("home", id, ["scout"])).toThrow("configured pets");
});

test("closed API registry rejects SSRF, traversal, arbitrary parameters, write operations and excessive pages", () => {
  for (const name of ["https://evil.test", "__proto__", "gmail.messages.send", "drive.permissions.create"]) expect(() => googleRequest(name, {})).toThrow();
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
