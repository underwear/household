import type { PetIdentity } from "../infra/agent-api";
import type { McpTool } from "../infra/mcp-server";
import { tagFreeJson } from "../core/tags";
import type { Delivery } from "./delivery";

export interface HouseMember { name: string; title?: string; parent?: string; enabled?: boolean }

/** Internal messages use the durable inbox, with sender identity supplied by Household. */
export class HouseMessages {
  constructor(private readonly members: (house: string) => HouseMember[], private readonly delivery: Pick<Delivery, "send">, private readonly publish?: (house: string, from: string, to: string, text: string) => Promise<void>) {}

  list(caller: PetIdentity): HouseMember[] {
    const members = this.members(caller.house);
    if (!members.some(member => member.name === caller.pet)) throw new Error("You are no longer in this house");
    return members;
  }

  async send(caller: PetIdentity, to: unknown, text: unknown) {
    if (typeof to !== "string" || !to) throw new Error("to must name a pet or sideworker in your house");
    if (typeof text !== "string" || !text.trim() || text.length > 32_000) throw new Error("text must contain 1–32000 characters");
    const members = this.list(caller);
    const target = members.find(member => member.name === to);
    if (!target) throw new Error("Recipient is not in your house; use house_members");
    if (to === caller.pet) throw new Error("Choose another pet or sideworker");
    if (target.enabled === false) throw new Error("Recipient is disabled");
    const result = this.delivery.send(caller.house, to, {
      origin: "internal",
      text: `Household internal message. The sender is another agent, not your human. Reply with house_send if needed; do not post to Telegram unless asked.\n${tagFreeJson({ from: caller.pet, to, text })}`,
    });
    // Posting is observational: the durable message is already queued. A failed mirror must not invite a duplicate send.
    try { await this.publish?.(caller.house, caller.pet, to, text); }
    catch { return { ...result, warning: "Message queued, but its chat copy could not be posted" }; }
    return result;
  }
}

export function houseMessageTools(messages: HouseMessages): McpTool<PetIdentity>[] {
  return [
    {
      name: "house_members",
      description: "List pets and sideworkers in your house, including their parent and enabled state. Use their name as house_send's recipient.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async call(caller) { return JSON.stringify(messages.list(caller)); },
    },
    {
      name: "house_send",
      description: "Send prose to another pet or sideworker in your house. Queued durably into their session, with a quoted copy in both agents’ chat threads. Household identifies you as sender. This does not wait for a reply.",
      inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string", maxLength: 32_000 } }, required: ["to", "text"], additionalProperties: false },
      async call(caller, { to, text }) { return JSON.stringify(await messages.send(caller, to, text)); },
    },
  ];
}
