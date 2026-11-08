import { afterAll, expect, test } from "bun:test";
import { serveAgentApi, type PetIdentity } from "../../src/infra/agent-api";

const received: { pet: PetIdentity; path: string; body: string }[] = [];
const api = serveAgentApi({
  port: 0,
  secret: "s3cret",
  handle: async (pet, request) => {
    received.push({ pet, path: new URL(request.url).pathname, body: await request.text() });
    return Response.json({ answer: 42 });
  },
});
afterAll(() => api.stop());

const post = (path: string, headers: Record<string, string>, body = '{"hook_event_name":"Stop"}') =>
  fetch(`http://127.0.0.1:${api.port}${path}`, { method: "POST", headers, body });
const identity = { "x-household-house": "work", "x-household-pet": "sibling" };

test("only requests with the secret and a pet identity reach the handler", async () => {
  expect((await post("/events", identity)).status).toBe(401);
  expect((await post("/events", { ...identity, "x-household-secret": "s3cre" })).status).toBe(401);
  expect((await post("/events", { "x-household-secret": "s3cret" })).status).toBe(400);
  expect(received).toEqual([]);
});

test("the handler gets the pet and the request, whatever the path, and its response goes back", async () => {
  const response = await post("/mcp", { ...identity, "x-household-secret": "s3cret" }, "{}");
  expect(await response.json()).toEqual({ answer: 42 });
  expect(received).toEqual([{ pet: { house: "work", pet: "sibling" }, path: "/mcp", body: "{}" }]);
});
