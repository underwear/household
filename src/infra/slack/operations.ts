import { z } from "zod";
import { HouseholdError } from "../../core/errors";

const channel = z.string().regex(/^[CDG][A-Z0-9]+$/);
const file = z.string().regex(/^F[A-Z0-9]+$/);
const timestamp = z.string().regex(/^\d+\.\d+$/);
const page = { cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(20) };
const historyScopes = ["channels:history", "groups:history", "im:history", "mpim:history"];
const search = { query: z.string().min(1).max(4000), count: z.number().int().min(1).max(100).default(20), page: z.number().int().min(1).max(100).default(1), sort: z.enum(["timestamp", "score"]).default("timestamp"), sort_dir: z.enum(["asc", "desc"]).default("desc") };
const reaction = { channel, timestamp, name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_+:-]+$/) };
interface Operation { description: string; write?: boolean; scopes: string[]; schema: z.ZodType }
export const SLACK_OPERATIONS: Record<string, Operation> = {
  "chat.postMessage": { description: "Send a message to an existing conversation. Requires explicit user authorization for the destination and content. Do not retry automatically after an uncertain result; read history first.", write: true, scopes: ["chat:write"], schema: z.strictObject({ channel, text: z.string().min(1).max(4000), thread_ts: timestamp.optional(), unfurl_links: z.literal(false).default(false), unfurl_media: z.literal(false).default(false) }) },
  "search.messages": { description: "Search visible messages with Slack query syntax (in:, from:, before:, after:). Follow messages.paging with page.", scopes: ["search:read"], schema: z.strictObject(search) },
  "users.conversations": { description: "List this authorized user's conversations. Follow response_metadata.next_cursor. Private channels and DMs depend on membership and granted scopes.", scopes: ["channels:read", "groups:read", "im:read", "mpim:read"], schema: z.strictObject({ ...page, types: z.string().max(100).regex(/^(public_channel|private_channel|im|mpim)(,(public_channel|private_channel|im|mpim)){0,3}$/).refine(value => new Set(value.split(",")).size === value.split(",").length).default("public_channel"), exclude_archived: z.boolean().default(true) }) },
  "conversations.info": { description: "Get conversation details, including last_read and unread_count_display when Slack supplies them.", scopes: ["channels:read", "groups:read", "im:read", "mpim:read"], schema: z.strictObject({ channel }) },
  "conversations.history": { description: "Read channel messages; use conversations.replies for a thread. Follow response_metadata.next_cursor.", scopes: historyScopes, schema: z.strictObject({ channel, ...page, oldest: timestamp.optional(), latest: timestamp.optional(), inclusive: z.boolean().optional() }) },
  "conversations.replies": { description: "Read a thread by channel and parent message ts. Follow response_metadata.next_cursor.", scopes: historyScopes, schema: z.strictObject({ channel, ts: timestamp, ...page, oldest: timestamp.optional(), latest: timestamp.optional(), inclusive: z.boolean().optional() }) },
  "users.info": { description: "Read a Slack user's profile.", scopes: ["users:read"], schema: z.strictObject({ user: z.string().regex(/^[UW][A-Z0-9]+$/) }) },
  "files.info": { description: "Read file metadata and available text previews. Does not download binary files.", scopes: ["files:read"], schema: z.strictObject({ file }) },
  "files.download": { description: "Download a Slack file by ID (up to 50 MiB) into your ~/.household/inbox. Returns path relative to your home, filename, contentType and size; use your local image/file tools to inspect it. No URL input.", scopes: ["files:read"], schema: z.strictObject({ file }) },
  "files.upload": { description: "Upload a file up to 50 MiB from a path relative to your ~/.household/outbox using Slack's external upload flow. channel_id shares it; omit to keep private. Requires user authorization; never automatically retry an uncertain upload.", write: true, scopes: ["files:write"], schema: z.strictObject({ path: z.string().min(1).max(1024).regex(/^[^\\\x00-\x1f\x7f]+$/).refine(value => value.split("/").every(part => part && part !== "." && part !== "..")), filename: z.string().min(1).max(180).regex(/^[^/\\\x00-\x1f\x7f]+$/).optional(), title: z.string().max(255).optional(), channel_id: channel.optional(), thread_ts: timestamp.optional(), initial_comment: z.string().max(4000).optional(), alt_txt: z.string().max(1000).optional() }).refine(p => p.channel_id !== undefined || (p.thread_ts === undefined && p.initial_comment === undefined)) },
  "search.files": { description: "Search visible files with Slack query syntax. Follow files.paging with page; download results with files.download.", scopes: ["search:read"], schema: z.strictObject(search) },
  "reactions.get": { description: "Read reactions on a message. full requests all available reaction users; count can exceed the returned users list.", scopes: ["reactions:read"], schema: z.strictObject({ channel, timestamp, full: z.boolean().default(true) }) },
  "reactions.add": { description: "Add your reaction to a message. name is an emoji name without surrounding colons.", write: true, scopes: ["reactions:write"], schema: z.strictObject(reaction) },
  "reactions.remove": { description: "Remove your reaction from a message.", write: true, scopes: ["reactions:write"], schema: z.strictObject(reaction) },
  "chat.update": { description: "Edit the text of a message authored by this Slack user. Requires authorization for the change. Slack enforces ownership.", write: true, scopes: ["chat:write"], schema: z.strictObject({ channel, ts: timestamp, text: z.string().min(1).max(4000) }) },
  "chat.delete": { description: "Delete a message authored by this Slack user. Requires authorization for deletion. Slack enforces ownership.", write: true, scopes: ["chat:write"], schema: z.strictObject({ channel, ts: timestamp }) },
  "usergroups.list": { description: "Resolve subteam mentions to user-group handles and names.", scopes: ["usergroups:read"], schema: z.strictObject({ include_disabled: z.boolean().default(false), include_count: z.boolean().default(false), include_users: z.boolean().default(false) }) },
  "usergroups.users.list": { description: "List members of a Slack user group (subteam).", scopes: ["usergroups:read"], schema: z.strictObject({ usergroup: z.string().regex(/^S[A-Z0-9]+$/), include_disabled: z.boolean().default(false) }) },
  "conversations.open": { description: "Open or resume a DM with one user (im:write), or a group DM with up to eight users (mpim:write). Supply comma-separated user IDs, excluding yourself.", write: true, scopes: ["im:write", "mpim:write"], schema: z.strictObject({ users: z.string().max(256).regex(/^[UW][A-Z0-9]+(,[UW][A-Z0-9]+){0,7}$/), return_im: z.boolean().default(true) }) },
  "conversations.mark": { description: "Mark a conversation read through ts for this Slack user. Requires the conversation type's write scope.", write: true, scopes: ["channels:write", "groups:write", "im:write", "mpim:write"], schema: z.strictObject({ channel, ts: timestamp }) },
  "chat.getPermalink": { description: "Get a permanent link to a message or thread reply.", scopes: [], schema: z.strictObject({ channel, message_ts: timestamp }) },
  "users.lookupByEmail": { description: "Find a Slack user by email address.", scopes: ["users:read.email"], schema: z.strictObject({ email: z.email().max(320) }) },
};
export function slackOperation(name: string, params: unknown) {
  if (!Object.hasOwn(SLACK_OPERATIONS, name)) throw new HouseholdError("Unknown Slack operation");
  const spec = SLACK_OPERATIONS[name]!;
  const parsed = spec.schema.safeParse(params);
  if (!parsed.success) throw new HouseholdError("Invalid Slack operation parameters; check operations for its schema");
  return { spec, params: parsed.data as Record<string, string | number | boolean> };
}
export function slackHasScope(spec: Operation, scopes: string[]) {
  return spec.scopes.length === 0 || spec.scopes.some(scope => scopes.includes(scope));
}
export function slackCatalog(scopes: string[], allowWrite = false) {
  return Object.entries(SLACK_OPERATIONS).filter(([, s]) => (!s.write || allowWrite) && slackHasScope(s, scopes)).map(([name, s]) => ({ name, description: s.description, parameters: z.toJSONSchema(s.schema), readOnly: !s.write }));
}
