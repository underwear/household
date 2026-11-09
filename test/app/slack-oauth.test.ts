import { expect, test } from "bun:test";
import { SlackConnectors, SLACK_REDIRECT } from "../../src/app/slack-connectors";
import { slackConnectorRoutes } from "../../src/app/slack-connector-routes";
import { SLACK_READ_SCOPES } from "../../src/core/slack-connectors";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";

function setup() {
  let now = 1000, refreshCount = 0;
  let refresh: () => Promise<Response> = async () => Response.json({ ok: true, token_type: "user", access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
  const calls: URLSearchParams[] = [];
  const store = new SqliteStore(":memory:");
  const c = new SlackConnectors(store, async (url, init) => {
    if (String(url).endsWith("oauth.v2.access")) {
      const body = init!.body as URLSearchParams; calls.push(body);
      if (body.has("refresh_token")) { refreshCount++; return refresh(); }
      return Response.json({ ok: true, team: { id: "T123" }, authed_user: { id: "U123", token_type: "user", access_token: "oauth-access", refresh_token: "oauth-refresh", expires_in: 3600 } });
    }
    if (new URL(url).pathname.endsWith("auth.test")) return Response.json({ ok: true, team_id: "T123", user_id: "U123", team: "Team", user: "Igor" }, { headers: { "x-oauth-scopes": SLACK_READ_SCOPES.join(",") } });
    return Response.json({ ok: true, messages: [] });
  }, "123.456", () => now);
  const house: House = { name: "home", pets: [{ name: "alice" }], channels: [], people: { owners: [] }, network: { kind: "allowlist", allow: [] } };
  c.setHouses([house]);
  const begin = () => new URL(c.begin("home", { pets: ["alice"] }, "http://localhost:8780", "session").url);
  const callback = (start: URL) => new URL(`${SLACK_REDIRECT}?state=${start.searchParams.get("state")}&code=secret-code`);
  const connect = async () => { await c.finish(callback(begin()), "session"); return c.list("home").connections[0]!.id; };
  return { c, house, store, calls, begin, callback, connect, advance: () => { now += 3600_000; }, refreshCount: () => refreshCount, refresh: (fn: typeof refresh) => { refresh = fn; } };
}
test("Slack OAuth binds state to owner session and fixed HTTPS callback, uses PKCE without client secret", async () => {
  const s = setup(), start = s.begin();
  expect(start.searchParams.get("scope")).toBe("");
  expect(start.searchParams.get("user_scope")).toContain("search:read");
  expect(start.searchParams.get("code_challenge_method")).toBe("S256");
  for (const origin of ["http://127.0.0.1:8780", "https://household.example.com"]) expect(new URL(s.c.begin("home", { pets: [] }, origin, "session").url).searchParams.get("redirect_uri")).toBe(SLACK_REDIRECT);
  await expect(s.c.finish(s.callback(start), "wrong")).rejects.toThrow("does not match");
  const wrong = s.callback(start); wrong.hostname = "other";
  await expect(s.c.finish(wrong, "session")).rejects.toThrow("does not match");
  await s.c.finish(s.callback(start), "session");
  expect(s.calls[0]!.has("client_secret")).toBe(false);
  expect(s.calls[0]!.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
  expect(JSON.stringify(s.c.list("home"))).not.toContain("oauth-access");
  await expect(s.c.finish(s.callback(start), "session")).rejects.toThrow("does not match");
});
test("pending Slack OAuth expires and is cancelled on workspace reload", async () => {
  const s = setup(), start = s.begin(); s.advance();
  await expect(s.c.finish(s.callback(start), "session")).rejects.toThrow();
  const next = s.begin(); s.c.setHouses([s.house]);
  await expect(s.c.finish(s.callback(next), "session")).rejects.toThrow();
});
test("Slack refresh is single-flight and persists rotated credentials without exposing them", async () => {
  const s = setup(), id = await s.connect(); s.advance();
  await Promise.all([1, 2].map(() => s.c.request({ house: "home", pet: "alice" }, id, "search.messages", { query: "hello" })));
  expect(s.refreshCount()).toBe(1);
  expect(s.store.get("house.connectors.slack.v1")).toContain("new-refresh");
  expect(JSON.stringify(s.c.accounts({ house: "home", pet: "alice" }))).not.toContain("new-refresh");
  s.advance(); s.refresh(async () => Response.json({ ok: false, error: "invalid_refresh_token" }));
  await expect(s.c.request({ house: "home", pet: "alice" }, id, "search.messages", { query: "hello" })).rejects.toThrow();
  expect(s.c.list("home").connections[0]!.needsReconnect).toBe(true);
});
test("disconnect during refresh cannot restore connection or dispatch Slack reads", async () => {
  const s = setup(), id = await s.connect(); s.advance(); let finish!: (r: Response) => void;
  s.refresh(async () => new Promise(r => { finish = r; }));
  const work = s.c.request({ house: "home", pet: "alice" }, id, "search.messages", { query: "hello" });
  s.c.disconnect("home", id);
  finish(Response.json({ ok: true, token_type: "user", access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
  await expect(work).rejects.toThrow();
  expect(s.c.list("home").connections).toEqual([]);
});
test("pasted callback is session and house bound, never fetched, and cannot be replayed", async () => {
  const s = setup(), route = slackConnectorRoutes(s.c);
  s.c.setHouses([s.house, { ...s.house, name: "other" }]);
  const post = (house: string, action: string, body: unknown, session = "session") => route(new Request(`https://household.example.com/api/houses/${house}/connectors/slack/${action}`, { method: "POST", headers: { cookie: `household_session_=${session}` }, body: JSON.stringify(body) }));
  const result = await post("home", "authorize", { pets: ["alice"] });
  expect(result!.headers.get("set-cookie")).toBeNull();
  const start = new URL((await result!.json()).url), url = s.callback(start).href;
  await expect(post("other", "complete", { url })).rejects.toThrow();
  await expect(post("home", "complete", { url }, "wrong")).rejects.toThrow();
  await expect(post("home", "complete", { url: url.replace("agents-household.dev", "evil.test") })).rejects.toThrow();
  expect(s.calls).toHaveLength(0);
  expect((await post("home", "complete", { url }))!.status).toBe(200);
  await expect(post("home", "complete", { url })).rejects.toThrow();
  expect(await route(new Request("https://household.example.com/api/connectors/slack/callback"))).toBeUndefined();
});
