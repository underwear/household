import { rmSync } from "node:fs";
import { HouseholdError } from "../core/errors";

// The CLI ↔ daemon channel is HTTP over a unix socket in the state dir (mode 0700).
// Never TCP on 127.0.0.1: anything on the machine could call it; the socket is the owner's alone.

/** Route handlers get the request's JSON body (undefined when there is none). */
export type ControlRoutes = Record<string, (body: unknown) => Promise<unknown>>;

/**
 * Listens on `socketPath`. Doubles as the single-instance guard: fails if another process answers there,
 * replaces the socket file if it was left by a process that died.
 */
export async function serveControl(
  socketPath: string,
  routes: ControlRoutes,
): Promise<{ stop: () => Promise<void> }> {
  const listen = () =>
    Bun.serve({
      unix: socketPath,
      // A reload may build an image or wait for a pet; Bun's 10 s request timeout would cut it off.
      // Bun honours idleTimeout on unix sockets, but its types only allow it for TCP.
      ...({ idleTimeout: 0 } as object),
      async fetch(request) {
        const route = routes[new URL(request.url).pathname];
        if (!route) return Response.json({ error: "not found" }, { status: 404 });
        try {
          const body = request.headers.get("content-type") === "application/json" ? await request.json() : undefined;
          return Response.json({ result: await route(body) });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 500 });
        }
      },
    });
  let server: ReturnType<typeof listen>;
  try {
    server = listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if ((await callControl(socketPath, "/status")) !== undefined) {
      throw new HouseholdError(`a daemon is already running on ${socketPath}`);
    }
    rmSync(socketPath);
    server = listen();
  }
  // Graceful: stops accepting, lets in-flight requests answer. Bun removes the socket file.
  return { stop: () => server.stop() };
}

/** Calls a daemon route. Resolves to undefined when no daemon is listening (routes never return undefined). */
export async function callControl<T>(socketPath: string, route: string, body?: unknown): Promise<T | undefined> {
  let response: Response;
  try {
    response = await fetch(`http://household${route}`, {
      unix: socketPath,
      method: "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return undefined;
    throw error;
  }
  const answer = (await response.json()) as { result: T; error?: string };
  if (!response.ok) throw new HouseholdError(`daemon: ${answer.error}`);
  return answer.result;
}
