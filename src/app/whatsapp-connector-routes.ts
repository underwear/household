import { z } from "zod";
import { HouseholdError } from "../core/errors";
import type { WhatsAppConnectors } from "./whatsapp-connectors";
import { cookieValue, sessionCookieName } from "./web-auth";

async function body(request: Request): Promise<unknown> { try { return await request.json(); } catch { throw new HouseholdError("The request body is not valid JSON"); } }
/** webRoutes authenticates the owner; a pairing is also bound to its workspace and browser session. */
export function whatsappConnectorRoutes(connectors: WhatsAppConnectors) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url), match = /^\/api\/houses\/([^/]+)\/connectors\/whatsapp(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return;
    const house = decodeURIComponent(match[1]!), action = match[2];
    const binding = cookieValue(request.headers.get("cookie"), sessionCookieName(url.port)) ?? "control-socket";
    const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });
    if (!action && request.method === "GET") return json(connectors.list(house));
    if (action === "pair" && request.method === "POST") return json(connectors.begin(house, await body(request), binding));
    if ((action === "poll" || action === "cancel") && request.method === "POST") {
      const parsed = z.strictObject({ id: z.uuid() }).safeParse(await body(request));
      if (!parsed.success) throw new HouseholdError("Invalid WhatsApp pairing ID");
      if (action === "poll") return json(await connectors.poll(house, parsed.data.id, binding));
      connectors.cancel(house, parsed.data.id, binding); return json({ ok: true });
    }
    if (action && !["pair", "poll", "cancel"].includes(action)) {
      if (request.method === "PATCH") return json(connectors.setAccess(house, decodeURIComponent(action), await body(request)));
      if (request.method === "DELETE") { await connectors.disconnect(house, decodeURIComponent(action)); return json({ ok: true }); }
    }
    return new Response(null, { status: 405 });
  };
}
