import { z } from "zod";
import type { GoogleService } from "../../core/google-connectors";

const id = z.string().min(1).max(256).refine(v => v !== "." && v !== ".." && !/[\/\\\x00-\x1f]/.test(v), "invalid Google resource id");
const text = z.string().max(2000);
const page = { pageToken: text.optional(), maxResults: z.number().int().min(1).max(50).default(20) };
const enc = encodeURIComponent;
/** One header line's worth: no CR or LF, so a value cannot add headers of its own. */
const header = z.string().max(998).refine(v => !/[\r\n]/.test(v), "no line breaks in headers");
const addresses = z.array(header.refine(v => v.includes("@"), "an email address")).max(100);
/** What a written Drive file holds: text in, converted by Drive when `mimeType` names a Google format. */
const content = { content: z.string().max(1024 * 1024).optional(), contentType: z.enum(["text/plain", "text/markdown", "text/csv", "text/html", "application/json"]).default("text/plain") };
const when = z.union([z.strictObject({ dateTime: z.iso.datetime({ offset: true }), timeZone: text.optional() }), z.strictObject({ date: z.iso.date() })]);
const event = { summary: text.optional(), description: z.string().max(8000).optional(), location: text.optional(), attendees: addresses.optional(), recurrence: z.array(text).max(10).optional() };
const sendUpdates = z.enum(["all", "externalOnly", "none"]).default("none");
const mail = { to: addresses.default([]), cc: addresses.optional(), bcc: addresses.optional(), subject: header.default(""), text: z.string().max(200_000).default(""), html: z.string().max(500_000).optional(), threadId: id.optional(), inReplyTo: header.optional(), references: header.optional() };
const fileFields = "id,name,mimeType,modifiedTime,webViewLink,parents";

interface Body { type: string; data: string }
interface Operation {
  service: GoogleService; description: string; schema: z.ZodType; path: (a: any) => string; query?: (a: any) => Record<string, unknown>;
  method?: "POST" | "PATCH" | "DELETE"; body?: (a: any) => Body;
  /** Changes the account: needs the service's write scopes, and a connection the owner let write. */
  write?: true; text?: boolean; message?: boolean;
}
const json = (value: unknown): Body => ({ type: "application/json", data: JSON.stringify(value) });
const defined = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

/** RFC 2047: a header value outside ASCII as UTF-8 base64 words. */
const word = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`);
/** «Name <a@b>» with only the name encoded: the address must stay readable to mail servers. */
const address = (value: string) => { const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value); return m && m[1] ? `${word(m[1].replace(/^"|"$/g, ""))} <${m[2]}>` : value.trim(); };
const base64Lines = (value: string) => Buffer.from(value).toString("base64").replace(/.{76}/g, "$&\r\n");
/** A message as Gmail takes it (`raw`): RFC 2822 headers, a text part, and an HTML alternative when there is one. */
export function mimeMessage(a: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; inReplyTo?: string; references?: string }) {
  const lines = [
    ...(a.to.length ? [`To: ${a.to.map(address).join(", ")}`] : []),
    ...(a.cc?.length ? [`Cc: ${a.cc.map(address).join(", ")}`] : []),
    ...(a.bcc?.length ? [`Bcc: ${a.bcc.map(address).join(", ")}`] : []),
    `Subject: ${word(a.subject)}`,
    ...(a.inReplyTo ? [`In-Reply-To: ${a.inReplyTo}`, `References: ${a.references ?? a.inReplyTo}`] : a.references ? [`References: ${a.references}`] : []),
    "MIME-Version: 1.0",
  ];
  const part = (type: string, value: string) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(value)}`;
  if (a.html === undefined) return Buffer.from(`${lines.join("\r\n")}\r\n${part("text/plain", a.text)}`).toString("base64url");
  const boundary = `household-${crypto.randomUUID()}`;
  const body = `--${boundary}\r\n${part("text/plain", a.text)}\r\n--${boundary}\r\n${part("text/html", a.html)}\r\n--${boundary}--`;
  return Buffer.from(`${lines.join("\r\n")}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n${body}`).toString("base64url");
}
/** Drive's multipart upload: the file's metadata, then its content. */
function upload(metadata: Record<string, unknown>, contentType: string, data: string): Body {
  const boundary = `household-${crypto.randomUUID()}`;
  return { type: `multipart/related; boundary=${boundary}`, data: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n${data}\r\n--${boundary}--` };
}
const driveMeta = ({ name, mimeType, parents, description }: any) => defined({ name, mimeType, parents, description });
const eventBody = ({ summary, description, location, start, end, attendees, recurrence }: any) => defined({ summary, description, location, start, end, recurrence, attendees: attendees?.map((email: string) => ({ email })) });

/** Closed operation registry: no supplied hosts, URLs, headers, HTTP methods or arbitrary paths. */
export const GOOGLE_OPERATIONS = {
  "gmail.messages.list": { service: "gmail", description: "Search mail using Gmail q syntax. Follow nextPageToken with pageToken; read returned IDs with gmail.messages.get.", schema: z.strictObject({ q: text.optional(), ...page }), path: () => "/gmail/v1/users/me/messages", query: a => a },
  "gmail.messages.get": { service: "gmail", description: "Read one message, its headers and decoded text/HTML parts. Attachment data is not fetched.", schema: z.strictObject({ id }), path: a => `/gmail/v1/users/me/messages/${enc(a.id)}`, query: () => ({ format: "full" }), message: true },
  "gmail.threads.get": { service: "gmail", description: "Read messages in a thread with decoded body parts.", schema: z.strictObject({ id }), path: a => `/gmail/v1/users/me/threads/${enc(a.id)}`, query: () => ({ format: "full" }), message: true },
  "gmail.labels.list": { service: "gmail", description: "List mail labels.", schema: z.strictObject({}), path: () => "/gmail/v1/users/me/labels" },
  "gmail.drafts.list": { service: "gmail", description: "List drafts (IDs and their message IDs).", schema: z.strictObject(page), path: () => "/gmail/v1/users/me/drafts", query: a => a },
  "gmail.messages.send": { service: "gmail", write: true, method: "POST", description: "Send an email as this account. to/cc/bcc are addresses («Name <a@b.c>» or a@b.c); text is the plain body, html an optional alternative. To reply, pass the thread's threadId and the original's Message-ID header as inReplyTo (and references).", schema: z.strictObject({ ...mail, to: addresses.min(1) }), path: () => "/gmail/v1/users/me/messages/send", body: a => json(defined({ raw: mimeMessage(a), threadId: a.threadId })) },
  "gmail.drafts.create": { service: "gmail", write: true, method: "POST", description: "Save a draft for the owner to review and send. Same fields as gmail.messages.send; to may be empty.", schema: z.strictObject(mail), path: () => "/gmail/v1/users/me/drafts", body: a => json({ message: defined({ raw: mimeMessage(a), threadId: a.threadId }) }) },
  "gmail.drafts.send": { service: "gmail", write: true, method: "POST", description: "Send an existing draft by its draft id.", schema: z.strictObject({ id }), path: () => "/gmail/v1/users/me/drafts/send", body: a => json({ id: a.id }) },
  "gmail.messages.modify": { service: "gmail", write: true, method: "POST", description: "Add or remove labels on a message: mark read (remove UNREAD), archive (remove INBOX), star (add STARRED), or a label id from gmail.labels.list.", schema: z.strictObject({ id, addLabelIds: z.array(id).max(20).default([]), removeLabelIds: z.array(id).max(20).default([]) }), path: a => `/gmail/v1/users/me/messages/${enc(a.id)}/modify`, body: a => json({ addLabelIds: a.addLabelIds, removeLabelIds: a.removeLabelIds }) },
  "gmail.messages.trash": { service: "gmail", write: true, method: "POST", description: "Move a message to Trash (Gmail empties it after 30 days). There is no permanent delete.", schema: z.strictObject({ id }), path: a => `/gmail/v1/users/me/messages/${enc(a.id)}/trash` },
  "drive.files.list": { service: "drive", description: "Search Drive using Drive v3 q syntax (for example trashed = false and name contains 'report'). Returns metadata, not content.", schema: z.strictObject({ q: text.default("trashed = false"), pageToken: text.optional(), pageSize: z.number().int().min(1).max(50).default(20), orderBy: text.optional() }), path: () => "/drive/v3/files", query: a => ({ ...a, fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,size,webViewLink,description)", supportsAllDrives: true, includeItemsFromAllDrives: true }) },
  "drive.files.get": { service: "drive", description: "Read file metadata. Use export for Google Docs, Sheets and Slides text.", schema: z.strictObject({ id }), path: a => `/drive/v3/files/${enc(a.id)}`, query: () => ({ fields: "id,name,mimeType,description,modifiedTime,size,webViewLink,exportLinks", supportsAllDrives: true }) },
  "drive.files.export": { service: "drive", description: "Read a Google Workspace document as text/plain, text/csv (Sheets first sheet), or text/markdown (Docs). Large responses are refused; no binary download.", schema: z.strictObject({ id, mimeType: z.enum(["text/plain", "text/csv", "text/markdown"]).default("text/plain") }), path: a => `/drive/v3/files/${enc(a.id)}/export`, query: a => ({ mimeType: a.mimeType }), text: true },
  "drive.files.create": { service: "drive", write: true, method: "POST", description: "Create a file or folder. With content (text up to 1 MiB, of contentType), the file holds it; mimeType application/vnd.google-apps.document (or .spreadsheet for CSV) converts it to a Google Doc or Sheet, application/vnd.google-apps.folder makes a folder. parents are folder ids.", schema: z.strictObject({ name: text.min(1), mimeType: text.optional(), parents: z.array(id).max(1).optional(), description: text.optional(), ...content }), path: a => (a.content === undefined ? "/drive/v3/files" : "/upload/drive/v3/files"), query: a => ({ ...(a.content === undefined ? {} : { uploadType: "multipart" }), supportsAllDrives: true, fields: fileFields }), body: a => (a.content === undefined ? json(driveMeta(a)) : upload(driveMeta(a), a.contentType, a.content)) },
  "drive.files.update": { service: "drive", write: true, method: "PATCH", description: "Rename, describe, move (addParents/removeParents folder ids) or replace a file's content (text, of contentType; a Google Doc takes it as its new text).", schema: z.strictObject({ id, name: text.min(1).optional(), description: text.optional(), addParents: z.array(id).max(1).optional(), removeParents: z.array(id).max(10).optional(), ...content }), path: a => `${a.content === undefined ? "" : "/upload"}/drive/v3/files/${enc(a.id)}`, query: a => defined({ ...(a.content === undefined ? {} : { uploadType: "multipart" }), addParents: a.addParents?.join(","), removeParents: a.removeParents?.join(","), supportsAllDrives: true, fields: fileFields }), body: a => (a.content === undefined ? json(driveMeta(a)) : upload(driveMeta(a), a.contentType, a.content)) },
  "drive.files.trash": { service: "drive", write: true, method: "PATCH", description: "Move a file or folder to Trash (restorable for 30 days). There is no permanent delete and no sharing.", schema: z.strictObject({ id }), path: a => `/drive/v3/files/${enc(a.id)}`, query: () => ({ supportsAllDrives: true, fields: fileFields }), body: () => json({ trashed: true }) },
  "calendar.calendarList.list": { service: "calendar", description: "List accessible calendars and their IDs.", schema: z.strictObject(page), path: () => "/calendar/v3/users/me/calendarList", query: a => a },
  "calendar.events.list": { service: "calendar", description: "List events. calendarId defaults to primary. timeMin/timeMax are RFC3339 with timezone. Recurrences are expanded; results ordered by start time.", schema: z.strictObject({ calendarId: id.default("primary"), timeMin: z.iso.datetime({ offset: true }).optional(), timeMax: z.iso.datetime({ offset: true }).optional(), q: text.optional(), ...page }), path: a => `/calendar/v3/calendars/${enc(a.calendarId)}/events`, query: ({ calendarId, ...a }) => ({ ...a, singleEvents: true, orderBy: "startTime" }) },
  "calendar.events.get": { service: "calendar", description: "Read an event's details.", schema: z.strictObject({ calendarId: id.default("primary"), id }), path: a => `/calendar/v3/calendars/${enc(a.calendarId)}/events/${enc(a.id)}` },
  "calendar.events.insert": { service: "calendar", write: true, method: "POST", description: "Create an event. start/end are {dateTime (RFC3339 with offset), timeZone?} or {date: YYYY-MM-DD} for all-day (end exclusive). attendees are emails; sendUpdates (default none) decides whether Google emails them.", schema: z.strictObject({ calendarId: id.default("primary"), ...event, summary: text.min(1), start: when, end: when, sendUpdates }), path: a => `/calendar/v3/calendars/${enc(a.calendarId)}/events`, query: a => ({ sendUpdates: a.sendUpdates }), body: a => json(eventBody(a)) },
  "calendar.events.patch": { service: "calendar", write: true, method: "PATCH", description: "Change an event: only the fields given. attendees replaces the whole list. sendUpdates as in insert.", schema: z.strictObject({ calendarId: id.default("primary"), id, ...event, start: when.optional(), end: when.optional(), sendUpdates }), path: a => `/calendar/v3/calendars/${enc(a.calendarId)}/events/${enc(a.id)}`, query: a => ({ sendUpdates: a.sendUpdates }), body: a => json(eventBody(a)) },
  "calendar.events.delete": { service: "calendar", write: true, method: "DELETE", description: "Delete (cancel) an event. sendUpdates as in insert.", schema: z.strictObject({ calendarId: id.default("primary"), id, sendUpdates }), path: a => `/calendar/v3/calendars/${enc(a.calendarId)}/events/${enc(a.id)}`, query: a => ({ sendUpdates: a.sendUpdates }) },
} satisfies Record<string, Operation>;
export type GoogleOperation = keyof typeof GOOGLE_OPERATIONS;
export function googleRequest(operation: string, input: unknown) {
  if (!Object.hasOwn(GOOGLE_OPERATIONS, operation)) throw new Error("Unknown Google operation; call household_connectors_google_operations");
  const spec: Operation = GOOGLE_OPERATIONS[operation as GoogleOperation];
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid parameters: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const url = new URL(spec.path(parsed.data), "https://www.googleapis.com");
  for (const [key, value] of Object.entries(spec.query?.(parsed.data) ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const body = spec.body?.(parsed.data);
  return { params: parsed.data, url, spec, init: { method: spec.method ?? "GET", ...(body ? { body: body.data, headers: { "content-type": body.type } } : {}) } };
}
/** The operations a pet can use: reads of `services`, and changes only on `writable` ones. */
export function operationCatalog(services: GoogleService[], writable: GoogleService[] = []) {
  return Object.entries(GOOGLE_OPERATIONS).filter(([, op]: [string, Operation]) => (op.write ? writable : services).includes(op.service)).map(([name, op]) => ({ name, description: op.description, write: "write" in op, parameters: z.toJSONSchema(op.schema) }));
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
