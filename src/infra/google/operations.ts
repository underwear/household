import { z } from "zod";
import type { GoogleService } from "../../core/google-connectors";

const id = z.string().min(1).max(256).refine(v => v !== "." && v !== ".." && !/[\/\\\x00-\x1f]/.test(v), "invalid Google resource id");
const text = z.string().max(2000);
const page = { pageToken: text.optional(), maxResults: z.number().int().min(1).max(50).default(20) };
const enc = encodeURIComponent;
interface Operation { service: GoogleService; description: string; schema: z.ZodType; path: (a: any) => string; query?: (a: any) => Record<string, unknown>; text?: boolean; message?: boolean }
/** Closed operation registry: no supplied hosts, URLs, headers, HTTP methods or arbitrary paths. */
export const GOOGLE_OPERATIONS = {
  "gmail.messages.list": { service: "gmail", description: "Search mail using Gmail q syntax. Follow nextPageToken with pageToken; read returned IDs with gmail.messages.get.", schema: z.strictObject({ q: text.optional(), ...page }), path: () => "/gmail/v1/users/me/messages", query: a => a },
  "gmail.messages.get": { service: "gmail", description: "Read one message, its headers and decoded text/HTML parts. Attachment data is not fetched.", schema: z.strictObject({ id }), path: a => `/gmail/v1/users/me/messages/${enc(a.id)}`, query: () => ({ format: "full" }), message: true },
  "gmail.threads.get": { service: "gmail", description: "Read messages in a thread with decoded body parts.", schema: z.strictObject({ id }), path: a => `/gmail/v1/users/me/threads/${enc(a.id)}`, query: () => ({ format: "full" }), message: true },
  "gmail.labels.list": { service: "gmail", description: "List mail labels.", schema: z.strictObject({}), path: () => "/gmail/v1/users/me/labels" },
  "drive.files.list": { service: "drive", description: "Search Drive using Drive v3 q syntax (for example trashed = false and name contains 'report'). Returns metadata, not content.", schema: z.strictObject({ q: text.default("trashed = false"), pageToken: text.optional(), pageSize: z.number().int().min(1).max(50).default(20), orderBy: text.optional() }), path: () => "/drive/v3/files", query: a => ({ ...a, fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,size,webViewLink,description)", supportsAllDrives: true, includeItemsFromAllDrives: true }) },
  "drive.files.get": { service: "drive", description: "Read file metadata. Use export for Google Docs, Sheets and Slides text.", schema: z.strictObject({ id }), path: a => `/drive/v3/files/${enc(a.id)}`, query: () => ({ fields: "id,name,mimeType,description,modifiedTime,size,webViewLink,exportLinks", supportsAllDrives: true }) },
  "drive.files.export": { service: "drive", description: "Read a Google Workspace document as text/plain, text/csv (Sheets first sheet), or text/markdown (Docs). Large responses are refused; no binary download.", schema: z.strictObject({ id, mimeType: z.enum(["text/plain", "text/csv", "text/markdown"]).default("text/plain") }), path: a => `/drive/v3/files/${enc(a.id)}/export`, query: a => ({ mimeType: a.mimeType }), text: true },
  "calendar.calendarList.list": { service: "calendar", description: "List accessible calendars and their IDs.", schema: z.strictObject(page), path: () => "/calendar/v3/users/me/calendarList", query: a => a },
  "calendar.events.list": { service: "calendar", description: "List events. calendarId defaults to primary. timeMin/timeMax are RFC3339 with timezone. Recurrences are expanded; results ordered by start time.", schema: z.strictObject({ calendarId: id.default("primary"), timeMin: z.iso.datetime({ offset: true }).optional(), timeMax: z.iso.datetime({ offset: true }).optional(), q: text.optional(), ...page }), path: a => `/calendar/v3/calendars/${enc(a.calendarId)}/events`, query: ({ calendarId, ...a }) => ({ ...a, singleEvents: true, orderBy: "startTime" }) },
  "calendar.events.get": { service: "calendar", description: "Read an event's details.", schema: z.strictObject({ calendarId: id.default("primary"), id }), path: a => `/calendar/v3/calendars/${enc(a.calendarId)}/events/${enc(a.id)}` },
} satisfies Record<string, Operation>;
export type GoogleOperation = keyof typeof GOOGLE_OPERATIONS;
export function googleRequest(operation: string, input: unknown) {
  if (!Object.hasOwn(GOOGLE_OPERATIONS, operation)) throw new Error("Unknown Google operation; call household_connectors_google_operations");
  const spec: Operation = GOOGLE_OPERATIONS[operation as GoogleOperation];
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid parameters: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const url = new URL(spec.path(parsed.data), "https://www.googleapis.com");
  for (const [key, value] of Object.entries(spec.query?.(parsed.data) ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  return { url, spec };
}
export function operationCatalog(services: GoogleService[]) {
  return Object.entries(GOOGLE_OPERATIONS).filter(([, op]) => services.includes(op.service)).map(([name, op]) => ({ name, description: op.description, parameters: z.toJSONSchema(op.schema) }));
}

/** Preserve structure, but decode Gmail bodies so a model need not base64-decode mail itself. */
export function decodeMail(value: any): any {
  if (Array.isArray(value)) return value.map(decodeMail);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = decodeMail(item);
  if (typeof value.mimeType === "string" && value.mimeType.startsWith("text/") && typeof value.body?.data === "string") {
    result.body = { ...value.body, data: undefined, text: Buffer.from(value.body.data, "base64url").toString("utf8") };
  }
  return result;
}
