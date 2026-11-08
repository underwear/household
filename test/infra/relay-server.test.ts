import { afterAll, beforeAll, expect, test } from "bun:test";
import type { GatewayPolicy } from "../../src/infra/gateway-policy";
import { MAX_BODY_BYTES, startRelay } from "../../src/infra/relay-server";

const seen: { path: string; headers: Record<string, string>; body: string }[] = [];
let gate = Promise.withResolvers<void>();
/** Lets every /stream answer waiting so far finish. */
const release = () => {
  gate.resolve();
  gate = Promise.withResolvers<void>();
};
let upstream: ReturnType<typeof Bun.serve>;
let relay: ReturnType<typeof startRelay>;
let policy: GatewayPolicy;
let secret: string | undefined = "s3cret";

beforeAll(() => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(request.headers), body: await request.text() });
      if (url.pathname === "/slow") {
        await Bun.sleep(11_000); // past Bun's default 10 s idle timeout
        return new Response("late but whole");
      }
      if (url.pathname !== "/stream") return Response.json({ ok: true });
      const wait = gate.promise;
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first;"));
            await wait;
            controller.enqueue(new TextEncoder().encode("second"));
            controller.close();
          },
        }),
      );
    },
  });
  // The gateway's identity seam (in production the pet's token); here, whoever the test says calls.
  relay = startRelay({ host: "127.0.0.1", port: 0, policy: () => policy, identify: () => who, secret: () => secret, bodyDeadlineMs: 300, maxOpenPerPet: 3 });
});

afterAll(() => {
  relay.stop(true);
  upstream.stop(true);
});

const work = { kind: "house", name: "work" } as const;
/** Who the identity seam says is calling. */
let who: { house: string; pet: string } | undefined = { house: "work", pet: "sibling" };
const known = (): GatewayPolicy => ({
  rules: [{ subject: work, policy: { kind: "allowlist", allow: [] }, intercept: [] }],
  tokens: [],
  agentApi: `http://127.0.0.1:${upstream.port}`,
});
const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${relay.port}${path}`, init);

test("identity comes from the gateway's seam; spoofed identity and secret headers are replaced", async () => {
  policy = known();
  seen.length = 0;
  const response = await call("/events?x=1", {
    method: "POST",
    headers: { "x-household-pet": "chair", "x-household-house": "home", "x-household-secret": "guess", "x-other": "kept" },
    body: '{"hook_event_name":"Stop"}',
  });
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([
    {
      path: "/events?x=1",
      body: '{"hook_event_name":"Stop"}',
      headers: expect.objectContaining({
        "x-household-pet": "sibling",
        "x-household-house": "work",
        "x-household-secret": "s3cret",
        "x-other": "kept",
      }),
    },
  ]);
});

test("an unidentified caller is refused; without the agent API's secret nothing goes through", async () => {
  seen.length = 0;
  who = undefined;
  expect((await call("/events", { method: "POST", body: "{}" })).status).toBe(403);
  who = { house: "work", pet: "sibling" };
  policy = known();
  secret = undefined;
  try {
    expect((await call("/events", { method: "POST", body: "{}" })).status).toBe(503);
  } finally {
    secret = "s3cret";
  }
  expect(seen).toEqual([]);
});

test("hop-by-hop headers stay on their hop, including those named in Connection", async () => {
  policy = known();
  seen.length = 0;
  await call("/events", {
    method: "POST",
    headers: { connection: "x-hop", "x-hop": "1", te: "trailers", "proxy-authorization": "x", upgrade: "h2c", "x-end": "kept" },
    body: "{}",
  });
  const headers = Object.keys(seen[0]!.headers);
  expect(headers).toContain("x-end");
  for (const name of ["x-hop", "te", "proxy-authorization", "upgrade"]) expect(headers).not.toContain(name);
});

test("a body over 1 MB is refused before it reaches the daemon", async () => {
  policy = known();
  seen.length = 0;
  expect((await call("/events", { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) })).status).toBe(413);
  expect(seen).toEqual([]);
});

/** A raw connection that sends the headers and part of a body, then stalls. Resolves to what came back and whether the relay hung up. */
async function stalledUpload(): Promise<{ received: string; closed: boolean }> {
  let received = "";
  const { promise: closed, resolve } = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: relay.port!,
    socket: { data: (_, data) => void (received += data.toString()), close: () => resolve() },
  });
  socket.write("POST /events HTTP/1.1\r\nHost: relay\r\nContent-Length: 100\r\n\r\n{\"slow\":");
  const hungUp = await Promise.race([closed.then(() => true), Bun.sleep(3_000).then(() => false)]);
  socket.end();
  return { received, closed: hungUp };
}

test("a body that does not arrive in time is cut off and its connection closed", async () => {
  policy = known();
  seen.length = 0;
  const { received, closed } = await stalledUpload();
  expect(received).toStartWith("HTTP/1.1 408");
  expect(closed).toBe(true);
  expect(seen).toEqual([]);
});

test("a pet has only so many requests open; finished and abandoned ones free their place", async () => {
  policy = known();
  const streams = await Promise.all([call("/stream"), call("/stream"), call("/stream")]);
  expect((await call("/events", { method: "POST", body: "{}" })).status).toBe(429);
  await streams[0]!.body!.cancel(); // the pet hangs up: its place frees while the other two still wait
  for (let tries = 0; (await call("/events", { method: "POST", body: "{}" })).status !== 200; tries++) {
    if (tries > 50) throw new Error("the abandoned request kept its place");
    await Bun.sleep(20);
  }
  release();
  for (const stream of streams.slice(1)) await stream.text();
  const all = await Promise.all([1, 2, 3].map(() => call("/events", { method: "POST", body: "{}" })));
  expect(all.map((response) => response.status)).toEqual([200, 200, 200]);
});

test("responses stream through", async () => {
  policy = known();
  const reader = (await call("/stream")).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first;");
  release();
  let rest = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
  expect(rest).toBe("second");
});

test("a long wait for the answer is not cut", async () => {
  policy = known();
  expect(await (await call("/slow")).text()).toBe("late but whole");
}, 20_000);

test("a hook the agent waits on is relayed at once, while another of the pet's waits for its answer", async () => {
  policy = known();
  const waiting = call("/stream", { method: "POST", body: "{}" }); // e.g. a PermissionRequest held for the person
  const held = await waiting;
  const started = Date.now();
  const payload = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "c1", duration_ms: 1 };
  const answer = await call("/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  expect(await answer.json()).toEqual({ ok: true });
  expect(Date.now() - started).toBeLessThan(250);
  expect(seen.at(-1)).toMatchObject({ path: "/events", body: JSON.stringify(payload) });
  release();
  await held.text();
});
