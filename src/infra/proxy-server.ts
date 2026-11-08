import net from "node:net";
import { decide, privateReason, type Identify, type PetIdentity, type Subject, type SubjectRule } from "../core/egress";
import { formatEndpoint, parseTarget, within, type Endpoint, type Reach } from "../core/network-policy";
import type { Interceptor, RequestLogEntry } from "./mitm-server";
import { ownAddresses, screenHost, systemResolve, type Resolve } from "./public-resolve";

export interface ConnectLogEntry {
  kind: "connect";
  ts: string;
  verdict: "ALLOW" | "DENY" | "FAIL";
  subject?: Subject;
  /** The pet calling, once identified. */
  pet?: string;
  source: string;
  method: string;
  target: string;
  /** The tunnel goes through the interceptor, which logs each request inside it. */
  intercepted?: boolean;
  /** The address the tunnel went to, for a host that may reach public addresses only (the one checked). */
  address?: string;
  reason?: string;
}

/** What the gateway tells of a connection or an intercepted request: an entry of the Household event log. */
export type ProxyLogEntry = ConnectLogEntry | RequestLogEntry;

export interface ProxyTimeouts {
  /** From accept to a complete request head. */
  headMs: number;
  /** For the upstream TCP connect. Established tunnels have no idle timeout: model streams are long-lived. */
  connectMs: number;
  /** How long an error response may linger before the socket is destroyed. */
  lingerMs: number;
}

export interface ProxyOptions {
  host: string;
  port: number;
  /** Read on every request, so a policy reload applies to the next one. */
  rules: () => SubjectRule[];
  /** Which pet calls (the gateway's one identity seam); asked once per CONNECT. None: refused. */
  identify: Identify;
  /**
   * The host can bind an accepted socket to its capability generation and revoke it later; told once the tunnel's
   * destination is settled: by name (`any`), or the one address checked (`pinned` to it).
   */
  identified?: (socket: net.Socket, pet: PetIdentity, target: Endpoint, opened: Reach) => void;
  /** Where tunnels to hosts whose requests get the caller's key are piped; absent when no subject has such hosts. */
  interceptor?: Interceptor;
  log: (entry: ConnectLogEntry) => void;
  timeouts?: Partial<ProxyTimeouts>;
  /** How a host that may reach public addresses only is resolved (once, before the connect); tests stub it. */
  resolve?: Resolve;
  /** This machine's addresses, never reached but by an exact entry the owner wrote; tests stub it. */
  ownAddresses?: () => string[];
}

const DEFAULT_TIMEOUTS: ProxyTimeouts = { headMs: 10_000, connectMs: 10_000, lingerMs: 2_000 };
const MAX_HEAD_BYTES = 16 * 1024;
const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

/**
 * What a refused caller is told: one fixed line per kind. Why (an address a name resolves to, a resolver's or a
 * connect's error) goes only to the log: a pet must not map the host's network by the answers it gets.
 */
const TOLD = {
  request: "only CONNECT host:port is accepted",
  caller: "not a known pet",
  policy: "not allowed by the network policy",
  gateway: "the gateway cannot open this tunnel",
  unreachable: "cannot reach this host",
};

/**
 * HTTP CONNECT proxy. Parses the request, lets core `decide` judge it and logs every attempt once:
 * ALLOW (tunnel up), DENY (403) or FAIL (allowed, but no tunnel: 502), the reason in the log only. A tunnel to a
 * host whose requests get the caller's key goes to the interceptor instead of straight to the target.
 */
export function startProxy(options: ProxyOptions): Promise<net.Server> {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  // Half-open on both legs: a client may send its FIN and still wait for the reply.
  const server = net.createServer({ allowHalfOpen: true }, (client) => new Connection(client, options, timeouts));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

class Connection {
  private readonly source: string;
  private head = Buffer.alloc(0);
  private readonly headTimer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly client: net.Socket,
    private readonly options: ProxyOptions,
    private readonly timeouts: ProxyTimeouts,
  ) {
    this.source = client.remoteAddress ?? "";
    client.on("error", () => client.destroy());
    client.on("data", this.onData);
    client.on("end", this.onEarlyEnd);
    // Absolute, not idle: a byte every few seconds must not keep a socket of the shared gateway forever.
    this.headTimer = setTimeout(() => {
      this.stopReadingHead();
      this.deny(`no complete request within ${timeouts.headMs} ms`, TOLD.request);
    }, timeouts.headMs);
    client.once("close", () => clearTimeout(this.headTimer));
  }

  private readonly onEarlyEnd = () => this.client.destroy(); // closed without sending a request

  private readonly onData = (chunk: Buffer) => {
    this.head = Buffer.concat([this.head, chunk]);
    const end = this.head.indexOf("\r\n\r\n");
    if (end === -1 && this.head.length <= MAX_HEAD_BYTES) return;
    this.stopReadingHead();
    if (end === -1) return this.deny(`request head larger than ${MAX_HEAD_BYTES} bytes`, TOLD.request);
    const [requestLine = "", ...headerLines] = this.head.subarray(0, end).toString("latin1").split("\r\n");
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    this.handle(requestLine, headers, this.head.subarray(end + 4));
  };

  private stopReadingHead(): void {
    clearTimeout(this.headTimer);
    this.client.off("data", this.onData);
    this.client.off("end", this.onEarlyEnd);
    this.client.pause();
  }

  private handle(requestLine: string, headers: Map<string, string>, rest: Buffer): void {
    const [method = "", target = ""] = requestLine.split(" ");
    const endpoint = method === "CONNECT" ? parseTarget(target) : undefined;
    if (!endpoint) {
      return this.deny("only TCP tunnels through CONNECT host:port are allowed by Household", TOLD.request, { method, target });
    }
    // Who calls, once: the tunnel's every request is that pet's.
    const pet = this.options.identify({ source: this.source, header: (name) => headers.get(name.toLowerCase()) });
    if (!pet) {
      this.log("DENY", { method, target, reason: `${this.source} is not a known pet` });
      // Git/libcurl negotiates proxy authentication: a 403 never prompts it to send its credentials.
      return this.reply("407 Proxy Authentication Required", TOLD.caller, 'Proxy-Authenticate: Basic realm="Household"\r\n');
    }
    const judged = this.judge(pet, endpoint);
    if ("refused" in judged) return this.deny(judged.refused, judged.told, { method, target, subject: judged.subject, pet: pet.pet });
    void this.tunnel(endpoint, pet, rest, judged, { method, target, subject: judged.subject, pet: pet.pet });
  }

  /** The pet's rules, as they are now, on `endpoint`: refused (why, and what it is told), or how to open the tunnel. */
  private judge(pet: PetIdentity, endpoint: Endpoint): Refused | Allowed {
    const decision = decide(this.options.rules(), pet, endpoint);
    if (decision.verdict === "deny") return { refused: decision.reason, told: TOLD.policy, subject: decision.subject };
    const interceptor = decision.intercept ? this.options.interceptor : undefined;
    // The daemon keeps policy and leaf in step, so this means a broken gateway: refuse, don't half-work.
    if (decision.intercept && !interceptor) return { refused: "credential interception is not available on this gateway", told: TOLD.gateway, subject: decision.subject };
    return { subject: decision.subject, interceptor, reach: decision.reach };
  }

  /**
   * Opens the tunnel: to the interceptor or to the host by name (`any`: an exact entry the owner wrote), else to an
   * address checked for it (public; for a pinned grant one of its addresses), the CONNECT judged again once it has
   * resolved.
   */
  private async tunnel(endpoint: Endpoint, pet: PetIdentity, rest: Buffer, allowed: Allowed, request: Request): Promise<void> {
    let state: "connecting" | "open" | "done" = "connecting";
    let upstream: net.Socket | undefined;
    // Before any lookup: a client that leaves while its host resolves is logged once, and nothing is opened for it.
    this.client.once("close", () => {
      if (state === "connecting") this.log("FAIL", { ...request, reason: "client left before the tunnel was up" });
      state = "done";
      upstream?.destroy();
    });
    let address = endpoint.host;
    let opened: Reach = "any";
    let { interceptor } = allowed;
    if (allowed.reach !== "any") {
      // A pinned grant connects only to its own addresses, checked again as DNS answers would be.
      const { reach } = allowed;
      const resolve = typeof reach === "object" ? async () => reach.pinned : this.options.resolve ?? systemResolve;
      const screened = await screenHost(endpoint.host, resolve, this.options.ownAddresses ?? ownAddresses, this.timeouts.connectMs);
      if ((state as string) === "done") return; // the client left meanwhile (its close handler logged it)
      if ("failed" in screened) {
        state = "done";
        this.log("FAIL", { ...request, reason: screened.failed });
        return this.reply("502 Bad Gateway", TOLD.unreachable);
      }
      if ("private" in screened) {
        state = "done";
        return this.deny(privateReason(endpoint, request.subject, screened.private), TOLD.policy, request);
      }
      // A reload while the host resolved applies: the rules as they are now judge the address it would go to.
      opened = { pinned: [screened.address] };
      const again = this.judge(pet, endpoint);
      if ("refused" in again) {
        state = "done";
        return this.deny(again.refused, again.told, { ...request, subject: again.subject });
      }
      if (!within(opened, again.reach)) {
        state = "done";
        return this.deny(`host ${formatEndpoint(endpoint)} may no longer reach ${screened.address}`, TOLD.policy, { ...request, subject: again.subject });
      }
      request = { ...request, subject: again.subject };
      interceptor = again.interceptor;
      address = screened.address;
    }
    this.options.identified?.(this.client, pet, endpoint, opened);
    if (this.client.destroyed) {
      state = "done";
      return this.log("DENY", { ...request, reason: "the caller's capability was revoked" });
    }
    const socket = interceptor
      ? net.connect({ host: "127.0.0.1", port: interceptor.port, allowHalfOpen: true })
      : net.connect({ host: address, port: endpoint.port, allowHalfOpen: true });
    upstream = socket;
    socket.setTimeout(this.timeouts.connectMs, () => socket.destroy(new Error(`no connection within ${this.timeouts.connectMs} ms`)));
    socket.on("error", (error) => {
      if (state !== "connecting") return; // a broken tunnel is torn down by the close handlers
      state = "done";
      this.log("FAIL", { ...request, reason: `cannot reach ${formatEndpoint(endpoint)}: ${error.message}` });
      this.reply("502 Bad Gateway", TOLD.unreachable);
    });
    socket.once("connect", () => {
      state = "open";
      socket.setTimeout(0);
      if (interceptor) {
        // Before any client byte flows, so the interceptor knows the session by the time a request arrives.
        const session = { subject: request.subject, pet, source: this.source, target: endpoint, ...(opened === "any" ? {} : { address }) };
        socket.once("close", interceptor.track(socket.localPort!, session));
      }
      const connected = opened === "any" ? undefined : address;
      this.log("ALLOW", { ...request, intercepted: interceptor ? true : undefined, ...(connected ? { address: connected } : {}) });
      socket.once("close", () => this.client.destroy());
      this.client.write(ESTABLISHED);
      if (rest.length > 0) socket.write(rest);
      // pipe() forwards each FIN as end(); each socket closes once both of its directions have ended.
      this.client.pipe(socket);
      socket.pipe(this.client);
    });
  }

  /** Logs why, and tells the caller only `told`. */
  private deny(reason: string, told: string, fields: LogFields = {}): void {
    this.log("DENY", { ...fields, reason });
    this.reply("403 Forbidden", told);
  }

  /** Sends an error response, then closes for good: a client that never sends its FIN cannot hold the socket. */
  private reply(status: string, told: string, headers = ""): void {
    const body = `Household: ${told}\n`;
    this.client.resume(); // discard whatever else the client sends, so its FIN is seen
    this.client.end(
      `HTTP/1.1 ${status}\r\n${headers}Content-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    setTimeout(() => this.client.destroy(), this.timeouts.lingerMs);
  }

  private log(verdict: ConnectLogEntry["verdict"], fields: LogFields & { reason?: string; intercepted?: boolean; address?: string }): void {
    const { method = "", target = "", ...rest } = fields;
    this.options.log({ kind: "connect", ts: new Date().toISOString(), verdict, source: this.source, method, target, ...rest });
  }
}

/** How a CONNECT that is allowed is opened. */
interface Allowed {
  subject: Subject;
  interceptor?: Interceptor;
  reach: Reach;
}

/** A CONNECT refused: why (logged) and what the caller is told. */
interface Refused {
  refused: string;
  told: string;
  subject?: Subject;
}

type Request = { method: string; target: string; subject: Subject; pet: string };

interface LogFields {
  method?: string;
  target?: string;
  subject?: Subject;
  pet?: string;
}
