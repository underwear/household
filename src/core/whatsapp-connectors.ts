import { z } from "zod";
import { connectorWritePolicySchema, type ConnectorWritePolicy } from "./connector-write-policy";

const name = z.string().trim().min(1).max(64);
const pets = z.array(z.string().min(1).max(64)).max(100);
/** Pairing a new account, or `connection` again (its keys were lost or it was unlinked). `phone` asks for a code instead of a QR. */
export const whatsappConnectSchema = z.strictObject({
  name: name.optional(),
  writePolicy: connectorWritePolicySchema.default("disabled"),
  pets,
  phone: z.string().trim().regex(/^\+?[\d\s()-]{6,24}$/, "a phone number in international format, like +34600111222").optional(),
  connection: z.uuid().optional(),
});
export const whatsappAccessSchema = z.strictObject({ name: name.optional(), pets, writePolicy: connectorWritePolicySchema.optional() });
export type WhatsAppLink = "connecting" | "online" | "offline";
export interface WhatsAppConnectionView {
  id: string;
  /** The owner's name for it; the account's own name or number when they gave none. */
  name: string;
  phone: string;
  account?: string;
  writePolicy: ConnectorWritePolicy;
  pets: string[];
  connectedAt: string;
  /** WhatsApp unlinked this device: pair again. */
  needsReconnect: boolean;
  link: WhatsAppLink;
  chats: number;
  messages: number;
}
export interface WhatsAppConnectorsView { connections: WhatsAppConnectionView[] }
export interface WhatsAppPairingView { id: string; expiresAt: string }
export type WhatsAppPollView =
  | { status: "pending"; qr?: string; code?: string; expiresAt: string }
  | { status: "connected"; connection: string }
  | { status: "failed"; error: string };
