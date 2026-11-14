import { z } from "zod";
import { connectorWritePolicySchema, type ConnectorWritePolicy } from "./connector-write-policy";

export const SLACK_READ_SCOPES = ["search:read", "channels:read", "channels:history", "groups:read", "groups:history", "im:read", "im:history", "mpim:read", "mpim:history", "users:read", "users:read.email", "files:read", "reactions:read", "usergroups:read"] as const;
export const SLACK_WRITE_SCOPES = ["chat:write", "files:write", "reactions:write", "im:write", "mpim:write", "channels:write", "groups:write"] as const;
export const slackConnectSchema = z.strictObject({
  token: z.string().trim().regex(/^xoxp-[A-Za-z0-9-]+$/).max(4096),
  writePolicy: connectorWritePolicySchema.optional(),
  allowWrite: z.boolean().default(false),
  pets: z.array(z.string().min(1).max(64)).max(100),
});
export interface SlackConnectionView {
  writePolicy?: ConnectorWritePolicy;
  id: string;
  teamId: string;
  team: string;
  userId: string;
  user: string;
  scopes: string[];
  pets: string[];
  allowWrite?: boolean;
  connectedAt: string;
  needsReconnect: boolean;
}
export interface SlackConnectorsView { oauthReady: boolean; connections: SlackConnectionView[] }
