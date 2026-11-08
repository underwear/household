import { createHash, timingSafeEqual } from "node:crypto";

/** Headers the gateway relay sets on every request to the agent API, after dropping any the pet sent. */
export const AGENT_API_HEADERS = {
  secret: "x-household-secret",
  house: "x-household-house",
  pet: "x-household-pet",
} as const;

/** The pet behind a request, as the gateway relay vouches for it. */
export interface PetIdentity {
  house: string;
  pet: string;
}

export interface AgentApiOptions {
  port: number;
  /** Random per daemon start; only the gateway has it. */
  secret: string;
  /** Answers one request of an identified pet; the app routes by path. */
  handle: (pet: PetIdentity, request: Request) => Promise<Response>;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The daemon's HTTP API for agents, reached only through the gateway relay. It listens on the Mac's loopback,
 * which every OrbStack container on a normal bridge and every Mac process can reach, so the secret is the lock.
 * It exposes nothing administrative: that stays on the control socket.
 */
export function serveAgentApi(options: AgentApiOptions): { port: number; stop: () => Promise<void> } {
  const expected = digest(options.secret);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    // Idle and slow connections time out; an authorized request lifts it, as its answer may wait for a person.
    idleTimeout: 10,
    maxRequestBodySize: 1024 * 1024,
    development: false,
    error: () => new Response("internal error\n", { status: 500 }),
    async fetch(request, server) {
      // Digests have equal length, so the comparison takes the same time whatever the guess.
      if (!timingSafeEqual(digest(request.headers.get(AGENT_API_HEADERS.secret) ?? ""), expected)) {
        return new Response("unauthorized\n", { status: 401 });
      }
      const house = request.headers.get(AGENT_API_HEADERS.house);
      const pet = request.headers.get(AGENT_API_HEADERS.pet);
      if (!house || !pet) return new Response("missing pet identity\n", { status: 400 });
      server.timeout(request, 0);
      return options.handle({ house, pet }, request);
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}
