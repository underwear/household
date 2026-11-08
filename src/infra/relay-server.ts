import type { Identify } from "../core/egress";
import { AGENT_API_HEADERS } from "./agent-api";
import type { GatewayPolicy } from "./gateway-policy";

export interface RelayOptions {
  host: string;
  port: number;
  /** Read on every request, so a policy reload applies to the next one. */
  policy: () => GatewayPolicy;
  /** Which pet calls (the gateway's one identity seam); asked per request. None: refused. */
  identify: Identify;
  /** The agent API secret; undefined while the daemon has not handed one over. */
  secret: () => string | undefined;
  /** How long a request body may take to arrive. */
  bodyDeadlineMs?: number;
  /** Requests one pet may have open at once (answers may wait long). */
  maxOpenPerPet?: number;
}

export const MAX_BODY_BYTES = 1024 * 1024;

/** Headers that describe one connection, not the message (RFC 9110 §7.6.1), plus the ones fetch sets itself. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

function forwardable(source: Headers, also: string[]): Headers {
  const headers = new Headers(source);
  const listed = (source.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_BY_HOP, ...listed, ...also]) if (name) headers.delete(name);
  return headers;
}

const deny = (status: number, reason: string, headers?: Record<string, string>) =>
  new Response(`Household relay: ${reason}\n`, { status, headers });

/** The body; null if it could not be read (too large), undefined if it did not arrive within `ms`. */
async function readBody(request: Request, ms: number): Promise<ArrayBuffer | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)));
  const body = request.arrayBuffer().catch(() => null);
  try {
    return await Promise.race([body, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Calls `done` once, when the body has been read to the end, cancelled or failed. */
function tracked(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (!chunk.done) return controller.enqueue(chunk.value);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
      done();
    },
    async cancel(reason) {
      done();
      await reader.cancel(reason);
    },
  });
}

/**
 * Generic, path-preserving reverse proxy from pets to the daemon's agent API. The caller is identified only by
 * `identify` (now its source address: subnet → house, address → pet); whatever identity or secret headers it sent are dropped
 * and replaced. A pet cannot hold the shared gateway's sockets: idle connections time out, a request body must
 * arrive whole (≤ 1 MB) within a deadline, and a pet has a few requests open at most. Only then the timeout is
 * lifted: an answer may wait for a person, and streams through.
 */
export function startRelay(options: RelayOptions) {
  const { bodyDeadlineMs = 10_000, maxOpenPerPet = 32 } = options;
  const open = new Map<string, number>();
  return Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 10,
    maxRequestBodySize: MAX_BODY_BYTES,
    development: false,
    error: () => deny(502, "internal error"),
    async fetch(request, server) {
      const source = (server.requestIP(request)?.address ?? "").replace(/^::ffff:/i, "");
      const { agentApi } = options.policy();
      const pet = options.identify({ source, header: (name) => request.headers.get(name) ?? undefined });
      if (!pet) return deny(403, `${source} is not a known pet`);
      const secret = options.secret();
      if (!agentApi || !secret) return deny(503, "the daemon is not ready");

      const name = `${pet.house}/${pet.pet}`;
      if ((open.get(name) ?? 0) >= maxOpenPerPet) return deny(429, `${name} has ${maxOpenPerPet} requests open`);
      open.set(name, (open.get(name) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const left = open.get(name)! - 1;
        if (left > 0) open.set(name, left);
        else open.delete(name);
      };
      request.signal.addEventListener("abort", release);

      let upstream: Response;
      try {
        const body = await readBody(request, bodyDeadlineMs);
        if (!body) {
          release();
          if (body === null) return deny(413, `the request body is unreadable or over ${MAX_BODY_BYTES} bytes`);
          return deny(408, `the request body did not arrive within ${bodyDeadlineMs} ms`, { connection: "close" });
        }
        server.timeout(request, 0);
        const headers = forwardable(request.headers, ["host", "content-length"]);
        for (const header of [...headers.keys()]) if (header.startsWith("x-household-")) headers.delete(header);
        headers.set(AGENT_API_HEADERS.house, pet.house);
        headers.set(AGENT_API_HEADERS.pet, pet.pet);
        headers.set(AGENT_API_HEADERS.secret, secret);
        const url = new URL(request.url);
        upstream = await fetch(`${agentApi}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
          redirect: "manual",
          signal: request.signal,
          timeout: false,
        } as RequestInit);
      } catch {
        release();
        return deny(502, "the daemon is unreachable");
      }
      const headers = forwardable(upstream.headers, ["content-encoding", "content-length"]);
      if (!upstream.body) release();
      return new Response(upstream.body && tracked(upstream.body, release), { status: upstream.status, headers });
    },
  });
}
