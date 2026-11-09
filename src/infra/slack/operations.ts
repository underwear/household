import { z } from "zod";
import { HouseholdError } from "../../core/errors";

const channel = z.string().regex(/^[CDG][A-Z0-9]+$/);
const timestamp = z.string().regex(/^\d+\.\d+$/);
const page = { cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(20) };
const historyScopes = ["channels:history", "groups:history", "im:history", "mpim:history"];
interface Operation { description: string; write?: boolean; scopes: string[]; schema: z.ZodType }
export const SLACK_OPERATIONS: Record<string, Operation> = {
  "chat.postMessage": { description: "Send a message to an existing conversation. Requires explicit user authorization for the destination and content. Do not retry automatically after an uncertain result; read history first.", write: true, scopes: ["chat:write"], schema: z.strictObject({ channel, text: z.string().min(1).max(4000), thread_ts: timestamp.optional(), unfurl_links: z.literal(false).default(false), unfurl_media: z.literal(false).default(false) }) },
  "search.messages": { description: "Search visible messages with Slack query syntax (in:, from:, before:, after:). Follow messages.paging with page.", scopes: ["search:read"], schema: z.strictObject({ query: z.string().min(1).max(4000), count: z.number().int().min(1).max(100).default(20), page: z.number().int().min(1).max(100).default(1), sort: z.enum(["timestamp", "score"]).default("timestamp"), sort_dir: z.enum(["asc", "desc"]).default("desc") }) },
  "users.conversations": { description: "List this authorized user's conversations. Follow response_metadata.next_cursor. Private channels and DMs depend on membership and granted scopes.", scopes: ["channels:read", "groups:read", "im:read", "mpim:read"], schema: z.strictObject({ ...page, types: z.enum(["public_channel", "private_channel", "im", "mpim", "public_channel,private_channel,im,mpim"]).default("public_channel"), exclude_archived: z.boolean().default(true) }) },
  "conversations.info": { description: "Get conversation details.", scopes: ["channels:read", "groups:read", "im:read", "mpim:read"], schema: z.strictObject({ channel }) },
  "conversations.history": { description: "Read channel messages; use conversations.replies for a thread. Follow response_metadata.next_cursor.", scopes: historyScopes, schema: z.strictObject({ channel, ...page, oldest: timestamp.optional(), latest: timestamp.optional(), inclusive: z.boolean().optional() }) },
  "conversations.replies": { description: "Read a thread by channel and parent message ts. Follow response_metadata.next_cursor.", scopes: historyScopes, schema: z.strictObject({ channel, ts: timestamp, ...page, oldest: timestamp.optional(), latest: timestamp.optional(), inclusive: z.boolean().optional() }) },
  "users.info": { description: "Read a Slack user's profile.", scopes: ["users:read"], schema: z.strictObject({ user: z.string().regex(/^[UW][A-Z0-9]+$/) }) },
  "files.info": { description: "Read file metadata and available text previews. Does not download binary files.", scopes: ["files:read"], schema: z.strictObject({ file: z.string().regex(/^F[A-Z0-9]+$/) }) },
};
export function slackOperation(name: string, params: unknown) {
  if (!Object.hasOwn(SLACK_OPERATIONS, name)) throw new HouseholdError("Unknown Slack operation");
  const spec = SLACK_OPERATIONS[name]!;
  const parsed = spec.schema.safeParse(params);
  if (!parsed.success) throw new HouseholdError("Invalid Slack operation parameters; check operations for its schema");
  return { spec, params: parsed.data as Record<string, string | number | boolean> };
}
export function slackCatalog(scopes: string[]) {
  return Object.entries(SLACK_OPERATIONS).filter(([, s]) => s.scopes.some(scope => scopes.includes(scope))).map(([name, s]) => ({ name, description: s.description, parameters: z.toJSONSchema(s.schema), readOnly: !s.write }));
}
