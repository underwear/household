import { z } from "zod";

const line = z.string().max(1000).refine(v => !/[\x00-\x1f\x7f]/.test(v), "Use a single line");
export const mailEndpointSchema = z.strictObject({
  host: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls"]).default("tls"),
  username: line.min(1).max(320),
  password: z.string().max(8192).refine(v => !/[\r\n\0]/.test(v)),
  tlsCertificate: z.string().trim().max(32768).regex(/^(?:-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+\s+-----END CERTIFICATE-----\s*)+$/, "Use PEM certificates only, never a private key").optional(),
});
export const mailFolder = line.min(1).max(200);
export const mailConnectionSchema = z.strictObject({
  title: line.trim().min(1).max(100),
  email: z.email().max(320),
  displayName: line.max(100).default(""),
  imap: mailEndpointSchema,
  smtp: mailEndpointSchema.optional(),
  sentFolder: mailFolder.optional(),
  draftsFolder: mailFolder.default("Drafts"),
  trashFolder: mailFolder.default("Trash"),
  sendPolicy: z.enum(["disabled", "approval", "auto"]).default("disabled"),
  allowManage: z.boolean().default(false),
  pets: z.array(z.string().min(1).max(64)).max(100),
}).refine(v => v.sendPolicy === "disabled" || !!v.smtp, "SMTP settings are required to send mail");
export type MailConnectionInput = z.infer<typeof mailConnectionSchema>;
export type MailEndpoint = z.infer<typeof mailEndpointSchema>;
export type MailSendPolicy = MailConnectionInput["sendPolicy"];
export interface MailConnectionView extends Omit<MailConnectionInput, "imap" | "smtp"> {
  id: string;
  connectedAt: string;
  imap: Omit<MailEndpoint, "password">;
  smtp?: Omit<MailEndpoint, "password">;
}
export interface MailConnectorsView { connections: MailConnectionView[]; sends: MailSendView[] }
export const mailMessageRef = z.strictObject({ account: z.string().regex(/^[a-f0-9]{64}$/), mailbox: mailFolder, uidValidity: z.string().regex(/^[1-9][0-9]{0,19}$/), uid: z.number().int().min(1).max(4294967295) });
export type MailMessageRef = z.infer<typeof mailMessageRef>;
const addresses = z.array(z.email().max(320)).max(50);
export const mailSendSchema = z.strictObject({
  clientRequestId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  to: addresses.default([]), cc: addresses.default([]), bcc: addresses.default([]),
  subject: line.max(998), text: z.string().max(64000),
  attachments: z.array(z.strictObject({ path: z.string().min(1).max(512), filename: line.min(1).max(200).refine(v => !/[\/\\]/.test(v), "Use a filename without directories"), contentType: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).default("application/octet-stream") })).max(10).default([]),
  replyTo: mailMessageRef.optional(),
}).refine(v => v.to.length + v.cc.length + v.bcc.length > 0 && v.to.length + v.cc.length + v.bcc.length <= 50, "Specify 1–50 recipients");
export type MailSendInput = z.infer<typeof mailSendSchema>;
/** Why an approval ended at once: no chat could show it to the owner (the admin says so on the account's row). */
export const MAIL_NO_CHAT = "No chat could show the owner this approval: the bot may be in no channel. Nothing was sent; ask the owner to add the bot to a channel, then request again.";
export type MailSendState = "preparing" | "pending" | "sending" | "sent" | "sent-copy-failed" | "denied" | "cancelled" | "failed" | "unknown";
export interface MailSendView {
  id: string; connection: string; pet: string; from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string;
  attachments: { filename: string; contentType: string; size: number; sha256: string }[];
  state: MailSendState; messageId: string; createdAt: string; expiresAt: string; detail?: string;
}
