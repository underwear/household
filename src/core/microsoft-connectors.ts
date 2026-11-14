import { z } from "zod";
import { connectorWritePolicySchema, type ConnectorWritePolicy } from "./connector-write-policy";

export const microsoftConnectSchema = z.strictObject({
  writePolicy: connectorWritePolicySchema.optional(),
  write: z.boolean().default(false),
  pets: z.array(z.string().min(1).max(64)).max(100),
});
export interface MicrosoftConnectionView {
  writePolicy?: ConnectorWritePolicy;
  id: string;
  account: string;
  displayName: string;
  writable: boolean;
  pets: string[];
  connectedAt: string;
  needsReconnect: boolean;
}
export interface MicrosoftConnectorsView { ready: boolean; connections: MicrosoftConnectionView[] }
export interface MicrosoftAuthorizationView { id: string; userCode: string; verificationUri: string; expiresAt: string; interval: number }
export type MicrosoftPollView = { status: "pending"; interval: number } | { status: "connected" };
