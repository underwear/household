import type { Attachment, OutgoingAttachment } from "./attachment";

/**
 * Handles a channel gives out and takes back: a message from the person (one version of it), something
 * Household posted, a sender. Opaque: only the channel adapter makes and reads them; core and app store,
 * compare and pass them on. Pet tools never take a vendor's raw ids, only what Household hands out.
 */
export type MessageRef = string & { readonly __brand: "MessageRef" };
export type PostRef = string & { readonly __brand: "PostRef" };
export type SenderRef = string & { readonly __brand: "SenderRef" };

/**
 * The channel's own facts about something (vendor ids, usernames, who a forward is from, …): never interpreted
 * and never taken back by a tool. The channel splits them (`InboundMessage`): what helps the pet as context is
 * shown as `channel.meta`; all of them are kept with the message, for debugging.
 */
export type External = { [key: string]: string | number | External | External[] };

/**
 * Who wrote, as the channel knows them. How far Household trusts them is Household's (`trustOf`: the house's
 * owners, `Channel.isSender`), never the channel's.
 */
export interface Sender {
  ref: SenderRef;
  name: string;
}

/**
 * Answers the person can give with one press, as rows of labels. Neutral data: each channel draws them its own
 * way (Telegram: an inline keyboard). A press names its choice by `index`, counted across the rows.
 */
export type Choices = string[][];
/**
 * A button that opens an address instead of answering (Telegram: an inline URL button). Pressing it comes back as
 * nothing: it is only a way there (a place's own thread, …).
 */
export interface LinkButton {
  label: string;
  url: string;
}
export type ReplyMode = "regular" | "rich";

/**
 * A message that came in through a channel. `ref` is the channel's id of it, unique per version: an edit has its
 * own ref and names the message it changes in `edits`. `place`: the id of the place it was written in;
 * undefined for the inbox (the house as a whole). The sender comes without trust: Household decides that.
 * `relayed`: the person passed on content (a forward, …), not their own words; from whom is the channel's
 * business (`external`). `replyTo`: the message it quotes (answers), as the channel referred to it. `attachments`:
 * the files it came with (its text is then their caption, maybe empty); a place or a contact comes as text.
 * `unsupported`: content Household cannot take yet (a poll, …), named by `what`. `choice`: a press on post `answersTo`; `label` is the choice as it was shown.
 * `reaction`: the sender's reactions on message `on` changed (`on` is the ref the channel gave that message: the
 * person's first version of it, or what `post`/`notice` returned); reactions are named as shown (an emoji, or
 * e.g. `custom emoji`). The channel may not know the place of a reaction: Household does, from `on`.
 * `interaction`: an adapter interaction with a bot post; requires `replyTo`. Routed only to its still-placed author.
 * `external`: the channel's facts that are context for the pet (shown in the header's `channel.meta`; no vendor
 * ids); `kept`: all of its facts, stored with the message for debugging, never shown.
 */
export type InboundMessage = { ref: MessageRef; place?: string; from: Sender; external: External; kept?: External } & (
  | { kind: "text"; text: string; edits?: MessageRef; relayed?: true; replyTo?: MessageRef | PostRef; interaction?: true; attachments?: Attachment[] }
  | { kind: "unsupported"; what: string }
  | { kind: "choice"; answersTo: PostRef; index: number; label: string }
  | { kind: "reaction"; on: MessageRef | PostRef; added: string[]; removed: string[] }
);

/**
 * What a status post shows, in neutral terms: Household builds it, each channel draws it its own way. `working`:
 * one line, what the agent does now; `stop`: the label of a choice under it that stops the agent (a press comes
 * back as a choice on this post, index 0). `over`: one line on a turn that did not finish as it should; a turn
 * that finished leaves no post (`dropStatus`).
 */
export type StatusView = { state: "working"; line: string; stop?: string } | { state: "over"; title: string };

/** The channel refuses for now: nothing more to it for `retryAfterMs` (Telegram's 429). */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`rate limited for ${Math.ceil(retryAfterMs / 1000)} s`);
  }
}

/**
 * The status post cannot be made or changed any more, whatever is tried (deleted, too old to edit, the bot
 * shut out). Any other failure of a status call is passing (network, the service's own trouble): try again.
 */
export class StatusGone extends Error {}

/**
 * A file cannot be downloaded, whatever is tried (too big for the channel to give, gone): the message says why,
 * to the pet. Any other failure of a download is passing: try again.
 */
export class DownloadRefused extends Error {}

/** A pet's own thread, or the house's inbox (where the person writes to the house as a whole). */
export type PlaceKind = "pet-thread" | "house-inbox" | "topic";

/**
 * A place in a channel: where one pet (later: a scout) talks to people. An address inside Household and the
 * channel adapter: tools expose public place addresses with Household channel ids. `id` is Household's
 * (its key, `petPlaceKey` / `inboxKey` in channels.ts: it names its channel), stable and unique in the house; `title` is shown to people as is (Household picks a
 * thread's, emoji included; the inbox's is the channel's own, `Channel.inbox`).
 */
export interface Place {
  id: string;
  kind: PlaceKind;
  title: string;
}

/** Adapter-owned capability, scoped by the app to an authenticated bot's destination.
 * Arguments never select vendor destinations. An optional target is resolved by the app from
 * an owned Household message id. Adapters validate arguments before making API calls.
 */
export interface ChannelTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  target?: "own-post";
  call(context: { place: Place; target?: PostRef; signal?: AbortSignal }, args: Record<string, unknown>): Promise<{ text: string; post?: PostRef }>;
}

/**
 * One chat of a house (a channel of its config), in Household's terms. Every pet placed in it has its own place
 * there (a thread, …); the inbox is where people write to the house as a whole (Telegram: General). Core owns the
 * shape; a channel adapter (src/channel-adapters/<name>/) fills it in and keeps everything about its service to
 * itself (one bot may serve several channels: that is the adapter's business).
 */
export interface Channel {
  /** Only capabilities supported by this particular channel instance. */
  tools?(): ChannelTool[];
  /** What the channel calls its inbox (Telegram: General). */
  readonly inbox: string;
  /** User messages in the inbox are discarded before routing, journaling or commands. */
  readonly ignoreInboxMessages?: boolean;
  /** Stop controls in a shared conversation target its configured default pet. */
  readonly stopDefaultPet?: boolean;
  /** Adapter-discovered shared topics, persisted by the adapter; routed to the channel's default bot. */
  listPlaces?(): Place[];
  /** Optional capability: create a shared topic without assigning it to a particular bot. */
  createPlace?(title: string): Promise<Place>;
  /** This pet's place is shown directly in the inbox, so forwarding notices would duplicate the conversation. */
  inInbox?(place: Place): boolean;
  /** Whether sender `ref` is the person the config names by `id` (in `people.owners`: a Telegram user id, …). */
  isSender(ref: SenderRef, id: string): boolean;
  /**
   * Starts receiving messages. A failing `onMessage` never stops receiving. For a press, what `onMessage` resolves
   * to is told to the one who pressed (Telegram: the press's answer), if anything.
   */
  start(onMessage: (message: InboundMessage) => Promise<string | void>): void;
  stop(): Promise<void>;
  /**
   * The pet's own words, in its adapter's declared replyFormat, in its place, with choices to press under them (under the last part, if cut). Resolves
   * to handles on what was posted: every part, in order (the last has the choices).
   */
  post(place: Place, text: string, choices?: Choices, format?: ReplyMode): Promise<PostRef[]>;
  /** Replace one pet-authored text post in place. Choices are the complete remaining keyboard. */
  editPost?(place: Place, ref: PostRef, text: string, choices?: Choices, format?: ReplyMode): Promise<void>;
  /** Upload a pet's file to its own place, with native photo/voice presentation when requested. */
  sendAttachment?(place: Place, attachment: OutgoingAttachment, signal?: AbortSignal): Promise<PostRef>;
  /** A heading followed by a native quotation; channels without it use ordinary text. */
  quote?(place: Place, heading: string, body: string): Promise<PostRef[]>;
  /** A notice from Household itself, in a place; it looks like nothing a pet can post. Choices as for `post`. */
  notice(place: Place, text: string, choices?: Choices, format?: "plain" | "html"): Promise<PostRef[]>;
  /**
   * New choices on a notice (one of Household's cards), e.g. the marks of a multi-select so far, or the next step
   * of a card; `note` is a line under its text that asks them (left out, a note shown before goes). A `replacement`
   * is the notice's whole new text; its `link` (with no choices) is the only button under it, a channel without
   * such buttons leaves it out.
   */
  setChoices(ref: PostRef, choices: Choices, note?: string, replacement?: { text: string; format?: "plain" | "html"; link?: LinkButton }): Promise<void>;
  /**
   * The choices of a post or notice give way to `outcome` (what was chosen, or why nothing will be), shown under
   * its text: no more presses.
   */
  resolve(ref: PostRef, outcome: string): Promise<void>;
  /**
   * A status post of Household's (one pet's turn as it goes, `StatusView`), posted silently: it notifies no one.
   * Cut to the channel's limit. Neither it nor `editStatus` waits when the channel
   * asks to (`RateLimited`); `StatusGone` when it never will work.
   */
  postStatus(place: Place, view: StatusView): Promise<PostRef>;
  /** The status post shows `view` now. Throws as `postStatus`. */
  editStatus(ref: PostRef, view: StatusView): Promise<void>;
  /** The status post goes away. Throws when it could not (it then stays). */
  dropStatus(ref: PostRef): Promise<void>;
  /** Refresh the native typing indicator, if supported. Abort when the turn ends. */
  typing?(place: Place, signal: AbortSignal): Promise<void>;
  /** This platform cannot delete user messages; managed secrets may stay in the chat, never in a pet. */
  readonly retainsIncomingSecrets?: true;
  /** Remove a sensitive incoming message before it enters Household history. */
  removeMessage?(ref: MessageRef): Promise<void>;
  /** The person's message `ref` reached its pet. */
  delivered(ref: MessageRef): Promise<void>;
  /**
   * Household's reaction on a message of the chat becomes `emoji`; undefined takes it away. Throws if refused.
   * Household has one reaction per message: it replaces the one before, the 👀 of `delivered` too.
   */
  react(ref: MessageRef | PostRef, emoji: string | undefined): Promise<void>;
  /**
   * The place is titled `place.title` now (called on every reload, for every pet's place): one shown under another
   * title is renamed (Telegram: its thread); none is made for it. Never throws: a refusal is logged, and the place
   * goes on under its old title.
   */
  retitle(place: Place): Promise<void>;
  /**
   * The bytes of a file a message came with (`Attachment.file`); `DownloadRefused` when it will never come.
   * Abort with `signal` to give up.
   */
  download?(attachment: Attachment, signal: AbortSignal): Promise<Uint8Array>;
  /** Ensure a configured pet's place exists, without posting a message. Safe to repeat on reload. */
  ensurePlace?(place: Place): Promise<void>;
  /**
   * An address that opens the place in the channel's own apps (Telegram: `https://t.me/<bot>/<thread>`), made
   * first if it is not there yet; undefined when the channel has none for it (the inbox, no bot username).
   */
  placeLink?(place: Place): Promise<string | undefined>;
  /**
   * The place goes, with every message in it, for good (Telegram: its thread is deleted). False when it never was
   * (no thread made for it, or gone already). Throws when the channel refused.
   */
  removePlace?(place: Place): Promise<boolean>;
}
