import type { InboundMessage, MessageRef, PostRef, SenderRef } from "../../core/channel";
import type { FileRef } from "../../core/attachment";

export interface SlackMessage {
  type?: string; subtype?: string; user?: string; bot_id?: string; app_id?: string;
  text?: string; ts?: string; thread_ts?: string; channel?: string; edited?: { ts?: string };
  message?: SlackMessage; event_ts?: string;
  user_profile?: { real_name?: string; display_name?: string };
  files?: { id: string; name?: string; mimetype?: string; size?: number }[];
  item?: { type?: string; channel?: string; ts?: string }; reaction?: string;
}
export interface SlackPayload {
  type?: string; team_id?: string; team?: { id?: string }; event_id?: string;
  event?: SlackMessage; channel?: { id?: string }; user?: { id?: string; name?: string; team_id?: string };
  message?: SlackMessage; container?: { message_ts?: string; channel_id?: string; thread_ts?: string };
  actions?: { action_id?: string; value?: string; action_ts?: string; text?: { text?: string } }[];
}
export const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+$/.test(value);
export const senderRef = (team: string, user: string) => `slack.user.${team}.${user}` as SenderRef;
export const messageRef = (prefix: string, ts: string) => `${prefix}.${ts}` as MessageRef;
/** Undo Slack's automatic bare-domain links without trusting an arbitrary link label. */
function inboundText(text: string): string {
  return text.replace(/<(https?:\/\/[^<>|\s]+)(?:\|([^<>]+))?>/g, (_match, target: string, label?: string) => {
    // Typing example.com arrives as <http://example.com|example.com>. House commands need the typed domain.
    if (label && target.replace(/^https?:\/\//, "").replace(/\/$/, "") === label) return label;
    return label && label !== target ? `${label} (${target})` : target;
  }).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/^\s*!(secret|stop)(?=\s|$)/i, "/$1");
}
export function parseInbound(body: SlackPayload, prefix: string, team: string, placeOf: (ts: string) => string | undefined): InboundMessage | undefined {
  const event = body.event;
  if (!event || !event.user && !event.message?.user) return;
  if (event.type !== "message" && event.type !== "reaction_added" && event.type !== "reaction_removed") return;
  const message = event.subtype === "message_changed" ? event.message : event;
  if (!message || message.bot_id || message.app_id || (message.subtype && message.subtype !== "file_share")) return;
  const user = message.user;
  if (!user || !/^[UW][A-Z0-9]+$/.test(user)) return;
  const from = { ref: senderRef(team, user), name: message.user_profile?.display_name || message.user_profile?.real_name || "Slack user" };
  const base = { from, external: {}, kept: { workspace: team, user } };
  if (event.type.startsWith("reaction_")) {
    if (event.item?.type !== "message" || !timestamp(event.item.ts) || !timestamp(event.event_ts) || !event.reaction) return;
    return { ...base, kind: "reaction", ref: messageRef(prefix, `${event.event_ts}.${user}.${event.type}`), on: messageRef(prefix, event.item.ts), added: event.type === "reaction_added" ? [event.reaction] : [], removed: event.type === "reaction_removed" ? [event.reaction] : [] };
  }
  if (!timestamp(message.ts)) return;
  const place = message.thread_ts ? placeOf(message.thread_ts) : undefined;
  // Unknown/deleted threads must not silently become the default pet's inbox.
  if (message.thread_ts && !place) return;
  const edited = event.subtype === "message_changed" ? message.edited?.ts ?? event.event_ts : undefined;
  if (event.subtype === "message_changed" && !timestamp(edited)) return;
  return {
    ...base, kind: "text", ref: messageRef(prefix, message.ts + (edited ? `.${edited}` : "")),
    ...(edited ? { edits: messageRef(prefix, message.ts) } : {}),
    ...(place ? { place, replyTo: messageRef(prefix, message.thread_ts!) as unknown as PostRef } : {}),
    text: inboundText(message.text ?? ""),
    ...(message.files?.length ? { attachments: message.files.filter(file => /^F[A-Z0-9]+$/.test(file.id)).map(file => ({
      kind: file.mimetype?.startsWith("image/") ? "photo" as const : "document" as const,
      file: `${prefix}.file.${file.id}` as FileRef, name: file.name, mime: file.mimetype, size: file.size,
    })) } : {}),
  };
}
