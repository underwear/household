import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import tls from "node:tls";
import { join } from "node:path";
import { petCredentials } from "../../src/app/gateway";
import type { SubjectRule } from "../../src/core/egress";
import { ensureCertificates } from "../../src/infra/certificates";
import { startInterceptor, type Interceptor } from "../../src/infra/mitm-server";
import type { GatewayPolicy } from "../../src/infra/gateway-policy";
import { startProxy, type ProxyLogEntry } from "../../src/infra/proxy-server";
import { tempDir } from "../helpers";

// A local HTTPS "upstream" on localhost, a test CA trusted by both the client and the interceptor,
// and the real proxy in front: client → CONNECT → interceptor → upstream. Who calls is the gateway's seam
// (in production the pet's token, once per CONNECT); here the tests say who calls: two pets, two keys. Each call
// opens its own tunnel (no keep-alive), so it is identified anew.

const REAL = "REAL-SECRET-VALUE";
const OTHER = "OTHER-PETS-KEY";
const OWN = "ghp_REAL-OWN-SECRET";
const PLACEHOLDER = "household-secret-github";
const secrets: Record<string, string> = { "key.one": REAL, "key.two": OTHER, "secret.github": OWN };
let policy: GatewayPolicy;
/** Who the identity seam says is calling (in production: the pet's token). */
let who: { house: string; pet: string } | undefined;
const at = (pet: string | undefined) => {
  who = pet ? { house: "work", pet } : undefined;
};
let secretError: Error | undefined;
/** What the meter says of the next request (the gateway's `guard` seam); undefined lets it go. */
let hold: { reason: string; retryAfterMs?: number } | undefined;
/** What the meter was told of each answer (the `observe` seam). */
const observed: { pet: string; target: string; headers: Record<string, string> }[] = [];
const logs: ProxyLogEntry[] = [];
const seen: { path: string; headers: Record<string, string> }[] = [];
let releaseSecondChunk = () => {};
let ca: string;
let upstream: ReturnType<typeof Bun.serve>;
let interceptor: Interceptor;
let proxy: net.Server;
let proxyUrl: string;

beforeAll(async () => {
  const { files } = await ensureCertificates(join(tempDir(), "tls"), ["localhost"]);
  ca = await Bun.file(files.caCert).text();
  const tlsFiles = { cert: await Bun.file(files.leafCert).text(), key: await Bun.file(files.leafKey).text() };
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: tlsFiles,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(request.headers) });
      if (url.pathname !== "/stream") return Response.json({ ok: true });
      const second = new Promise<void>((resolve) => (releaseSecondChunk = resolve));
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          await second;
          controller.enqueue(new TextEncoder().encode("data: two\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const readSecret = (name: string) => {
    if (secretError) throw secretError;
    return secrets[name];
  };
  const target = { host: "localhost", port: upstream.port! };
  const rules: SubjectRule[] = [{ subject: { kind: "house", name: "work" }, policy: { kind: "allowlist", allow: [target] }, intercept: [target] }];
  const wire = { target, header: "authorization", prefix: "Bearer ", strip: ["authorization", "x-api-key"] };
  policy = {
    rules,
    tokens: [],
    keys: [
      { house: "work", pet: "sibling", credentials: [{ ...wire, secret: "key.one" }] },
      { house: "work", pet: "chair", credentials: [{ ...wire, secret: "key.two" }] },
      { house: "work", pet: "keyless", credentials: [] },
      { house: "work", pet: "api", credentials: [{ target, header: "x-api-key", prefix: "", secret: "key.one", strip: ["authorization", "x-api-key"] }] },
      { house: "work", pet: "coder", credentials: [{ target, header: "authorization", prefix: "", secret: "secret.github", strip: [], match: PLACEHOLDER }] },
    ],
  };
  at("sibling");
  interceptor = startInterceptor({
    ...tlsFiles, credentials: (pet, to) => petCredentials(policy, pet, to), readSecret, log: (e) => logs.push(e), upstreamCa: ca,
    guard: () => hold,
    observe: (pet, to, headers) => observed.push({ pet: pet.pet, target: `${to.host}:${to.port}`, headers: Object.fromEntries(headers) }),
  });
  proxy = await startProxy({ host: "127.0.0.1", port: 0, rules: () => rules, identify: () => who, interceptor, log: (e) => logs.push(e) });
  proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
});

afterAll(() => {
  proxy.close();
  interceptor.stop();
  upstream.stop(true);
});

const call = (path: string, headers: Record<string, string> = {}) =>
  fetch(`https://localhost:${upstream.port}${path}`, { proxy: proxyUrl, tls: { ca }, headers, keepalive: false });

test("the credential header is replaced with the secret; other headers, path and query pass", async () => {
  logs.length = 0;
  seen.length = 0;
  const response = await call("/v1/messages?beta=true", {
    authorization: "Bearer placeholder",
    "x-keep": "yes",
    "accept-encoding": "gzip",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([
    {
      path: "/v1/messages?beta=true",
      headers: expect.objectContaining({ authorization: `Bearer ${REAL}`, "x-keep": "yes" }),
    },
  ]);
  expect(logs).toMatchObject([
    { kind: "connect", verdict: "ALLOW", intercepted: true },
    { kind: "request", method: "GET", target: `localhost:${upstream.port}/v1/messages`, status: 200, swapped: true },
  ]);
  expect(JSON.stringify(logs)).not.toContain(REAL);
});

test("two pets on two keys: each request gets its own pet's key, by who calls", async () => {
  seen.length = 0;
  try {
    for (const pet of ["sibling", "chair", "sibling"]) {
      at(pet);
      expect((await call("/v1/messages", { authorization: "Bearer placeholder" })).status).toBe(200);
    }
  } finally {
    at("sibling");
  }
  expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${REAL}`, `Bearer ${OTHER}`, `Bearer ${REAL}`]);
});

test("every credential header goes, exactly the pet's key's is set; a request with none is refused, never sent on", async () => {
  seen.length = 0;
  try {
    at("api");
    expect((await call("/v1/messages", { authorization: "Bearer placeholder", "x-api-key": "placeholder" })).status).toBe(200);
    const refused = await call("/v1/messages", { "x-keep": "yes" });
    expect([refused.status, await refused.text()]).toEqual([403, "Household gateway: the request carries no credential to replace\n"]);
  } finally {
    at("sibling");
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]!.headers["x-api-key"]).toBe(REAL);
  expect(seen[0]!.headers.authorization).toBeUndefined(); // the placeholder never goes on
});

test("fail closed: an unknown caller, a pet without a key, a key missing on the gateway — refused here, never sent", async () => {
  seen.length = 0;
  logs.length = 0;
  const refused = async () => {
    const response = await call("/v1/messages", { authorization: "Bearer placeholder" });
    return { status: response.status, body: await response.text() };
  };
  try {
    at(undefined); // refused at its CONNECT: the proxy says so, fetch fails
    await expect(call("/v1/messages", { authorization: "Bearer placeholder" })).rejects.toThrow();
    at("keyless");
    expect(await refused()).toEqual({ status: 403, body: "Household gateway: bot work/keyless has no key for localhost\n" });
    at("sibling");
    delete secrets["key.one"];
    expect((await refused()).status).toBe(403);
  } finally {
    secrets["key.one"] = REAL;
    at("sibling");
  }
  expect(seen).toEqual([]); // nothing reached upstream, not even the placeholder
  expect(logs.filter((e) => e.kind === "request").map((e) => e.status)).toEqual([403, 403]);
  // Refused at its CONNECT with no credentials: asked for them (407), which the log does not count as a refusal.
  expect(logs.some((e) => e.kind === "connect" && e.verdict === "DENY")).toBe(false);
});


test("streamed responses arrive chunk by chunk", async () => {
  const response = await call("/stream", { authorization: "Bearer placeholder" });
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n"); // before upstream sent the rest
  releaseSecondChunk();
  let rest = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
  expect(rest).toBe("data: two\n\n");
});

/** Opens CONNECT + TLS by hand and sends `requests` one after another on that single connection. */
async function sameConnection(requests: string[]): Promise<string[]> {
  const raw = net.connect((proxy.address() as net.AddressInfo).port, "127.0.0.1");
  await new Promise<void>((resolve) => {
    raw.once("data", () => resolve()); // the 200 Connection Established
    raw.write(`CONNECT localhost:${upstream.port} HTTP/1.1\r\n\r\n`);
  });
  const socket = tls.connect({ socket: raw, servername: "localhost", ca });
  await new Promise<void>((resolve) => socket.once("secureConnect", () => resolve()));
  const responses: string[] = [];
  for (const request of requests) {
    responses.push(
      await new Promise<string>((resolve) => {
        let got = "";
        const onData = (chunk: Buffer) => {
          got += chunk.toString();
          const [head = "", body = ""] = got.split("\r\n\r\n");
          const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? -1);
          if (length >= 0 && Buffer.byteLength(body) >= length) {
            socket.off("data", onData);
            resolve(got);
          }
        };
        socket.on("data", onData);
        socket.write(request);
      }),
    );
  }
  socket.destroy();
  return responses;
}

test("keep-alive: every request on one TLS connection gets the credential", async () => {
  seen.length = 0;
  const request = `GET /again HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer placeholder\r\n\r\n`;
  const responses = await sameConnection([request, request]);
  expect(responses.every((response) => response.startsWith("HTTP/1.1 200"))).toBe(true);
  expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${REAL}`, `Bearer ${REAL}`]);
});

test("an internal error answers a short plain 502, never details", async () => {
  secretError = new Error(`boom ${REAL}`);
  try {
    const response = await call("/v1/messages", { authorization: "Bearer placeholder" });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toBe("Household gateway: upstream request failed\n");
  } finally {
    secretError = undefined;
  }
});

const basic = (text: string) => `Basic ${Buffer.from(text).toString("base64")}`;

test("an owner's secret: its value only where its placeholder stands, as is or in Basic credentials", async () => {
  at("coder");
  seen.length = 0;
  logs.length = 0;
  expect((await call("/user", { authorization: `token ${PLACEHOLDER}` })).status).toBe(200);
  expect((await call("/repo.git/info/refs", { authorization: basic(`x-access-token:${PLACEHOLDER}`) })).status).toBe(200);
  expect((await call("/public", { authorization: "Bearer the-pets-own" })).status).toBe(200); // not ours: untouched
  expect((await call("/anonymous")).status).toBe(200);
  expect(seen.map(({ headers }) => headers.authorization)).toEqual([`token ${OWN}`, basic(`x-access-token:${OWN}`), "Bearer the-pets-own", undefined]);
  expect(logs.filter((entry) => entry.kind === "request").map((entry) => (entry as { swapped: boolean }).swapped)).toEqual([true, true, false, false]);
  expect(JSON.stringify(logs)).not.toContain(OWN);
  at("sibling");
});

test("the request goes to the tunnel's host whatever Host it names; a pet without the secret gets only its own key", async () => {
  at("coder");
  seen.length = 0;
  expect((await call("/user", { authorization: `token ${PLACEHOLDER}`, host: "evil.example" })).status).toBe(200);
  expect(seen).toHaveLength(1); // answered by the upstream the tunnel was opened to
  expect(seen[0]!.headers.host).toBe(`localhost:${upstream.port}`);
  at("sibling");
  seen.length = 0;
  await call("/user", { authorization: `Bearer ${PLACEHOLDER}` });
  expect(seen[0]!.headers.authorization).toBe(`Bearer ${REAL}`); // its key's rule, never another pet's secret
});

test("a screened intercept connects to its pinned IP while preserving Host, SNI and certificate verification", async () => {
  const host = "never-resolve.household.example.com";
  const { files } = await ensureCertificates(join(tempDir(), "pinned-tls"), [host]);
  const trust = await Bun.file(files.caCert).text();
  const tlsFiles = { cert: await Bun.file(files.leafCert).text(), key: await Bun.file(files.leafKey).text() };
  const requests: string[] = [];
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: tlsFiles, fetch(request) {
    requests.push(request.headers.get("host")!);
    return new Response("PINNED_OK");
  } });
  const mitm = startInterceptor({ ...tlsFiles, credentials: () => [], readSecret: () => undefined, log: () => {}, upstreamCa: trust });
  const fetchPinned = async (targetHost: string) => {
    const raw = net.connect(mitm.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { raw.once("connect", resolve); raw.once("error", reject); });
    const untrack = mitm.track(raw.localPort!, { subject: { kind: "house", name: "work" }, pet: { house: "work", pet: "sibling" }, source: "test", target: { host: targetHost, port: remote.port! }, address: "127.0.0.1" });
    const socket = tls.connect({ socket: raw, servername: host, ca: trust });
    await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
    try {
      return await new Promise<string>((resolve, reject) => {
        let result = "";
        socket.on("data", chunk => result += chunk.toString());
        socket.once("end", () => resolve(result));
        socket.once("error", reject);
        socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
    } finally { socket.destroy(); untrack(); }
  };
  try {
    expect(await fetchPinned(host)).toContain("PINNED_OK");
    expect(requests).toEqual([`${host}:${remote.port}`]);
    const invalid = await fetchPinned("wrong.household.example.com");
    expect(invalid).toContain("502");
    expect(invalid).not.toContain("PINNED_OK");
    expect(requests).toHaveLength(1);
  } finally { await mitm.stop(); await remote.stop(true); }
});

test("same-host secrets with prefix-related names select independently in either gateway rule order", async () => {
  const coder = policy.keys!.find(key => key.pet === "coder")!;
  const original = coder.credentials;
  const atlasValue = "SYNTHETIC_ATLAS_CREDENTIAL";
  const atlasPlaceholder = `${PLACEHOLDER}-atlas`;
  const atlas = { ...original[0]!, secret: "secret.github-atlas", match: atlasPlaceholder };
  secrets[atlas.secret] = atlasValue;
  seen.length = 0;
  logs.length = 0;
  const expected: string[] = [];
  try {
    at("coder");
    for (const credentials of [[original[0]!, atlas], [atlas, original[0]!]]) {
      coder.credentials = credentials;
      for (const [placeholder, value] of [[PLACEHOLDER, OWN], [atlasPlaceholder, atlasValue]]) {
        for (const format of [(token: string) => `Bearer ${token}`, (token: string) => basic(`x-access-token:${token}`)]) {
          const response = await call("/multi-secret", { authorization: format(placeholder!) });
          expect(response.status).toBe(200);
          await response.text();
          expected.push(format(value!));
        }
      }
    }
    expect(seen.map(request => request.headers.authorization)).toEqual(expected);
    expect(logs.filter(entry => entry.kind === "request")).toHaveLength(8);
    expect(JSON.stringify(logs)).not.toContain(OWN);
    expect(JSON.stringify(logs)).not.toContain(atlasValue);
  } finally {
    coder.credentials = original;
    delete secrets[atlas.secret];
    at("sibling");
  }
});

test("the meter's seams: a held request answers 429 with retry-after and never goes out; every answer's headers are observed for the pet", async () => {
  at("sibling");
  const before = seen.length;
  hold = { reason: "key 'one': its 7d subscription allowance is used up until Sun 10:00; overage is off for it", retryAfterMs: 90_000 };
  try {
    const held = await call("/v1/messages", { authorization: "Bearer placeholder" });
    expect(held.status).toBe(429);
    expect(held.headers.get("retry-after")).toBe("90");
    expect(await held.text()).toBe("Household gateway: key 'one': its 7d subscription allowance is used up until Sun 10:00; overage is off for it\n");
    expect(seen).toHaveLength(before);
    expect(logs.at(-1)).toMatchObject({ kind: "request", status: 429, pet: "sibling", reason: expect.stringContaining("used up") });
  } finally {
    hold = undefined;
  }
  // An owner's secret (coder's) is not a key: the meter is not asked, nor told.
  at("coder");
  observed.length = 0;
  expect((await call("/own", { authorization: PLACEHOLDER })).status).toBe(200);
  expect(observed).toEqual([]);
  at("sibling");
  expect((await call("/v1/messages", { authorization: "Bearer placeholder" })).status).toBe(200);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ pet: "sibling", target: `localhost:${upstream.port}`, headers: { "content-type": expect.stringContaining("application/json") } });
});
