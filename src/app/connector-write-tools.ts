import type { PetIdentity } from "../infra/agent-api";
import type { McpTool } from "../infra/mcp-server";
import type { ConnectorProvider, ConnectorWrites } from "./connector-writes";

export function connectorWriteTools(writes: ConnectorWrites, accounts: (caller: PetIdentity) => { provider: ConnectorProvider; id: string }[]): McpTool<PetIdentity>[] {
  const accessible = (caller: PetIdentity) => (provider: ConnectorProvider, id: string) => accounts(caller).some(c => c.provider === provider && c.id === id);
  const available = (caller: PetIdentity) => accounts(caller).length > 0;
  return [
    { name: "household_connectors_write_status", description: "Inspect your connector changes awaiting approval or recently completed. Optionally select a request ID. unknown means the operation may have happened: inspect the account and never automatically retry with a new clientRequestId. SMTP email sends use household_connectors_mail_send_status instead.", available, inputSchema: { type: "object", additionalProperties: false, properties: { request: { type: "string" } } }, call: async (caller, args) => {
      if (args.request !== undefined && typeof args.request !== "string") throw new Error("request must be a string");
      return JSON.stringify(writes.status(caller, accessible(caller), args.request as string | undefined));
    } },
    { name: "household_connectors_cancel_write", description: "Withdraw your own pending connector approval by request ID. Cannot recall a change whose execution has started. SMTP email sends use household_connectors_mail_cancel_send instead.", available, inputSchema: { type: "object", additionalProperties: false, properties: { request: { type: "string" } }, required: ["request"] }, call: async (caller, args) => {
      if (typeof args.request !== "string") throw new Error("request is required");
      return JSON.stringify(writes.cancel(caller, args.request, accessible(caller)));
    } },
  ];
}
