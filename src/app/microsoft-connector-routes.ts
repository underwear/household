import { z } from "zod";
import { connectorAccessSchema } from "../core/connector-write-policy";
import { HouseholdError } from "../core/errors";
import type { MicrosoftConnectors } from "./microsoft-connectors";
import { cookieValue, sessionCookieName } from "./web-auth";

async function body(request: Request): Promise<unknown> { try { return await request.json(); } catch { throw new HouseholdError("The request body is not valid JSON"); } }
/** webRoutes authenticates the owner; enrollment IDs are also bound to their workspace and session. */
export function microsoftConnectorRoutes(connectors: MicrosoftConnectors) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url), match = /^\/api\/houses\/([^/]+)\/connectors\/microsoft(?:\/(authorize|poll|cancel|[^/]+))?$/.exec(url.pathname);
    if (!match) return;
    const house = decodeURIComponent(match[1]!), action = match[2];
    const binding = cookieValue(request.headers.get("cookie"), sessionCookieName(url.port)) ?? "control-socket";
    const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });
    if (!action && request.method === "GET") return json(connectors.list(house));
    if (action === "authorize" && request.method === "POST") return json(await connectors.begin(house, await body(request), binding));
    if ((action === "poll" || action === "cancel") && request.method === "POST") {
      const parsed = z.strictObject({ id: z.uuid() }).safeParse(await body(request));
      if (!parsed.success) throw new HouseholdError("Invalid Microsoft sign-in ID");
      if (action === "poll") return json(await connectors.poll(house, parsed.data.id, binding));
      connectors.cancel(house, parsed.data.id, binding); return json({ ok: true });
    }
    if (action && !["authorize", "poll", "cancel"].includes(action)) {
      if (request.method === "PATCH") {
        const parsed = connectorAccessSchema.safeParse(await body(request));
        if (!parsed.success) throw new HouseholdError("bots must be a list of this workspace's bot names");
        return json(connectors.setPets(house, decodeURIComponent(action), parsed.data.pets, parsed.data.writePolicy));
      }
      if (request.method === "DELETE") { connectors.disconnect(house, decodeURIComponent(action)); return json({ ok: true }); }
    }
    return new Response(null, { status: 405 });
  };
}
