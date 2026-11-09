import { z } from "zod";

export const GOOGLE_SERVICES = ["gmail", "drive", "calendar"] as const;
export type GoogleService = typeof GOOGLE_SERVICES[number];
export const GOOGLE_SCOPES: Record<GoogleService, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  drive: ["https://www.googleapis.com/auth/drive.readonly"],
  calendar: ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"],
};
export const googleConnectSchema = z.strictObject({
  services: z.array(z.enum(GOOGLE_SERVICES)).min(1).max(3),
  pets: z.array(z.string().min(1).max(64)).max(100),
});
export interface GoogleConnectionView {
  id: string;
  email: string;
  services: GoogleService[];
  pets: string[];
  connectedAt: string;
  needsReconnect: boolean;
}
export interface GoogleConnectorsView { ready: boolean; connections: GoogleConnectionView[] }
