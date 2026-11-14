import { z } from "zod";
import { connectorWritePolicySchema, type ConnectorWritePolicy } from "./connector-write-policy";

export const GOOGLE_SERVICES = ["gmail", "drive", "calendar"] as const;
export type GoogleService = typeof GOOGLE_SERVICES[number];
/** What a service needs to be read. */
export const GOOGLE_SCOPES: Record<GoogleService, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
  calendar: ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"],
};
/**
 * What a service needs, on top of reading, to be changed: send, draft, label and trash mail; create, edit and trash
 * files; create, change and delete events. Requested beside the read scopes, so a write scope Google's consent
 * screen leaves unticked still leaves the service readable.
 */
export const GOOGLE_WRITE_SCOPES: Record<GoogleService, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  drive: ["https://www.googleapis.com/auth/drive"],
  calendar: ["https://www.googleapis.com/auth/calendar.events"],
};
export const googleConnectSchema = z.strictObject({
  services: z.array(z.enum(GOOGLE_SERVICES)).min(1).max(3),
  pets: z.array(z.string().min(1).max(64)).max(100),
  /** Ask for the write scopes too; false (the old clients' default) asks to read only. */
  writePolicy: connectorWritePolicySchema.optional(),
  write: z.boolean().default(false),
});
export interface GoogleConnectionView {
  writePolicy?: ConnectorWritePolicy;
  id: string;
  email: string;
  services: GoogleService[];
  /** Of `services`, those Google granted changes for; empty for a read-only connection. */
  writable: GoogleService[];
  pets: string[];
  connectedAt: string;
  needsReconnect: boolean;
}
export interface GoogleConnectorsView { ready: boolean; connections: GoogleConnectionView[] }
