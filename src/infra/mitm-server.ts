import type { CredentialRule, PetIdentity, Subject } from "../core/egress";
import { formatEndpoint, type Endpoint } from "../core/network-policy";
import { fillPlaceholder } from "../core/secrets";

/** Who is behind an intercepted tunnel (identified once, at its CONNECT) and where it goes. */
export interface InterceptSession {
  subject: Subject;
  pet: PetIdentity;
  source: string;
  target: Endpoint;
  /** The address screened by CONNECT; when present, upstream must never resolve the name again. */
  address?: string;
}

export interface RequestLogEntry {
  kind: "request";
  ts: string;
  subject: Subject;
  pet: string;
  source: string;
  method: string;
  /** host:port and path, without the query. */
  target: string;
  status: number;
  /** Whether a credential was filled in. */
  swapped: boolean;
  reason?: string;
}

export interface Interceptor {
  /** Local port of the TLS server that intercepted tunnels are piped into. */
  port: number;
  /** Binds the tunnel arriving from local port `localPort` to its session. Returns the unbind function. */
  track(localPort: number, session: InterceptSession): () => void;
  /** Default: close every tunnel; false: stop accepting while active response streams finish. */
  stop(force?: boolean): void | Promise<void>;
}

export interface InterceptorOptions {
  /** PEM leaf certificate and key for the intercepted hosts. */
  cert: string;
  key: string;
  /**
   * Asked on every request (a key that changes applies at once): what to fill in for the tunnel's pet on requests
   * to `target` (its key's rules), or why nothing (a pet without a key): the request is then refused, never sent.
   */
  credentials: (pet: PetIdentity, target: Endpoint) => CredentialRule[] | { refused: string };
  /** A secret's value; undefined when it is missing (the request is then refused, never sent with the placeholder). */
  readSecret: (name: string) => string | undefined;
  log: (entry: RequestLogEntry) => void;
  /** Extra CA to trust upstream; only tests need it. */
  upstreamCa?: string;
  /**
   * Asked right before a request with the pet's key goes out: why it must not (the key's allowance is used up, say),
   * or undefined. A refusal answers 429 with when to try again, never reaches the host.
   */
  guard?: (pet: PetIdentity, target: Endpoint) => { reason: string; retryAfterMs?: number } | undefined;
  /** Told every answer's headers from `target` for the pet (what the host says of the key's allowance). */
  observe?: (pet: PetIdentity, target: Endpoint, headers: Headers) => void;
}

// Hop-by-hop headers, plus accept-encoding: fetch negotiates compression itself and hands us decoded bodies,
// which is also why content-encoding and content-length must not be copied back.
const DROPPED_REQUEST_HEADERS = ["host", "connection", "proxy-connection", "proxy-authorization", "x-household-token", "keep-alive", "transfer-encoding", "accept-encoding"];
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection"];

/**
 * Terminates TLS for intercepted tunnels and replays each request to the real host with the tunnel's pet's
 * credentials in place of whatever credential headers it sent; fails closed: a request whose pet has none, whose
 * secret is missing, or that sent no credential header, is refused here. An owner's secret is filled in only
 * where its placeholder stands; the request goes to the tunnel's host whatever its Host header says.
 * Bodies stream back untouched (SSE included). It knows headers and secrets, not agents.
 * Keep-alive works (requests on one connection one after another); pipelined HTTP/1.1 is not supported.
 */
export function startInterceptor(options: InterceptorOptions): Interceptor {
  const sessions = new Map<number, InterceptSession>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0, // the default 10 s would cut long model streams
    development: false, // development mode answers errors with an HTML page full of internals
    tls: { cert: options.cert, key: options.key },
    error: () => new Response("Household gateway: internal error\n", { status: 500 }),
    async fetch(request, server) {
      const session = sessions.get(server.requestIP(request)?.port ?? -1);
      if (!session) return new Response("unknown tunnel\n", { status: 421 });
      const url = new URL(request.url);
      let swapped = false;
      /** Whether the pet's key (not an owner's secret) goes on this request: what the meter is about. */
      let keyed = false;
      const log = (status: number, reason?: string) =>
        options.log({
          kind: "request",
          ts: new Date().toISOString(),
          subject: session.subject,
          pet: session.pet.pet,
          source: session.source,
          method: request.method,
          target: `${formatEndpoint(session.target)}${url.pathname}`,
          status,
          swapped,
          reason,
        });

      const refuse = (reason: string, status = 403, headers: Record<string, string> = {}) => {
        log(status, reason);
        return new Response(`Household gateway: ${reason}\n`, { status, headers });
      };
      let upstream: Response;
      try {
        const found = options.credentials(session.pet, session.target);
        if ("refused" in found) return refuse(found.refused);
        const keys = found.filter((credential) => credential.match === undefined);
        const owned = found.filter((credential) => credential.match !== undefined);
        const headers = new Headers(request.headers);
        for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
        if (keys.length > 0) {
          const secrets = keys.map((credential) => ({ credential, secret: options.readSecret(credential.secret) }));
          if (secrets.some(({ secret }) => secret === undefined)) return refuse("the caller's key is not available on the gateway");
          // Every credential header of the host goes; exactly the pet's key's is set. None sent: nothing to replace.
          const strip = [...new Set(keys.flatMap((credential) => [credential.header, ...credential.strip]))];
          if (!strip.some((name) => request.headers.has(name))) return refuse("the request carries no credential to replace");
          for (const name of strip) headers.delete(name);
          for (const { credential, secret } of secrets) headers.set(credential.header, `${credential.prefix}${secret}`);
          swapped = true;
          keyed = true;
        }
        // An owner's secret: its value only where its own placeholder stands; anything else passes untouched.
        for (const credential of owned) {
          const sent = request.headers.get(credential.header);
          if (sent === null || !credential.match) continue;
          const value = options.readSecret(credential.secret);
          if (value === undefined) {
            if (fillPlaceholder(sent, credential.match, "") !== undefined) return refuse("the secret is not available on the gateway");
            continue;
          }
          const filled = fillPlaceholder(sent, credential.match, value);
          if (filled === undefined) continue;
          headers.set(credential.header, filled);
          swapped = true;
        }
        if (keyed) {
          const held = options.guard?.(session.pet, session.target);
          if (held) return refuse(held.reason, 429, { "retry-after": String(Math.max(1, Math.ceil((held.retryAfterMs ?? 60_000) / 1000))) });
        }
        const upstreamHost = session.address?.includes(":") ? `[${session.address}]` : session.address ?? session.target.host;
        if (session.address) headers.set("host", formatEndpoint(session.target));
        upstream = await fetch(`https://${upstreamHost}:${session.target.port}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
          redirect: "manual",
          signal: request.signal, // the pet hung up (Esc mid-stream): stop the upstream request too
          tls: { ...(options.upstreamCa ? { ca: options.upstreamCa } : {}), ...(session.address ? { serverName: session.target.host } : {}) },
        });
      } catch (error) {
        // The message may come from header handling; it goes to our log, never to the pet.
        log(502, (error as Error).message);
        return new Response("Household gateway: upstream request failed\n", { status: 502 });
      }
      log(upstream.status);
      if (keyed) {
        try { options.observe?.(session.pet, session.target, upstream.headers); } catch { /* a meter's error never touches the answer */ }
      }
      const responseHeaders = new Headers(upstream.headers);
      for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    },
  });
  return {
    port: server.port!,
    track(localPort, session) {
      sessions.set(localPort, session);
      // The port may already belong to a newer tunnel by the time this one's close event fires.
      return () => {
        if (sessions.get(localPort) === session) sessions.delete(localPort);
      };
    },
    stop: (force = true) => server.stop(force),
  };
}
