import { z } from "zod";

const id = z.string().min(1).max(2048).refine(v => v !== "." && v !== ".." && !/[\/\\\x00-\x1f]/.test(v), "invalid Microsoft resource id");
const text = z.string().max(2000);
const enc = encodeURIComponent;
const when = z.strictObject({ dateTime: z.iso.datetime({ local: true, offset: true }), timeZone: text.min(1) });
const recurrence = z.strictObject({
  pattern: z.strictObject({ type: z.enum(["daily", "weekly", "absoluteMonthly", "relativeMonthly", "absoluteYearly", "relativeYearly"]), interval: z.number().int().min(1).max(999), month: z.number().int().min(1).max(12).optional(), dayOfMonth: z.number().int().min(1).max(31).optional(), daysOfWeek: z.array(z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"])).min(1).max(7).optional(), firstDayOfWeek: z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]).optional(), index: z.enum(["first", "second", "third", "fourth", "last"]).optional() }),
  range: z.strictObject({ type: z.enum(["endDate", "noEnd", "numbered"]), startDate: z.iso.date(), endDate: z.iso.date().optional(), recurrenceTimeZone: text.optional(), numberOfOccurrences: z.number().int().min(1).max(999).optional() }),
});
const taskFields = {
  title: text.min(1).optional(), body: z.strictObject({ content: z.string().max(50_000), contentType: z.enum(["text", "html"]).default("text") }).optional(),
  status: z.enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"]).optional(), importance: z.enum(["low", "normal", "high"]).optional(),
  dueDateTime: when.nullable().optional(), startDateTime: when.nullable().optional(), completedDateTime: when.nullable().optional(),
  isReminderOn: z.boolean().optional(), reminderDateTime: when.nullable().optional(), recurrence: recurrence.nullable().optional(),
};
/** To Do accepts HTML bodies. Plain text is escaped before conversion. */
function taskBody(value: Record<string, any>) {
  const body = value.body;
  return body?.contentType === "text" ? { ...value, body: { contentType: "html", content: `<div>${body.content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "<br>")}</div>` } } : value;
}
const page = { pageToken: z.string().max(16000).optional(), top: z.number().int().min(1).max(50).default(20) };
const listPath = (a: any) => `/v1.0/me/todo/lists/${enc(a.listId)}`;
const taskPath = (a: any) => `${listPath(a)}/tasks/${enc(a.taskId)}`;
const checklistPath = (a: any) => `${taskPath(a)}/checklistItems`;
const version = { ifMatch: z.string().min(1).max(1024).refine(v => !/[\r\n]/.test(v)).optional() };
const nonempty = (a: Record<string, unknown>) => Object.keys(a).length > 0;
interface Operation { description: string; schema: z.ZodType; path: (a: any) => string; method?: "POST" | "PATCH" | "DELETE"; write?: true; paged?: true; body?: (a: any) => unknown; query?: (a: any) => Record<string, string> }
export const MICROSOFT_OPERATIONS = {
  "todo.lists.list": { description: "List To Do task lists. Follow nextPageToken with pageToken on the same operation.", schema: z.strictObject(page), path: () => "/v1.0/me/todo/lists", paged: true },
  "todo.lists.get": { description: "Read a task list.", schema: z.strictObject({ listId: id }), path: listPath },
  "todo.lists.create": { description: "Create a task list.", schema: z.strictObject({ displayName: text.min(1) }), path: () => "/v1.0/me/todo/lists", method: "POST", write: true, body: a => a },
  "todo.lists.update": { description: "Rename a task list.", schema: z.strictObject({ listId: id, displayName: text.min(1), ...version }), path: listPath, method: "PATCH", write: true, body: a => ({ displayName: a.displayName }) },
  "todo.lists.delete": { description: "Delete a task list and its tasks. Only on the owner's explicit request.", schema: z.strictObject({ listId: id, ...version }), path: listPath, method: "DELETE", write: true },
  "todo.tasks.list": { description: "List tasks in a list. Optional OData filter/orderBy; no cross-list full-text search. Follow nextPageToken with pageToken and the same listId.", schema: z.strictObject({ listId: id, ...page, filter: text.optional(), orderBy: text.optional() }), path: a => `${listPath(a)}/tasks`, paged: true, query: a => ({ ...(a.filter ? { "$filter": a.filter } : {}), ...(a.orderBy ? { "$orderby": a.orderBy } : {}) }) },
  "todo.tasks.get": { description: "Read a task, including its body, dates, status and recurrence.", schema: z.strictObject({ listId: id, taskId: id }), path: taskPath },
  "todo.tasks.create": { description: "Create a task. Dates are {dateTime, timeZone}; body is {content, contentType}. Recurrence follows Microsoft Graph patternedRecurrence.", schema: z.strictObject({ listId: id, ...taskFields, title: text.min(1) }), path: a => `${listPath(a)}/tasks`, method: "POST", write: true, body: ({ listId, ...a }) => taskBody(a) },
  "todo.tasks.update": { description: "Change only the task fields given in changes. Set status completed to finish, notStarted to reopen. Null clears supported date/recurrence fields. Use ifMatch with an ETag to detect concurrent edits.", schema: z.strictObject({ listId: id, taskId: id, changes: z.strictObject(taskFields).refine(nonempty, "give at least one change"), ...version }), path: taskPath, method: "PATCH", write: true, body: a => taskBody(a.changes) },
  "todo.tasks.delete": { description: "Delete a task. Only on the owner's explicit request.", schema: z.strictObject({ listId: id, taskId: id, ...version }), path: taskPath, method: "DELETE", write: true },
  "todo.checklistItems.list": { description: "Read the checklist of a task.", schema: z.strictObject({ listId: id, taskId: id, ...page }), path: checklistPath, paged: true },
  "todo.checklistItems.create": { description: "Add a checklist item to a task.", schema: z.strictObject({ listId: id, taskId: id, displayName: text.min(1), isChecked: z.boolean().default(false) }), path: checklistPath, method: "POST", write: true, body: a => ({ displayName: a.displayName, isChecked: a.isChecked }) },
  "todo.checklistItems.update": { description: "Rename or check/uncheck a checklist item.", schema: z.strictObject({ listId: id, taskId: id, checklistItemId: id, changes: z.strictObject({ displayName: text.min(1).optional(), isChecked: z.boolean().optional() }).refine(nonempty), ...version }), path: a => `${checklistPath(a)}/${enc(a.checklistItemId)}`, method: "PATCH", write: true, body: a => a.changes },
  "todo.checklistItems.delete": { description: "Delete a checklist item.", schema: z.strictObject({ listId: id, taskId: id, checklistItemId: id, ...version }), path: a => `${checklistPath(a)}/${enc(a.checklistItemId)}`, method: "DELETE", write: true },
} satisfies Record<string, Operation>;

/** An opaque continuation can select only the same collection, on the fixed Graph origin. */
function continuation(value: string, path: string): URL {
  const url = new URL(Buffer.from(value, "base64url").toString("utf8"));
  const canonical = (value: string) => value.split("/").map(segment => encodeURIComponent(decodeURIComponent(segment))).join("/");
  if (url.origin !== "https://graph.microsoft.com" || canonical(url.pathname) !== canonical(path) || url.username || url.password || url.hash) throw new Error("Invalid Microsoft page token");
  const allowed = new Set(["$skiptoken", "$skip", "$top", "$select", "$filter", "$orderby"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error("Invalid Microsoft page token");
  const top = url.searchParams.get("$top");
  if (top !== null && (!/^\d+$/.test(top) || Number(top) < 1 || Number(top) > 50)) throw new Error("Invalid Microsoft page size");
  url.pathname = path;
  if (top === null) url.searchParams.set("$top", "20");
  return url;
}
export function microsoftRequest(operation: string, input: unknown) {
  if (!Object.hasOwn(MICROSOFT_OPERATIONS, operation)) throw new Error("Unknown Microsoft operation; call household_connectors_microsoft_operations");
  const spec: Operation = MICROSOFT_OPERATIONS[operation as keyof typeof MICROSOFT_OPERATIONS];
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid parameters: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const a = parsed.data as any, path = spec.path(a);
  const url = spec.paged && a.pageToken ? continuation(a.pageToken, path) : new URL(path, "https://graph.microsoft.com");
  if (!a.pageToken) {
    if (spec.paged) url.searchParams.set("$top", String(a.top));
    for (const [k, v] of Object.entries(spec.query?.(a) ?? {})) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {};
  if (a.ifMatch) headers["if-match"] = a.ifMatch;
  if (spec.body) headers["content-type"] = "application/json";
  return { url, spec, init: { method: spec.method ?? "GET", headers, ...(spec.body ? { body: JSON.stringify(spec.body(a)) } : {}) } };
}
export function microsoftCatalog(writable: boolean) {
  return Object.entries(MICROSOFT_OPERATIONS).filter(([, op]: [string, Operation]) => !op.write || writable).map(([name, op]) => ({ name, description: op.description, write: "write" in op, parameters: z.toJSONSchema(op.schema) }));
}
export function microsoftPage(data: any, url: URL) {
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data["@odata.nextLink"] === "string") {
    const token = Buffer.from(data["@odata.nextLink"]).toString("base64url");
    continuation(token, url.pathname);
    const { "@odata.nextLink": _, ...rest } = data;
    return { ...rest, nextPageToken: token };
  }
  return data;
}
