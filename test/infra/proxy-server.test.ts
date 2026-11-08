import { afterAll, beforeAll, expect, test } from "bun:test";
import net from "node:net";
import type { Caller, SubjectRule } from "../../src/core/egress";
import { parseAllowEntry, type Reach } from "../../src/core/network-policy";
import { startProxy, type ConnectLogEntry } from "../../src/infra/proxy-server";
import { waitFor } from "../helpers";

const work = { kind: "house", name: "work" } as const;
let rules: SubjectRule[] = [];
const logs: ConnectLogEntry[] = [];
let proxy: net.Server;
let echo: net.Server;
let proxyPort: number;
let echoPort: number;
let closedPort: number;
let replyAfterEnd: net.Server;
let replyPort: number;
/** What the proxy asked its identity seam, and whose header (R1's House token) it saw. */
const asked: Caller[] = [];
/** The stub DNS for hosts only a wildcard allows, and what it was asked. */
const dns: Record<string, string[]> = { "rebind.example.net": ["127.0.0.1"], "lan.example.net": ["93.184.215.14", "192.168.1.10"], "localtest.me": ["127.0.0.1"] };
const resolved: string[] = [];
/** Which pet of work calls. */
let pet = "sibling";
/** Where each tunnel was told to go once settled (`identified`). */
const opened: { pet: string; target: string; reach: Reach }[] = [];
/** Whether the host revokes each tunnel it is told of (as for a pet whose token went meanwhile). */
let revoked = false;
/** What a refused pet is told, whatever the reason. */
const NOT_ALLOWED = "Household: not allowed by the network policy\n";

const port = (server: net.Server) => (server.address() as net.AddressInfo).port;

beforeAll(async () => {
  echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoPort = port(echo);
  const closed = net.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  closedPort = port(closed);
  await new Promise((resolve) => closed.close(resolve));
  // Answers only after the client's FIN, like a server that reads the whole request first.
  replyAfterEnd = net.createServer({ allowHalfOpen: true }, (socket) => {
    let got = "";
    socket.on("data", (chunk) => (got += chunk));
    socket.on("end", () => setTimeout(() => socket.end(`reply:${got}`), 20));
  });
  await new Promise<void>((resolve) => replyAfterEnd.listen(0, "127.0.0.1", resolve));
  replyPort = port(replyAfterEnd);
  proxy = await startProxy({
    host: "127.0.0.1",
    port: 0,
    rules: () => rules,
    // The gateway's seam (in production the pet's token): here every caller is pet sibling of work, unless not `known`.
    identify: (caller) => {
      asked.push(caller);
      return known ? { house: "work", pet } : undefined;
    },
    identified: (socket, who, target, reach) => {
      opened.push({ pet: who.pet, target: `${target.host}:${target.port}`, reach });
      if (revoked) socket.destroy();
    },
    // No rule here intercepts a host, so nothing is ever intercepted (see mitm-server.test.ts for that).
    interceptor: { port: 1, track: () => () => {}, stop: () => {} },
    log: (entry) => logs.push(entry),
    timeouts: { headMs: 150, lingerMs: 150, connectMs: 300 },
    resolve: async (host) => {
      resolved.push(host);
      if (host === "slow.example.net") return new Promise<string[]>(() => {}); // a resolver that never answers
      if (host === "reloaded.example.net") {
        useEntries([]); // the daemon reloads while the host resolves: this house allows nothing any more
        return ["93.184.215.14"];
      }
      if (!dns[host]) throw new Error(`ENOTFOUND ${host}`);
      return dns[host];
    },
    ownAddresses: () => [],
  });
  proxyPort = port(proxy);
});

afterAll(() => {
  proxy.close();
  echo.close();
  replyAfterEnd.close();
});

/** Whether the identity seam knows the caller. */
let known = true;

function useRules(allow: string[]): void {
  rules = [
    {
      subject: work,
      policy: {
        kind: "allowlist",
        allow: allow.map((entry) => ({ host: "127.0.0.1", port: Number(entry) })),
      },
      intercept: [],
    },
  ];
  logs.length = 0;
}

/** Sends a raw request head, then optionally a payload once the tunnel is up; resolves with everything received. */
function request(head: string, payload?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (payload && received.endsWith(`\r\n\r\n${payload}`)) socket.end();
      else if (payload && received.startsWith("HTTP/1.1 200") && received.endsWith("\r\n\r\n")) socket.write(payload);
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    socket.write(head);
  });
}

const connect = (target: string, payload?: string) =>
  request(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`, payload);

test("allowed CONNECT tunnels bytes both ways and logs ALLOW", async () => {
  useRules([String(echoPort)]);
  const response = await connect(`127.0.0.1:${echoPort}`, "ping");
  expect(response).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
  expect(logs).toEqual([
    {
      kind: "connect",
      ts: expect.any(String),
      verdict: "ALLOW",
      subject: work,
      pet: "sibling",
      source: "127.0.0.1",
      method: "CONNECT",
      target: `127.0.0.1:${echoPort}`,
      reason: undefined,
    },
  ]);
});

test("bytes sent right behind the CONNECT head are forwarded", async () => {
  useRules([String(echoPort)]);
  const target = `127.0.0.1:${echoPort}`;
  const response = await new Promise<string>((resolve) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.endsWith("early")) socket.end();
    });
    socket.on("close", () => resolve(received));
    socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\nearly`);
  });
  expect(response).toBe("HTTP/1.1 200 Connection Established\r\n\r\nearly");
});

test("a denied host gets a fixed 403; the log says why", async () => {
  useRules([String(echoPort)]);
  const response = await connect("example.com:443");
  expect(response).toStartWith("HTTP/1.1 403 Forbidden\r\n");
  expect(response).toContain(`Content-Length: ${NOT_ALLOWED.length}\r\n`);
  expect(response).toEndWith(`\r\n\r\n${NOT_ALLOWED}`);
  expect(logs).toMatchObject([{ verdict: "DENY", subject: work, target: "example.com:443", reason: "host example.com:443 is not allowed by Household for house 'work'" }]);
});

/** Rules of house work allowing exactly `allow` (allowlist entries, parsed), and its pets' `grants`. */
function useEntries(allow: string[], grants: SubjectRule["grants"] = []): void {
  rules = [{ subject: work, policy: { kind: "allowlist", allow: allow.map((entry) => parseAllowEntry(entry)!) }, grants, intercept: [] }];
  logs.length = 0;
  resolved.length = 0;
  opened.length = 0;
}

test("what only a wildcard allows is resolved once, and refused when an address is private, without telling the pet where", async () => {
  useEntries(["*:*"]);
  for (const [target, address] of [[`rebind.example.net:${echoPort}`, "127.0.0.1"], ["lan.example.net:443", "192.168.1.10"]]) {
    const response = await connect(target!);
    expect(response).toStartWith("HTTP/1.1 403 Forbidden\r\n");
    expect(response).toEndWith(`\r\n\r\n${NOT_ALLOWED}`);
    expect(response).not.toContain(address!);
  }
  expect(resolved).toEqual(["rebind.example.net", "lan.example.net"]);
  expect(logs).toMatchObject([
    { verdict: "DENY", target: `rebind.example.net:${echoPort}`, reason: expect.stringContaining("resolves to 127.0.0.1, which is not on the public internet") },
    { verdict: "DENY", target: "lan.example.net:443", reason: expect.stringContaining("resolves to 192.168.1.10") },
  ]);
  expect(opened).toEqual([]);
});

test("a wildcard never reaches a local name or a private address, and does not resolve it", async () => {
  useEntries(["*:*"]);
  for (const target of [`localhost:${echoPort}`, `127.0.0.1:${echoPort}`, `127.0.0.1.:${echoPort}`, "host.docker.internal:443", "169.254.169.254:80"]) {
    const response = await connect(target);
    expect(response).toEndWith(`\r\n\r\n${NOT_ALLOWED}`);
  }
  expect(resolved).toEqual([]);
  expect(logs.every(({ reason }) => reason?.includes("not on the public internet: only an exact entry the owner wrote reaches a private address"))).toBe(true);
});

test("SSRF: a chat grant of a name that resolves to loopback is refused; the owner's exact entry for it still connects", async () => {
  // localtest.me is a public name whose DNS answers 127.0.0.1: what a pet would ask for to reach the host.
  const target = `localtest.me:${echoPort}`;
  for (const reach of ["public" as const, { pinned: ["127.0.0.1"] }]) {
    useEntries([], [{ pet: "sibling", entry: { host: "localtest.me", port: echoPort, reach } }]);
    const response = await connect(target, "ping");
    expect(response).toBe(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${NOT_ALLOWED.length}\r\nConnection: close\r\n\r\n${NOT_ALLOWED}`);
    expect(logs).toMatchObject([{ verdict: "DENY", target, reason: expect.stringContaining("resolves to 127.0.0.1") }]);
    expect(opened).toEqual([]);
  }
  // The owner's exact entry dials through the system's resolver: localhost, so the test needs no internet DNS
  // (a CI runner's answer for localtest.me need not be 127.0.0.1).
  const exact = `localhost:${echoPort}`;
  useEntries([exact]);
  expect(await connect(exact, "ping")).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
  expect(opened).toEqual([{ pet: "sibling", target: exact, reach: "any" }]);
});

test("a pinned grant goes only to its own addresses: DNS is not asked again, so rebinding after approval changes nothing", async () => {
  dns["flip.example.net"] = ["127.0.0.1"]; // what DNS answers now, after the owner approved 93.184.215.14
  useEntries([], [{ pet: "sibling", entry: { host: "flip.example.net", port: 9, reach: { pinned: ["93.184.215.14"] } } }]);
  revoked = true; // the host closes it once told where it goes: nothing is connected to, here
  await connect("flip.example.net:9").finally(() => (revoked = false));
  expect(resolved).toEqual([]);
  expect(opened).toEqual([{ pet: "sibling", target: "flip.example.net:9", reach: { pinned: ["93.184.215.14"] } }]);
  expect(logs).toMatchObject([{ verdict: "DENY", reason: "the caller's capability was revoked" }]);
});

test("a grant is its pet's only: a housemate is refused it", async () => {
  useEntries([], [{ pet: "sibling", entry: { host: "flip.example.net", port: 9, reach: { pinned: ["93.184.215.14"] } } }]);
  pet = "chair";
  const response = await connect("flip.example.net:9").finally(() => (pet = "sibling"));
  expect(response).toEndWith(`\r\n\r\n${NOT_ALLOWED}`);
  expect(logs).toMatchObject([{ verdict: "DENY", pet: "chair", reason: "host flip.example.net:9 is not allowed by Household for house 'work'" }]);
});

test("a resolver that does not answer in time: 502 and FAIL", async () => {
  useEntries(["*"]);
  const response = await connect("slow.example.net:443");
  expect(response).toStartWith("HTTP/1.1 502 Bad Gateway\r\n");
  expect(response).toEndWith("\r\n\r\nHousehold: cannot reach this host\n");
  expect(logs).toMatchObject([{ verdict: "FAIL", reason: "cannot resolve slow.example.net: timed out after 300 ms" }]);
});

test("a reload while the host resolves applies: the CONNECT is judged again before any connect", async () => {
  useEntries(["*"]);
  const response = await connect("reloaded.example.net:443");
  expect(response).toEndWith(`\r\n\r\n${NOT_ALLOWED}`);
  expect(logs).toMatchObject([{ verdict: "DENY", target: "reloaded.example.net:443", reason: "host reloaded.example.net:443 is not allowed by Household for house 'work'" }]);
});

test("a client that leaves while its host resolves is logged once, and nothing is opened", async () => {
  useEntries(["*"]);
  await new Promise<void>((resolve) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write("CONNECT slow.example.net:443 HTTP/1.1\r\n\r\n"));
    socket.on("error", () => {});
    setTimeout(() => {
      socket.resetAndDestroy();
      resolve();
    }, 50);
  });
  await waitFor(() => logs.length > 0);
  await Bun.sleep(400); // past the resolution deadline: no second line
  expect(logs).toMatchObject([{ verdict: "FAIL", target: "slow.example.net:443", reason: "client left before the tunnel was up" }]);
  expect(logs).toHaveLength(1);
});

test("a name the wildcard allows that does not resolve: 502 and FAIL, the resolver's words in the log only", async () => {
  useEntries(["*"]);
  const response = await connect("nowhere.example.net:443");
  expect(response).toStartWith("HTTP/1.1 502 Bad Gateway\r\n");
  expect(response).not.toContain("ENOTFOUND");
  expect(logs).toMatchObject([{ verdict: "FAIL", reason: "cannot resolve nowhere.example.net: ENOTFOUND nowhere.example.net" }]);
});

test("an unreachable exact host: 502, the connect error in the log only", async () => {
  useRules([String(closedPort)]);
  const response = await connect(`127.0.0.1:${closedPort}`);
  expect(response).toEndWith("\r\n\r\nHousehold: cannot reach this host\n");
  expect(logs).toMatchObject([{ verdict: "FAIL", reason: expect.stringContaining(`cannot reach 127.0.0.1:${closedPort}`) }]);
});

test("an exact entry reaches its private host as before, by name; a trailing dot is the same host", async () => {
  useEntries(["*:*", `localhost:${echoPort}`]);
  expect(await connect(`localhost:${echoPort}`, "ping")).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
  expect(await connect(`localhost.:${echoPort}`, "ping")).toBe("HTTP/1.1 200 Connection Established\r\n\r\nping");
  expect(resolved).toEqual([]);
  expect(logs).toMatchObject([{ verdict: "ALLOW" }, { verdict: "ALLOW", target: `localhost.:${echoPort}` }]);
});

test("a caller the identity seam does not know is denied at its CONNECT", async () => {
  useRules([String(echoPort)]);
  known = false;
  const response = await connect(`127.0.0.1:${echoPort}`).finally(() => (known = true));
  expect(response).toStartWith("HTTP/1.1 407 Proxy Authentication Required\r\n");
  expect(response).toContain('Proxy-Authenticate: Basic realm="Household"\r\n');
  expect(response).toEndWith("\r\n\r\nHousehold: not a known pet\n");
  expect(logs).toEqual([expect.objectContaining({ verdict: "DENY", source: "127.0.0.1", reason: "127.0.0.1 is not a known pet" })]);
});

test("the identity seam is asked once per CONNECT, with its source and its headers (a House token, later)", async () => {
  useRules([String(echoPort)]);
  asked.length = 0;
  const response = await new Promise<string>((resolve) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.endsWith("x")) socket.end();
    });
    socket.on("close", () => resolve(received));
    socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nProxy-Authorization: Bearer house-token\r\n\r\nx`);
  });
  expect(response).toEndWith("x");
  expect(asked).toHaveLength(1);
  expect(asked[0]!.source).toBe("127.0.0.1");
  expect(asked[0]!.header("proxy-authorization")).toBe("Bearer house-token");
});

test("plain HTTP (non-CONNECT) is denied", async () => {
  useRules([String(echoPort)]);
  const response = await request(`GET http://127.0.0.1:${echoPort}/ HTTP/1.1\r\nHost: x\r\n\r\n`);
  expect(response).toStartWith("HTTP/1.1 403 Forbidden\r\n");
  expect(response).toContain("Household: only CONNECT host:port is accepted");
  expect(logs).toMatchObject([{ verdict: "DENY", method: "GET" }]);
});

test("a half-closed client still gets the upstream's reply", async () => {
  useRules([String(replyPort)]);
  const response = await new Promise<string>((resolve) => {
    const socket = net.connect({ port: proxyPort, host: "127.0.0.1", allowHalfOpen: true });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received === "HTTP/1.1 200 Connection Established\r\n\r\n") socket.end("ping");
    });
    socket.on("end", () => resolve(received));
    socket.write(`CONNECT 127.0.0.1:${replyPort} HTTP/1.1\r\n\r\n`);
  });
  expect(response).toBe("HTTP/1.1 200 Connection Established\r\n\r\nreply:ping");
});

/** A client that never sends its FIN: resolves with what it got once the proxy has sent its FIN. */
function stubbornClient(data: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ port: proxyPort, host: "127.0.0.1", allowHalfOpen: true });
    let received = "";
    socket.on("data", (chunk) => (received += chunk));
    socket.on("end", () => resolve(received));
    socket.on("error", () => {});
    if (data) socket.write(data);
  });
}

const openConnections = () => new Promise<number>((resolve) => proxy.getConnections((_, count) => resolve(count)));

test("an incomplete request head times out with a 403", async () => {
  useRules([]);
  expect(await stubbornClient("CONNECT 127.0.0.1:1 HTTP/1.1\r\n")).toStartWith("HTTP/1.1 403 Forbidden\r\n");
  expect(logs).toMatchObject([{ verdict: "DENY", reason: "no complete request within 150 ms" }]);
});

test("an oversize request head is denied and logged", async () => {
  useRules([]);
  expect(await stubbornClient(`CONNECT ${"a".repeat(20_000)}`)).toStartWith("HTTP/1.1 403 Forbidden\r\n");
  expect(logs).toMatchObject([{ verdict: "DENY", reason: "request head larger than 16384 bytes" }]);
});

test("after a 403 the proxy drops the socket even if the client never sends its FIN", async () => {
  useRules([]);
  expect(await stubbornClient("CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain(NOT_ALLOWED);
  await Bun.sleep(300); // lingerMs is 150
  expect(await openConnections()).toBe(0);
});

test("an intercepted secret host under a wildcard is screened before connecting to MITM", async () => {
  useEntries(["*:*"]);
  rules[0]!.intercept = [{ host: "rebind.example.net", port: echoPort }];
  const response = await connect(`rebind.example.net:${echoPort}`);
  expect(response).toStartWith("HTTP/1.1 403 Forbidden");
  expect(resolved).toEqual(["rebind.example.net"]);
  expect(opened).toEqual([]);
});

test("a screened address is handed to MITM and retained for grant expiry", async () => {
  const fakeMitm = net.createServer();
  await new Promise<void>(resolve => fakeMitm.listen(0, "127.0.0.1", resolve));
  const tracked: unknown[] = [];
  const reaches: unknown[] = [];
  const target = { host: "secret.example.com", port: 443 };
  const proxy = await startProxy({ host: "127.0.0.1", port: 0,
    rules: () => [{ subject: work, policy: { kind: "allowlist", allow: [{ ...target, reach: "public" }] }, intercept: [target] }],
    identify: () => ({ house: "work", pet: "sibling" }),
    identified: (_socket, _who, _target, reach) => { reaches.push(reach); },
    interceptor: { port: port(fakeMitm), track: (_port, session) => { tracked.push(session); return () => {}; }, stop: () => {} },
    resolve: async () => ["93.184.215.14"], ownAddresses: () => [], log: () => {},
  });
  const socket = net.connect(port(proxy), "127.0.0.1");
  try {
    const header = await new Promise<string>((resolve, reject) => {
      socket.once("data", data => resolve(data.toString()));
      socket.once("error", reject);
      socket.write("CONNECT secret.example.com:443 HTTP/1.1\r\n\r\n");
    });
    expect(header).toStartWith("HTTP/1.1 200 Connection Established");
    expect(tracked).toEqual([expect.objectContaining({ target, address: "93.184.215.14" })]);
    expect(reaches).toEqual([{ pinned: ["93.184.215.14"] }]);
  } finally { socket.destroy(); proxy.close(); fakeMitm.close(); }
});
