import { z } from "zod";
import { HouseholdError } from "../core/errors";
import type { SlackConnectors } from "./slack-connectors";
import { cookieValue, sessionCookieName } from "./web-auth";

/** A request's JSON body; malformed JSON is the caller's mistake (a 400), not a server error. */
async function body(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new HouseholdError("The request body is not valid JSON"); }
}

/** webRoutes authenticates the dashboard owner before calling this handler. */
export function slackConnectorRoutes(connectors: SlackConnectors) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const binding = cookieValue(request.headers.get("cookie"), sessionCookieName(url.port)) ?? "control-socket";
    const match = /^\/api\/houses\/([^/]+)\/connectors\/slack(?:\/(connect|authorize|complete|[^/]+))?$/.exec(url.pathname);
    if (!match) return;
    const house = decodeURIComponent(match[1]!), action = match[2];
    if (!action && request.method === "GET") return Response.json(connectors.list(house), { headers: { "cache-control": "no-store" } });
    if (action === "authorize" && request.method === "POST") {
      const result = connectors.begin(house, await body(request), url.origin, binding);
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    }
    if (action === "complete" && request.method === "POST") {
      const parsed = z.strictObject({ url: z.string().max(8192) }).safeParse(await body(request));
      if (!parsed.success) throw new HouseholdError("Paste the connection result from the Slack callback page");
      let callback: URL;
      try { callback = new URL(parsed.data.url.trim()); } catch { throw new HouseholdError("Paste the connection result from the Slack callback page"); }
      await connectors.finish(callback, binding, house);
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "connect" && request.method === "POST") return Response.json(await connectors.connect(house, await body(request)), { headers: { "cache-control": "no-store" } });
    if (action && !["connect", "authorize", "complete"].includes(action) && request.method === "PATCH") {
      const parsed = z.strictObject({ pets: z.array(z.string().min(1).max(64)).max(100) }).safeParse(await body(request));
      if (!parsed.success) throw new HouseholdError("bots must be a list of this workspace's bot names");
      return Response.json(connectors.setPets(house, decodeURIComponent(action), parsed.data.pets));
    }
    if (action && !["connect", "authorize", "complete"].includes(action) && request.method === "DELETE") { connectors.disconnect(house, decodeURIComponent(action)); return Response.json({ ok: true }); }
    return new Response(null, { status: 405 });
  };
}
