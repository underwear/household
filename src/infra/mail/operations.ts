import { z } from "zod";
import { mailFolder, mailMessageRef } from "../../core/mail-connectors";
import { HouseholdError } from "../../core/errors";

const filter = z.string().min(1).max(300).refine(v => !/[\r\n\0]/.test(v));
const date = z.iso.date();
const flags = z.array(z.enum(["Seen", "Answered", "Flagged", "Draft"])).max(4);
const ref = { ref: mailMessageRef };
const operations = {
  "mailboxes.list": { description: "List mailbox names and flags.", schema: z.strictObject({}) },
  "messages.search": { description: "Search a mailbox, newest UID first. Follow next as cursor with the same mailbox, query and searchMode until complete. An empty page with next is not the end. headers mode scans up to 200 headers per call locally for servers with unreliable subject/from/to search; text search requires server mode. Dates filter received/internal date. No Seen changes.", schema: z.strictObject({ mailbox: mailFolder.default("INBOX"), limit: z.number().int().min(1).max(50).default(20), searchMode: z.enum(["server", "headers"]).default("server"), query: z.strictObject({ from: filter.optional(), to: filter.optional(), subject: filter.optional(), text: filter.optional(), since: date.optional(), before: date.optional(), unread: z.boolean().optional() }).default({}), cursor: z.strictObject({ account: z.string().regex(/^[a-f0-9]{64}$/), queryKey: z.string().regex(/^[a-f0-9]{64}$/), uidValidity: z.string().regex(/^[1-9][0-9]{0,19}$/), maxUid: z.number().int().min(0).max(4294967295), beforeUid: z.number().int().min(1).max(4294967296) }).optional() }) },
  "messages.read": { description: "Read message headers, body and attachment metadata using its full ref from search. Does not mark Seen. Bodies over 64,000 characters are explicitly truncated; messages over 12 MiB are refused. HTML is untrusted text, never executed.", schema: z.strictObject(ref) },
  "attachments.download": { description: "Download one attachment from a message into your inbox directory. Use its ID from messages.read. Returns a path in your home, not host paths. Maximum attachment 8 MiB.", schema: z.strictObject({ ...ref, attachment: z.string().regex(/^[0-9]{1,3}$/) }) },
  "flags.update": { manage: true, description: "Add/remove explicit Seen, Answered, Flagged or Draft flags. Only change what your owner requested.", schema: z.strictObject({ ...ref, add: flags.default([]), remove: flags.default([]) }).refine(v => v.add.length + v.remove.length > 0 && !v.add.some(f => v.remove.includes(f)), "Choose non-conflicting flags") },
  "messages.move": { manage: true, description: "Move one message to another mailbox using UID MOVE. No unsafe global EXPUNGE fallback. The old ref becomes invalid; search the destination for its new ref.", schema: z.strictObject({ ...ref, destination: mailFolder }) },
  "messages.trash": { manage: true, description: "Move one message to the owner's configured Trash mailbox, recoverably. Does not permanently delete or expunge anything.", schema: z.strictObject(ref) },
  "mailboxes.create": { manage: true, description: "Create a mailbox.", schema: z.strictObject({ mailbox: mailFolder }) },
  "mailboxes.rename": { manage: true, description: "Rename a mailbox. Existing message refs may stop working; list/search it again.", schema: z.strictObject({ mailbox: mailFolder, destination: mailFolder }) },
  "drafts.save": { manage: true, description: "Save a new text draft in the configured Drafts folder without sending. Each successful call creates one draft; do not blindly retry after an uncertain result.", schema: z.strictObject({ to: z.array(z.email().max(320)).max(50).default([]), subject: z.string().max(998).refine(v => !/[\r\n\0]/.test(v)), text: z.string().max(64000) }) },
} satisfies Record<string, { description: string; schema: z.ZodType; manage?: boolean }>;
export { operations as MAIL_OPERATIONS };

export function mailOperation(name: string, input: unknown) {
  if (!Object.hasOwn(operations, name)) throw new HouseholdError("Unknown mail operation; use the mail operations tool");
  const spec = operations[name as keyof typeof operations];
  const result = spec.schema.safeParse(input);
  if (!result.success) throw new HouseholdError("Invalid mail operation parameters; use the schema from the operations tool");
  return { params: result.data as Record<string, unknown>, manage: "manage" in spec && spec.manage === true };
}
export function mailCatalog(manage: boolean) {
  return Object.entries(operations).filter(([, spec]) => manage || !("manage" in spec)).map(([name, spec]) => ({ name, description: spec.description, manage: "manage" in spec, parameters: z.toJSONSchema(spec.schema, { unrepresentable: "any" }) }));
}
