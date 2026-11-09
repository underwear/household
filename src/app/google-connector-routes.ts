import { z } from "zod";
import { HouseholdError } from "../core/errors";
import type { GoogleConnectors } from "./google-connectors";
import { cookieValue, sessionCookieName } from "./web-auth";

export const googleOAuthCookieName = (port: string) => `household_google_oauth_${port}`;
export const googleOAuthCookie = (port: string, session: string, clear = false) => `${googleOAuthCookieName(port)}=${clear ? "" : session}; HttpOnly; SameSite=Lax; Path=/api/connectors/google/callback; Max-Age=${clear ? 0 : 600}`;

/** Called only after webRoutes' owner-session authentication (or through its private control socket). */
export function googleConnectorRoutes(connectors: GoogleConnectors) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const binding = cookieValue(request.headers.get("cookie"), sessionCookieName(url.port)) ?? (url.pathname === "/api/connectors/google/callback" ? cookieValue(request.headers.get("cookie"), googleOAuthCookieName(url.port)) : undefined) ?? "control-socket";
    if (url.pathname === "/api/connectors/google/callback") {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      try {
        const house = await connectors.finish(url, binding);
        return new Response(null, { status: 303, headers: { location: `/houses/${encodeURIComponent(house)}/connectors?google=connected`, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": googleOAuthCookie(url.port, "", true) } });
      } catch (error) {
        // Fixed plain text: never reflect authorization codes, tokens or provider error details.
        return new Response(error instanceof HouseholdError ? `${error.message}. Return to Household Connectors and try again.` : "Google connection failed. Return to Household Connectors and try again.", { status: 400, headers: { "content-type": "text/plain", "cache-control": "no-store", "set-cookie": googleOAuthCookie(url.port, "", true) } });
      }
    }
    const match = /^\/api\/houses\/([^/]+)\/connectors\/google(?:\/(connect|[^/]+))?$/.exec(url.pathname);
    if (!match) return;
    const house = decodeURIComponent(match[1]!); const action = match[2];
    if (!action && request.method === "GET") return Response.json(connectors.list(house));
    if (action === "connect" && request.method === "POST") {
      const result = connectors.begin(house, await request.json(), url.origin, binding);
      // The dashboard session remains SameSite=Strict. Only this ten-minute, callback-scoped
      // cookie can authenticate a top-level return from Google; it is never accepted by other routes.
      return Response.json(result, { headers: binding === "control-socket" ? {} : { "set-cookie": googleOAuthCookie(url.port, binding) } });
    }
    if (action && action !== "connect" && request.method === "PATCH") {
      const parsed = z.strictObject({ pets: z.array(z.string().min(1).max(64)).max(100) }).safeParse(await request.json());
      if (!parsed.success) throw new HouseholdError("pets must be a list of this house's pet names");
      return Response.json(connectors.setPets(house, decodeURIComponent(action), parsed.data.pets));
    }
    if (action && action !== "connect" && request.method === "DELETE") { connectors.disconnect(house, decodeURIComponent(action)); return Response.json({ ok: true }); }
    return new Response(null, { status: 405 });
  };
}
