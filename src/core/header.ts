import type { External } from "./channel";
import type { ReplyFormat, Audience } from "./channels";
import { EXCERPT_MAX, HEAD_AND_TAIL_MAX, oneLine } from "./excerpt";
import { block, HEADER_TAG, tagFreeJson } from "./tags";

/**
 * Household's header of every message from the chat (the chat contract), first
 * in its `household-message` block (message.ts):
 *
 *   <household-header>
 *   {"event":{…},"from":{…},"channel":{…}}
 *   </household-header>
 *
 * One line of compact JSON between the tags. Everything but `channel.meta` is contract: Household's ids
 * (`m…`, `p…`, `c…`, see ids.ts), which tools take back, and Household's own facts. `channel.meta` is the
 * channel's (`External`): shown, never a reason for anything. The pet sees channels, never places: one
 * channel is one chat to it, wherever in it (a thread, General) the message was written.
 */

/** The house's owner, or anyone else (another person: their words are a request, never the owner's order). */
export type Trust = "owner" | "guest";

/** A message something is on: Household's id and its excerpt (the header cuts it: see `target`). */
export interface Target {
  id: string;
  excerpt: string;
}

/** One new message: `id` is Household's; `relayed`: the body is content the sender passed on, not their own words. */
export interface NewMessage {
  kind: "message";
  id: string;
  relayed?: true;
}

/**
 * message: a new one. edit: a new version of message `id`, whole. button: a press on post `on` (the pet's own).
 * reaction: the sender's reactions on message `on` changed; `author` is `you` (the pet told), a person id or
 * `household`.
 */
export type HeaderEvent =
  | NewMessage
  | { kind: "edit"; id: string; relayed?: true }
  | { kind: "button"; label: string; on: Target }
  | { kind: "reaction"; added: string[]; removed: string[]; on?: Target & { author?: string } };

/**
 * The channel a message came through, as the pet sees it: Household's id of it, its kind, its name (the
 * config's, or its kind's), who may read it (`audience`, from its kind) and `meta`, the channel's facts that are
 * context (its username, who a forward is from; no vendor ids). The channel's other facts are kept beside the
 * message (`Message.facts`), never here.
 */
export interface HeaderChannel {
  replyFormat?: ReplyFormat;
  id: string;
  kind: string;
  name: string;
  audience: Audience;
  meta?: External;
}

export interface Header {
  event: HeaderEvent;
  from: { id: string; name: string; trust: Trust };
  channel: HeaderChannel;
}


const MAX_VALUE = 128;

/**
 * A value from outside (a name, the channel's facts, a message's excerpt) as the header shows it: without format
 * or default-ignorable characters (bidi, zero-width, fillers), in one line of at most `max` (`oneLine`; 128
 * unless said otherwise). JSON escaping does the rest.
 */
export const clean = (value: string, max = MAX_VALUE) => oneLine(value.replace(/[\p{Cf}\p{DI}]/gu, ""), max);

/**
 * The channel's facts, cleaned. Only strings, numbers, lists and objects of them are shown: anything else, at any
 * depth (a stored header's `null`s, a boolean), is left out.
 */
function cleanMeta(meta: External): External {
  const entries = Object.entries(meta).flatMap(([key, value]) => {
    const cleaned = cleanValue(value);
    return cleaned === undefined ? [] : [[clean(key), cleaned]];
  });
  return Object.fromEntries(entries) as External;
}

function cleanValue(value: unknown): External[string] | undefined {
  if (typeof value === "string") return clean(value);
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(cleanValue).filter((item) => item !== undefined) as External[];
  if (typeof value === "object" && value !== null) return cleanMeta(value as External);
  return undefined;
}

/** What a press or a reaction is on: a button's post shows how it begins and ends, a reaction's message how it begins. */
const target = (on: Target, max: number) => ({ id: on.id, excerpt: clean(on.excerpt, max) });

/** The event in the contract's key order; empty lists and absent facts are left out. */
function event(event: HeaderEvent): object {
  switch (event.kind) {
    case "message":
    case "edit":
      return { kind: event.kind, id: event.id, ...(event.relayed ? { relayed: true } : {}) };
    case "button":
      return { kind: "button", label: clean(event.label), on: target(event.on, HEAD_AND_TAIL_MAX) };
    case "reaction": {
      const { added, removed, on } = event;
      return {
        kind: "reaction",
        ...(added.length > 0 ? { added: added.map((name) => clean(name)) } : {}),
        ...(removed.length > 0 ? { removed: removed.map((name) => clean(name)) } : {}),
        ...(on ? { on: { ...target(on, EXCERPT_MAX), ...(on.author ? { author: on.author } : {}) } } : {}),
      };
    }
  }
}

/** The header's `channel` as shown (in the header, in a history item): cleaned, `meta` left out when empty. */
export function cleanChannel({ id, kind, name, audience, meta, replyFormat }: HeaderChannel): HeaderChannel {
  return {
    id,
    kind: clean(kind),
    name: clean(name),
    audience,
    ...(replyFormat ? { replyFormat: { name: clean(replyFormat.name), instructions: clean(replyFormat.instructions, 2000), ...(replyFormat.rich ? { rich: { name: clean(replyFormat.rich.name), instructions: clean(replyFormat.rich.instructions, 2000) } } : {}) } } : {}),
    ...(meta && Object.keys(meta).length > 0 ? { meta: cleanMeta(meta) } : {}),
  };
}

/**
 * The header block: the tags, and one line of compact JSON between them, which never holds a tag (`tagFreeJson`).
 */
export function renderHeader({ event: what, from, channel }: Header): string {
  const json = {
    event: event(what),
    from: { id: from.id, name: clean(from.name), trust: from.trust },
    channel: cleanChannel(channel),
  };
  return block(HEADER_TAG, [tagFreeJson(json)]);
}
