import { z } from "zod";

export const connectorWritePolicySchema = z.enum(["disabled", "approval", "auto"]);
export type ConnectorWritePolicy = z.infer<typeof connectorWritePolicySchema>;
/** Old connections retain their explicit read/write permission until the owner changes it. */
export const connectorWritePolicy = (policy: ConnectorWritePolicy | undefined, writable: boolean): ConnectorWritePolicy => policy ?? (writable ? "auto" : "disabled");
export const connectorAccessSchema = z.strictObject({
  pets: z.array(z.string().min(1).max(64)).max(100),
  writePolicy: connectorWritePolicySchema.optional(),
});
export const CONNECTOR_ACCESS_OPTIONS = [
  { value: "disabled", label: "Read only", description: "Bots can read. Nothing in the account changes." },
  { value: "approval", label: "Ask me first", description: "Every change comes to your chat for approval. Nothing changes until you approve." },
  { value: "auto", label: "Full access", description: "Bots can read and make supported changes without asking." },
] as const;
export const connectorAccessWords = (policy: ConnectorWritePolicy) => policy === "approval" ? "ask me first" : policy === "auto" ? "full access" : "read only";

/** Names of currently eligible callers, including sideworkers inheriting a grant. */
export function connectorCallers(houses: import("./household").House[], house: string, grants: string[]) {
  const pets = houses.find(h => h.name === house)?.pets ?? [];
  return pets.filter(p => !p.scout && p.enabled !== false && grants.includes(p.sideworker?.parent ?? p.name) && (!p.sideworker || pets.some(parent => parent.name === p.sideworker!.parent && parent.enabled !== false && !parent.sideworker && !parent.scout))).map(p => p.name);
}
