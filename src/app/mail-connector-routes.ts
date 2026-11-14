import { z } from "zod";
import { HouseholdError } from "../core/errors";
import type { MailConnectors } from "./mail-connectors";

export function mailConnectorRoutes(connectors: MailConnectors) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = /^\/api\/houses\/([^/]+)\/connectors\/mail(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(new URL(request.url).pathname);
    if (!match) return;
    const house = decodeURIComponent(match[1]!), action = match[2], target = match[3];
    const body = async () => { try { return await request.json(); } catch { throw new HouseholdError("Invalid JSON body"); } };
    const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });
    if (!action && request.method === "GET") return json(connectors.list(house));
    if (!action && request.method === "POST") return json(await connectors.save(house, await body()));
    if (action === "test" && !target && request.method === "POST") {
      const parsed = z.strictObject({ id: z.uuid().optional(), config: z.unknown() }).safeParse(await body());
      if (!parsed.success) throw new HouseholdError("Invalid mail test request");
      return json(await connectors.test(house, parsed.data.config, parsed.data.id));
    }
    if (action === "sends" && target && request.method === "POST") {
      const parsed = z.strictObject({ decision: z.enum(["approved", "denied", "cancelled"]) }).safeParse(await body());
      if (!parsed.success) throw new HouseholdError("Choose approve, deny or cancel");
      return json(connectors.decide(house, decodeURIComponent(target), parsed.data.decision));
    }
    if (action && !target && !["sends", "test"].includes(action)) {
      if (request.method === "PUT") return json(await connectors.save(house, await body(), decodeURIComponent(action)));
      if (request.method === "DELETE") { connectors.disconnect(house, decodeURIComponent(action)); return json({ ok: true }); }
    }
    return new Response(null, { status: 405 });
  };
}
