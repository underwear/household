import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { HostNetworkPlane, type Meter } from "../../src/app/host-network-plane";
import type { ProxyLogEntry } from "../../src/infra/proxy-server";
import { AGENT_API_SECRET } from "../../src/app/gateway";
import type { PetKeys, SubjectSpec } from "../../src/app/gateway";
import { ensureCertificates } from "../../src/infra/certificates";
import { PetTokenRegistry } from "../../src/infra/pet-token-registry";
import { tempDir, waitFor } from "../helpers";

/** `resolve`: the DNS a host that may reach public addresses only is looked up in (default: the system's). */
async function setup(resolve?: (host: string) => Promise<string[]>, meter?: Meter) {
  const root = tempDir();
  const { files } = await ensureCertificates(join(root, "upstream"), ["localhost"]);
  const seen: { headers: Record<string, string>; path: string }[] = [];
  const secondChunk = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    tls: { cert: readFileSync(files.leafCert, "utf8"), key: readFileSync(files.leafKey, "utf8") },
    fetch(request) {
      seen.push({ headers: Object.fromEntries(request.headers), path: new URL(request.url).pathname });
      if (new URL(request.url).pathname !== "/stream") return Response.json({ ok: true });
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("one\n"));
          await secondChunk.promise;
          controller.enqueue(new TextEncoder().encode("two\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => Response.json({ headers: Object.fromEntries(request.headers), path: new URL(request.url).pathname }) });
  const tokens = new PetTokenRegistry(join(root, "pet-tokens.json"));
  const sibling = tokens.tokenFor({ house: "work", pet: "sibling" });
  const chair = tokens.tokenFor({ house: "work", pet: "chair" });
  const target = { host: "localhost", port: upstream.port! };
  const spec: SubjectSpec = { subject: { kind: "house", name: "work" }, policy: { kind: "allowlist", allow: [target] }, intercept: [target] };
  const credentials = (secret: string) => [{ target, header: "authorization", prefix: "Bearer ", strip: ["authorization", "x-api-key"], secret }];
  const keys: PetKeys = {
    pets: [{ house: "work", pet: "sibling", credentials: credentials("key.one") }, { house: "work", pet: "chair", credentials: credentials("key.two") }],
    secrets: { "key.one": "first-secret", "key.two": "second-secret" },
  };
  const options = { gatewaySecretsDir: join(root, "secrets"), tlsDir: join(root, "tls"), tokens, guestHost: "127.0.0.1", proxyPort: 0, relayPort: 0,
    upstreamCa: readFileSync(files.caCert, "utf8"), timeouts: { lingerMs: 5, headMs: 1000, connectMs: 1000 }, resolve };
  const plane = new HostNetworkPlane(options);
  /** What the gateway told of its connections and requests, as the daemon's event log hears it. */
  const logged: ProxyLogEntry[] = [];
  const log = () => JSON.stringify(logged);
  await plane.reset((entry) => logged.push(entry), meter);
  const access = { url: api.url.origin, secret: "daemon-secret" };
  const reconcile = (specs = [spec], value = keys) => plane.reconcile(specs, value, access);
  await reconcile();
  const ca = readFileSync(join(options.tlsDir, "ca.crt"), "utf8");
  const proxy = (token?: string) => token ? plane.proxyUrl.replace("http://", `http://household:${token}@`) : plane.proxyUrl;
  const call = (token = sibling, path = "/", headers: Record<string, string> = {}) => fetch(`https://localhost:${upstream.port}${path}`, {
    proxy: proxy(token), headers: { authorization: "Bearer placeholder", ...headers }, tls: { ca }, keepalive: false,
  });
  const stop = async () => { secondChunk.resolve(); await plane.stop(); await api.stop(true); await upstream.stop(true); };
  return { plane, options, tokens, sibling, chair, target, spec, keys, access, reconcile, ca, seen, call, proxy, stop, secondChunk, api, log };
}

test("host network plane authenticates CONNECT and relay by pet tokens, swaps each pet's key and strips House capabilities", async () => {
  const env = await setup();
  try {
    expect(env.plane.proxyUrl).toStartWith("http://127.0.0.1:");
    const status = await env.reconcile();
    expect(status.subjects).toEqual([env.spec]);
    expect(status.subjects[0]).not.toHaveProperty("cidr");
    expect(status.subjects[0]).not.toHaveProperty("network");
    await expect(fetch(`https://localhost:${env.target.port}`, { proxy: env.proxy(), tls: { ca: env.ca } })).rejects.toThrow();
    await expect(env.call("A".repeat(43))).rejects.toThrow();
    expect((await env.call()).status).toBe(200);
    expect((await env.call(env.chair, "/other", { "x-household-token": env.chair, "proxy-authorization": "must-not-leak" })).status).toBe(200);
    expect(env.seen.map(({ headers }) => headers.authorization)).toEqual(["Bearer first-secret", "Bearer second-secret"]);
    expect(env.seen[1]!.headers).not.toHaveProperty("x-household-token");
    expect(env.seen[1]!.headers).not.toHaveProperty("proxy-authorization");
    const spoofed = { "x-household-token": env.sibling, "x-household-house": "other", "x-household-pet": "chair", "x-household-secret": "spoofed" };
    const relayed = await fetch(`${env.plane.relayUrl}/mcp`, { method: "POST", body: "{}", headers: spoofed });
    const echoed = await relayed.json() as { headers: Record<string, string>; path: string };
    expect(echoed.path).toBe("/mcp");
    expect(echoed.headers).toMatchObject({ "x-household-house": "work", "x-household-pet": "sibling", "x-household-secret": "daemon-secret" });
    expect(echoed.headers).not.toHaveProperty("x-household-token");
    expect((await fetch(`${env.plane.relayUrl}/events`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(`${env.plane.relayUrl}/events`, { method: "POST", body: "{}", headers: { "x-household-token": "invalid" } })).status).toBe(403);
    expect(statSync(join(env.options.gatewaySecretsDir, AGENT_API_SECRET)).mode & 0o777).toBe(0o600);
    // Connections and intercepted requests alike reach the log, never a capability or key.
    await waitFor(() => env.log().includes('"kind":"request"'));
    expect(env.log()).toContain('"verdict":"ALLOW"');
    for (const secret of [env.sibling, env.chair, "first-secret", "second-secret", "daemon-secret"]) expect(env.log()).not.toContain(secret);
  } finally { await env.stop(); }
});

test("host reconciliation updates policies and keys immediately, reads refreshed key files and revokes removed pets without IP fallback", async () => {
  const env = await setup();
  try {
    writeFileSync(join(env.options.gatewaySecretsDir, "key.one"), "refreshed-secret", { mode: 0o600 });
    await env.call();
    expect(env.seen.at(-1)!.headers.authorization).toBe("Bearer refreshed-secret");
    const changed: PetKeys = { pets: [env.keys.pets[0]!], secrets: { "key.one": "replacement-secret" } };
    await env.reconcile([env.spec], changed);
    await env.call();
    expect(env.seen.at(-1)!.headers.authorization).toBe("Bearer replacement-secret");
    expect(existsSync(join(env.options.gatewaySecretsDir, "key.two"))).toBe(false);
    expect((await fetch(`${env.plane.relayUrl}/events`, { method: "POST", body: "{}", headers: { "x-household-token": env.chair } })).status).toBe(403);
    await expect(env.call(env.chair)).rejects.toThrow();
    // Expiry remains attached to the live in-memory allowlist, independently of a later reconciliation.
    await env.reconcile([{ ...env.spec, policy: { kind: "allowlist", allow: [{ ...env.target, expiresAt: Date.now() - 1 }] } }], changed);
    await expect(env.call()).rejects.toThrow();
    expect(env.seen).toHaveLength(2);
  } finally { await env.stop(); }
});

test("host TLS host changes drain active model streams and reuse the CA; stop closes all listeners", async () => {
  const env = await setup();
  try {
    const streamed = await env.call(env.sibling, "/stream");
    const reader = streamed.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("one\n");
    const extra = { host: "api.example.org", port: 443 };
    await env.reconcile([{ ...env.spec, intercept: [...env.spec.intercept, extra] }]);
    expect(readFileSync(join(env.options.tlsDir, "ca.crt"), "utf8")).toBe(env.ca);
    env.secondChunk.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("two\n");
    expect((await reader.read()).done).toBe(true);
    const proxyPort = env.plane.proxyPort;
    const relayPort = env.plane.relayPort;
    await env.plane.stop();
    await expect(fetch(`http://127.0.0.1:${relayPort}/events`)).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${proxyPort}`)).rejects.toThrow();
  } finally { await env.stop(); }
});

test("host wildcard policies keep the existing private-address guard", async () => {
  const env = await setup();
  try {
    await env.reconcile([{ ...env.spec, policy: { kind: "allowlist", allow: [{ host: "*", port: "*" }] }, intercept: [] }]);
    // localhost resolves to loopback: wildcard policy cannot reach the host even with a valid capability.
    await expect(env.call()).rejects.toThrow();
    expect(env.seen).toEqual([]);
    await waitFor(() => env.log().includes("DENY"));
  } finally { await env.stop(); }
});

test("published host policies are snapshots; a failed credential publication closes credential access", async () => {
  const env = await setup();
  try {
    const published = await env.reconcile();
    published.subjects[0]!.policy.allow.length = 0;
    env.keys.pets[0]!.credentials.length = 0;
    expect((await env.call()).status).toBe(200);
    const before = env.seen.length;
    env.tokens.entries = () => { throw new Error("registry write failed"); };
    await expect(env.reconcile()).rejects.toThrow("registry write failed");
    expect((await env.call()).status).toBe(403);
    expect(env.seen).toHaveLength(before);
  } finally { await env.stop(); }
});

test("revoking a capability closes its old tunnel permanently while another pet's model stream continues", async () => {
  const env = await setup();
  try {
    const sibling = (await env.call(env.sibling, "/stream")).body!.getReader();
    const chair = (await env.call(env.chair, "/stream")).body!.getReader();
    await sibling.read();
    await chair.read();
    await env.reconcile([env.spec], { pets: [env.keys.pets[0]!], secrets: { "key.one": "first-secret" } });
    await expect(chair.read()).rejects.toThrow();
    env.secondChunk.resolve();
    expect(new TextDecoder().decode((await sibling.read()).value)).toBe("two\n");
    expect((await sibling.read()).done).toBe(true);
    await env.reconcile();
    const replacement = env.tokens.tokenFor({ house: "work", pet: "chair" });
    expect(replacement).not.toBe(env.chair);
    await expect(env.call(env.chair)).rejects.toThrow();
    expect((await env.call(replacement)).status).toBe(200);
  } finally { await env.stop(); }
});

test("a TLS-host publication failure retries with the desired certificate, even when the files already changed", async () => {
  const env = await setup();
  try {
    const extra = { host: "api.example.org", port: 443 };
    const desired = [{ ...env.spec, policy: { kind: "allowlist" as const, allow: [...env.spec.policy.allow, extra] }, intercept: [...env.spec.intercept, extra] }];
    const entries = env.tokens.entries.bind(env.tokens);
    env.tokens.entries = () => { throw new Error("publication failed"); };
    await expect(env.reconcile(desired)).rejects.toThrow("publication failed");
    env.tokens.entries = entries;
    await env.reconcile(desired);
    // A valid TLS handshake reaches the interceptor's no-key guard. No request goes to the real domain.
    const response = await fetch("https://api.example.org/", { proxy: env.proxy(env.sibling), tls: { ca: env.ca }, keepalive: false });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("has no key");
    expect(env.seen).toEqual([]);
  } finally { await env.stop(); }
});

test("temporary access closes an already streaming tunnel at its own deadline without reconciling", async () => {
  const env = await setup();
  try {
    const expiresAt = Date.now() + 300;
    await env.reconcile([{ ...env.spec, policy: { kind: "allowlist", allow: [{ ...env.target, expiresAt }] } }]);
    const reader = (await env.call(env.sibling, "/stream")).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("one\n");
    await expect(reader.read()).rejects.toThrow();
    expect(Date.now()).toBeGreaterThanOrEqual(expiresAt);
    await expect(env.call()).rejects.toThrow();
  } finally { await env.stop(); }
});

test("a permanent allowance keeps the provider stream alive after an overlapping temporary grant expires", async () => {
  const env = await setup();
  try {
    await env.reconcile([{ ...env.spec, policy: { kind: "allowlist", allow: [{ ...env.target, expiresAt: Date.now() + 50 }, env.target] } }]);
    const reader = (await env.call(env.sibling, "/stream")).body!.getReader();
    await reader.read();
    await Bun.sleep(80);
    env.secondChunk.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("two\n");
    expect((await reader.read()).done).toBe(true);
  } finally { await env.stop(); }
});


/** Keep arbitrary application bytes flowing over an authenticated, non-TLS CONNECT tunnel. */
async function rawTunnel(proxyPort: number, token: string, port: number) {
  const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => { received += chunk.toString(); });
  socket.on("error", () => {});
  socket.on("close", () => { closed = true; });
  socket.write(`CONNECT localhost:${port} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`household:${token}`).toString("base64")}\r\n\r\n`);
  await waitFor(() => received.includes("\r\n\r\n") || closed);
  expect(received).toStartWith("HTTP/1.1 200 Connection Established");
  return {
    socket,
    get closed() { return closed; },
    async echo(value: string) {
      const before = received.length;
      socket.write(value);
      await waitFor(() => received.length >= before + value.length || closed);
      expect(closed).toBe(false);
      expect(received.slice(before)).toBe(value);
    },
  };
}

for (const mode of ["expiry", "revoke", "expiry with wildcard", "revoke with wildcard"] as const) {
  test(`raw TCP ${mode} closes the selected port while another port remains connected`, async () => {
    const env = await setup();
    const servers = [net.createServer((socket) => socket.pipe(socket)), net.createServer((socket) => socket.pipe(socket))];
    const tunnels: Awaited<ReturnType<typeof rawTunnel>>[] = [];
    try {
      for (const server of servers) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const ports = servers.map((server) => (server.address() as net.AddressInfo).port);
      expect(ports.every((port) => port !== 443)).toBe(true);
      const expiring = { host: "localhost", port: ports[0]!, expiresAt: Date.now() + 500 };
      const permanent = { host: "localhost", port: ports[1]! };
      const wildcard = mode.includes("wildcard") ? [{ host: "*", port: "*" as const }] : [];
      const subject = { ...env.spec, intercept: [] };
      await env.reconcile([{ ...subject, policy: { kind: "allowlist", allow: [expiring, permanent, ...wildcard] } }]);
      for (const port of ports) tunnels.push(await rawTunnel(env.plane.proxyPort, env.sibling, port));
      await tunnels[0]!.echo("raw application bytes");
      await tunnels[1]!.echo("other port before");
      if (mode.startsWith("revoke")) await env.reconcile([{ ...subject, policy: { kind: "allowlist", allow: [permanent, ...wildcard] } }]);
      await waitFor(() => tunnels[0]!.closed);
      if (mode.startsWith("expiry")) expect(Date.now()).toBeGreaterThanOrEqual(expiring.expiresAt);
      await tunnels[1]!.echo("other port after");
    } finally {
      for (const tunnel of tunnels) tunnel.socket.destroy();
      await env.stop();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
}

/** The proxy's answer to a CONNECT with `token`, up to its head (and a refusal's body). */
async function connectAnswer(proxyPort: number, token: string, target: string): Promise<string> {
  const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
  let received = "";
  let closed = false;
  socket.on("data", (chunk) => { received += chunk.toString(); });
  socket.on("error", () => {});
  socket.on("close", () => { closed = true; });
  socket.write(`CONNECT ${target} HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`household:${token}`).toString("base64")}\r\n\r\n`);
  await waitFor(() => received.startsWith("HTTP/1.1 200") ? received.includes("\r\n\r\n") : closed);
  socket.destroy();
  return received;
}

test("a grant is its pet's own: a housemate is refused it, and revoking it closes only its holder's tunnel", async () => {
  const env = await setup();
  const server = net.createServer((socket) => socket.pipe(socket));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const subject = { ...env.spec, policy: { kind: "allowlist" as const, allow: [] }, intercept: [] };
    // An exact entry with no reach of its own: the per-pet mechanism alone (core tests cover how far a grant reaches).
    await env.reconcile([{ ...subject, grants: [{ pet: "sibling", entry: { host: "localhost", port } }] }]);
    const tunnel = await rawTunnel(env.plane.proxyPort, env.sibling, port);
    await tunnel.echo("sibling's grant");
    expect(await connectAnswer(env.plane.proxyPort, env.chair, `localhost:${port}`)).toEndWith("\r\n\r\nHousehold: not allowed by the network policy\n");
    await env.reconcile([{ ...subject, grants: [{ pet: "chair", entry: { host: "localhost", port } }] }]);
    await waitFor(() => tunnel.closed);
  } finally {
    await env.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SSRF: a chat grant for a name that resolves to loopback is refused; the owner's exact entry still reaches it", async () => {
  // localtest.me: a public name whose DNS answers 127.0.0.1, what a pet would ask for to reach the host's services.
  const env = await setup(async (host) => (host === "localtest.me" ? ["127.0.0.1"] : []));
  const server = net.createServer((socket) => socket.pipe(socket));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const subject = { ...env.spec, policy: { kind: "allowlist" as const, allow: [] }, intercept: [] };
    for (const reach of ["public" as const, { pinned: ["127.0.0.1"] }]) {
      await env.reconcile([{ ...subject, grants: [{ pet: "sibling", entry: { host: "localtest.me", port, reach } }] }]);
      const answer = await connectAnswer(env.plane.proxyPort, env.sibling, `localtest.me:${port}`);
      expect(answer).toStartWith("HTTP/1.1 403 Forbidden");
      expect(answer).not.toContain("127.0.0.1");
    }
    await waitFor(() => env.log().includes("resolves to 127.0.0.1"));
    await env.reconcile([{ ...subject, policy: { kind: "allowlist", allow: [{ host: "localhost", port }] } }]);
    await (await rawTunnel(env.plane.proxyPort, env.sibling, port)).echo("the owner's own host");
  } finally {
    await env.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the allowance meter given at reset is asked before every keyed request and told every answer, through whatever interceptor is live", async () => {
  let hold: ReturnType<NonNullable<Meter["guard"]>>;
  const observed: string[] = [];
  const env = await setup(undefined, {
    guard: (pet) => (pet.pet === "chair" ? hold : undefined),
    observe: (pet, target, headers) => observed.push(`${pet.pet} ${target.host}:${target.port} ${headers.get("content-type")}`),
  });
  try {
    expect((await env.call()).status).toBe(200);
    expect(observed).toEqual([`sibling localhost:${env.target.port} application/json;charset=utf-8`]);
    hold = { reason: "key 'two': its 7d subscription allowance is used up until Mon 16:00; overage is off for it", retryAfterMs: 120_000 };
    const held = await env.call(env.chair);
    expect(held.status).toBe(429);
    expect(held.headers.get("retry-after")).toBe("120");
    expect(await held.text()).toContain("used up until Mon 16:00");
    expect(env.seen).toHaveLength(1); // never went out
    expect(observed).toHaveLength(1);
    hold = undefined;
    expect((await env.call(env.chair)).status).toBe(200);
    expect(observed).toHaveLength(2);
    // A new TLS host set makes a new interceptor: the same meter stays on it.
    const other = { ...env.spec, intercept: [env.target, { host: "example.test", port: 443 }] };
    await env.reconcile([other]);
    hold = { reason: "still used up" };
    expect((await env.call(env.chair)).status).toBe(429);
    expect(env.log()).toContain("still used up");
  } finally { await env.stop(); }
});
