import type { SecretRequests } from "./secret-requests";
import { withFiles, type OutgoingAttachment, type Attachment } from "../core/attachment";
import { DownloadRefused, type Channel, type Choices, type ReplyMode, type InboundMessage, type Place, type PostRef } from "../core/channel";
import { inboxKey, channelKey, channelName, channelsOf, parsePlaceKey, petPlaceKey, type ChannelConfig } from "../core/channels";
import type { DialogAnswer, DialogQuestion } from "../core/dialog";
import { HouseholdError } from "../core/errors";
import { headAndTail } from "../core/excerpt";
import type { Header, HeaderEvent } from "../core/header";
import { petDisplay, petPlace, petTitle, type House } from "../core/household";
import { expectId } from "../core/ids";
import { batchable, type ChannelFacts, type ChatRecord, type ChatSender, type Message, type NewChatMessage } from "../core/message";
import { addressee, routedPet } from "../core/routing";
import { carriesHouseholdTag } from "../core/tags";
import type { EventLog } from "../infra/event-log";
import type { ChatIds, ChatRecords, KeyValueStore } from "../infra/sqlite-store";
import { ChatChannels, type OpenChannels, type Spot, type Target } from "./chat-channels";
import { quote } from "./dialog-cards";
import type { Board, Dialogs } from "./dialogs";
import type { Delivery, DeliveryUpdate } from "./delivery";
import type { Conversation } from "./history";
import { TokenBucket } from "./token-bucket";
import { knownChannelKinds } from "./kinds";
import { Live, LIVE_TIMING, type LiveTiming } from "./live";
import { CLOCK, type Clock } from "../core/clock";

export type { Opened, OpenChannels } from "./chat-channels";

/** `/stop`: the channel takes off the bot's own name (Telegram: `/stop@house_bot`); one for another bot keeps it. */
const STOP_COMMAND = /^\/stop$/i;

/** What a stop came to, for the one who pressed the button. */
const STOP_TOASTS = { stopped: "Stopped", idle: "Nothing to stop", failed: "Could not stop" };

/** What a person who is not the owner is told when they press one of Household's cards. */
const OWNER_ONLY = "Only the owner can answer";
/** What a channel calls content Household cannot take yet, as people do. */
const UNSUPPORTED_NAMES: Record<string, string> = { poll: "Polls", dice: "Dice", game: "Games", story: "Stories" };

/** "1 message", "3 messages": as the count wants. */
const messageCount = (count: number) => `${count} ${count === 1 ? "message" : "messages"}`;

export interface ChatLimits {
  /** A pet's replies: at most this long (four Telegram messages), this many a minute, in bursts of `replyBurst`. */
  replyChars: number;
  repliesPerMinute: number;
  replyBurst: number;
  /**
   * A pet's dialogs put to the person: this many a minute, in bursts of `dialogBurst` (a real agent has one at a
   * time; the rest is a flood), each waited on this long.
   */
  dialogsPerMinute: number;
  dialogBurst: number;
  dialogWaitMs: number;
  /**
   * How long a permission the agent asks for (may it run this?) waits for the person: Household is its only
   * timer (the agent's own is off), and refuses it after. Permissions are not counted with dialogs: an agent in a
   * mode that asks may ask often, and each one holds it.
   */
  permissionWaitMs: number;
  /** How long a reload waits for a channel that goes to stop (an update it is still handling), at most. */
  stopWaitMs: number;
}

/** How long a pet's dialog waits for the person. Its agent's own limit must be longer (claude's hook timeout). */
export const DIALOG_WAIT_MS = 30 * 60_000;

const LIMITS: ChatLimits = {
  replyChars: 32768,
  repliesPerMinute: 12,
  replyBurst: 6,
  dialogsPerMinute: 1,
  dialogBurst: 5,
  dialogWaitMs: DIALOG_WAIT_MS,
  permissionWaitMs: 30_000,
  stopWaitMs: 5_000,
};

/** A pet's reactions a minute (bursts of 10): cheap, but they must not flood the chat. */
const REACTIONS_PER_MINUTE = 20;

/** Posts with choices Household follows, and posts already resolved, are kept up to this many each. */
const MAX_CARDS = 1000;
/** A reply's buttons: at most this many rows of this many, each label one line of this many characters. */
export const BUTTONS = { rows: 4, perRow: 4, labelChars: 64 };

/** What a pet's agent is told when the channel its dialog was put to goes away (a reload removed or reopened it). */
const CHANNEL_GONE = "the channel this was put to your human in was disconnected (the config changed): ask again, with the reply tool if you need to";

/** What the security system tells the person about a message it refused, in the place they wrote it. */
const REJECTED = "Message not passed on: it carries a Household service tag";

type Choice = Extract<InboundMessage, { kind: "choice" }>;
type Reaction = Extract<InboundMessage, { kind: "reaction" }>;

/** A message's header but its event: who wrote, the channel and its facts. */
type Envelope = Omit<Header, "event">;

/**
 * One of Household's own posts with choices (a dialog's card): what a press on it does, given the choice's index
 * and its label as shown. What it resolves to is told to the one who pressed.
 */
interface Card {
  house: string;
  onPress: (index: number, label: string) => Promise<string | void>;
}

/**
 * A card of Household's its owner answers in steps, on one post, as a small state machine: `text` stays, each
 * state (from `start`) shows its choices, with a `note` under the text if it has one, until a press (`press`)
 * leads to a state that is an outcome (shown under the text instead).
 */
export interface OwnerCard<S> {
  text: string;
  format?: "plain" | "html";
  start: S;
  view(state: S): { choices: Choices; note?: string; text?: string } | { outcome: string; text?: string };
  press(state: S, index: number): S;
  /** Optional asynchronous action after an owner press (e.g. opening an approved preview). */
  act?(state: S, index: number): Promise<S>;
  /** Whole-card replacement when cancelled or timed out. */
  cancelledText?(): string;
  /** The card is up: its handle, to rewrite it later (`rewrite`), after it is answered. */
  posted?(notice: PostedNotice): void;
}

/**
 * One of Household's notices, by where it is and its handle there: plain data, kept across restarts, so the notice
 * can be rewritten later (`Chat.rewrite`) as long as its channel is the house's.
 */
export interface PostedNotice { place: string; ref: PostRef }

/** The label of the button that opens a pet's own place (its thread). */
export const OPEN_PLACE = "Open thread";

/** What a message says, as kept with it: its files named before it, a press is its label, a reaction what changed. */
function textOf(message: InboundMessage): string {
  switch (message.kind) {
    case "text":
      return withFiles(message.text, message.attachments);
    case "unsupported":
      return `(${message.what})`;
    case "choice":
      return message.label;
    case "reaction":
      return [...message.added.map((name) => `${name} added`), ...message.removed.map((name) => `${name} removed`)].join(", ");
  }
}

/** Adds to a set or map, dropping the oldest entries beyond MAX_CARDS. */
function keep<K>(entries: Set<K> | Map<K, unknown>, key: K, add: () => void): void {
  entries.delete(key);
  add();
  if (entries.size > MAX_CARDS) entries.delete(entries.keys().next().value!);
}

/** The buttons with each label on one line; throws, saying why, when they are over the limits. */
function checkButtons(rows: Choices): Choices {
  const { rows: maxRows, perRow, labelChars } = BUTTONS;
  const labels = rows.map((row) => row.map((label) => label.replace(/\s+/g, " ").trim()));
  if (labels.length === 0 || labels.length > maxRows) throw new HouseholdError(`buttons need 1 to ${maxRows} rows`);
  if (labels.some((row) => row.length === 0 || row.length > perRow)) throw new HouseholdError(`a row of buttons needs 1 to ${perRow} labels`);
  if (labels.flat().some((label) => !label || label.length > labelChars)) throw new HouseholdError(`a button label needs 1 to ${labelChars} characters`);
  return labels;
}

/**
 * Each house's chat with its people, through the channels it is in: a person's message goes to one pet (the
 * routing rule, core/routing.ts) through Delivery; pets' replies and Household's notices go to the pet's place in
 * a channel: the one named, or where the pet was last written to. A house without channels still has pets: they
 * just cannot reply, notices only reach the log, and dialogs stay in the pet's session.
 */
/** A notice of Household's that it rewrites in place: where it was posted, and its handle there. */
export interface LiveNotice { channel: Channel; ref: PostRef }

export class Chat {
  private readonly channels: ChatChannels;
  private secretRequests?: Pick<SecretRequests, "handle">;

  setSecretRequests(requests: Pick<SecretRequests, "handle">): void { this.secretRequests = requests; }

  /** Secret prompts must fail visibly when there is no channel, never silently become a log line. */
  async secretNotice(house: string, pet: string, text: string): Promise<void> {
    const { spot, problem } = this.currentTarget(house, pet);
    if (problem || !spot?.channel) throw new HouseholdError("No chat is available for secret entry");
    const refs = await spot.channel.notice(spot.place, text, undefined, "html");
    this.posted(house, pet, spot.place, refs, { kind: "household" }, text);
  }
  /** Messages of the inbox whose notes (where they went) are posted, by `house/channel/id`: none twice. */
  private readonly noted = new Set<string>();
  /** Places of pets gone from their channel that were told so this run, by `house/id`. */
  private readonly told = new Set<string>();
  private readonly budgets = new Map<string, TokenBucket>();
  /**
   * Household's cards this run follows (a press goes to whoever posted it). A press on one from an earlier run is
   * stale: what waited for it is gone. A pet's replies need no following: their record says whose they are.
   */
  private readonly cards = new Map<PostRef, Card>();
  /** House-owned approvals, including cards whose post is still in flight. */
  private readonly ownerChoices = new Map<Channel, Set<() => void>>();
  /** The boards (one per dialog) whose cards each channel shows: a channel that goes ends their dialogs. */
  private readonly asking = new Map<Channel, Set<Board>>();
  /** Posts whose choice is made or given up on: a later press (one more before the buttons went) is ignored. */
  private readonly resolved = new Set<PostRef>();
  /** Each pet's turn as it goes, in one status post (the live message). */
  private readonly live: Live;

  constructor(
    private readonly delivery: Pick<Delivery, "send" | "answered" | "reject" | "interrupt">,
    open: OpenChannels,
    private readonly events: EventLog,
    private readonly dialogs: Dialogs,
    /**
     * Every message of the chat under Household's id (the person's, pets' and Household's own), the ids of places
     * and people, and where each pet was last written to.
     */
    private readonly records: ChatRecords & ChatIds & KeyValueStore,
    private readonly limits = LIMITS,
    live: { timing?: LiveTiming; clock?: Clock } = {},
  ) {
    this.channels = new ChatChannels(open, events, records, limits.stopWaitMs);
    this.live = new Live(events, live.timing ?? LIVE_TIMING, live.clock ?? CLOCK);
  }

  /** Reconcile connections before moving live status to the current channel placements. */
  async setHouses(houses: House[]): Promise<void> {
    await this.channels.setHouses(
      houses,
      (house, key, channel, message) => this.receive(house, key, channel, message),
      async (stopping) => {
        for (const channel of stopping) for (const cancel of this.ownerChoices.get(channel) ?? []) cancel();
        await Promise.all(stopping.flatMap((channel) => [...(this.asking.get(channel) ?? [])].map((board) => this.dialogs.refuse(board, CHANNEL_GONE, "Channel disconnected"))));
        for (const channel of stopping) this.asking.delete(channel);
      },
    );
    this.live.sync((house, pet, place) => this.channels.livePlace(house, pet, place));
  }

  /** Why a configured channel could not open. */
  problem(house: string, key: string): string | undefined {
    return this.channels.problem(house, key);
  }

  /**
   * A file a person's message in `place` came with, from that place's channel as it is open now. A channel that is
   * not open (yet) is a passing failure; one that is no longer the house's, or cannot give files, refuses.
   */
  download(house: string, place: string | undefined, attachment: Attachment, signal: AbortSignal): Promise<Uint8Array> {
    const at = place === undefined ? undefined : this.channels.spotAt(house, place);
    if (!at || !this.channels.house(house)?.channels.some((config) => channelKey(config) === at.key)) {
      return Promise.reject(new DownloadRefused("the channel it came through is gone"));
    }
    if (!at.channel) return Promise.reject(new Error("the channel it came through is not open right now"));
    if (!at.channel.download) return Promise.reject(new DownloadRefused("this channel does not give files"));
    return at.channel.download(attachment, signal);
  }

  /**
   * A House-owned card (`OwnerCard`): only owner button presses move it, never free text or an agent's reply.
   * Resolves to the state of its outcome; undefined when it closed first (abort, its channel gone, not posted).
   */
  private readonly turnPlaces = new Map<string, { turn?: string; place?: string }>();

  private currentTarget(house: string, pet: string): Target {
    if (!this.turnPlaces.has(`${house}/${pet}`)) return this.channels.target(house, pet);
    try { return this.destination(house, pet); }
    catch (error) { return { problem: (error as Error).message }; }
  }

  private destination(house: string, pet: string, channel?: string, place?: string): Target {
    if (channel !== undefined && place !== undefined) throw new HouseholdError("Pass place or legacy channel, not both");
    if (place !== undefined) return { spot: this.channels.chosenPlace(house, pet, place) };
    if (channel !== undefined) return { spot: this.channels.chosen(house, this.channels.spotsOf(house, pet).spots, channel) };
    const context = this.turnPlaces.get(`${house}/${pet}`);
    if (context?.place) return { spot: this.channels.chosenPlace(house, pet, this.channels.publicPlace(house, { id: context.place, kind: "pet-thread", title: pet }).id) };
    const spots = this.channels.spotsOf(house, pet).spots;
    if (spots.length === 0) return {};
    if (spots.length === 1) return { spot: spots[0]! };
    return { problem: "No unambiguous request place; pass place explicitly (use places)" };
  }

  places(house: string, pet: string) {
    return this.channels.spotsOf(house, pet).spots.flatMap(spot => {
      const config = this.channels.house(house)!.channels.find(c => channelKey(c) === spot.key)!;
      const channel = this.channels.headerChannel(house, config);
      const places = [spot.place, this.channels.inbox(spot.key, spot.channel)];
      return places.filter((p, i) => places.findIndex(other => other.id === p.id) === i).map(place => ({
        ...this.channels.publicPlace(house, place), channel: channel.id, channelKind: channel.kind,
        channelName: channel.name, available: !!spot.channel, placement: ["same", "thread"],
      }));
    });
  }

  spawnPlace(house: string, pet: string, place?: string): { channel: string; origin: string; publicOrigin: string } {
    const target = this.destination(house, pet, undefined, place);
    if (!target.spot?.channel) throw new HouseholdError(target.problem ?? "The requested place is not open");
    const own = this.channels.spotsOf(house, pet).spots.find(spot => spot.key === target.spot!.key);
    if (parsePlaceKey(target.spot.place.id)?.pet && own?.place.id !== target.spot.place.id) throw new HouseholdError("Spawn in your own place or the inbox, not another helper’s temporary place");
    return { channel: target.spot.key, origin: target.spot.place.id, publicOrigin: this.channels.publicPlace(house, target.spot.place).id };
  }

  targetChannel(house: string, pet: string): string | undefined { return this.currentTarget(house, pet).spot?.key; }

  ownerCard<S>(house: string, pet: string, card: OwnerCard<S>, signal: AbortSignal, channelKey?: string, origin?: string): Promise<S | undefined> {
    const spot = origin ? this.channels.chosenPlace(house, pet, this.channels.publicPlace(house, { id: origin, kind: "pet-thread", title: pet }).id) : channelKey === undefined ? this.currentTarget(house, pet).spot : this.channels.spotsOf(house, pet).spots.find(spot => spot.key === channelKey);
    if (signal.aborted || !this.channels.spotsOf(house, pet).found || !spot?.channel) return Promise.resolve(undefined);
    return this.ownerCardAt(house, pet, spot, card, signal);
  }

  private ownerCardAt<S>(house: string, pet: string, spot: Spot, card: OwnerCard<S>, signal: AbortSignal): Promise<S | undefined> {
    if (signal.aborted || !spot.channel) return Promise.resolve(undefined);
    const channel = spot.channel;
    const first = card.view(card.start);
    if ("outcome" in first) throw new Error("an owner card starts with choices");
    let state = card.start;
    let shown = first;
    const { promise, resolve } = Promise.withResolvers<S | undefined>();
    let ref: PostRef | undefined;
    let settled = false;
    let pressing = false;
    const finish = (outcome?: string, replacement?: string) => {
      if (settled) return;
      settled = true;
      this.ownerChoices.get(channel)?.delete(abort);
      if (this.ownerChoices.get(channel)?.size === 0) this.ownerChoices.delete(channel);
      signal.removeEventListener("abort", abort);
      resolve(outcome === undefined ? undefined : state);
      if (ref) {
        if (replacement !== undefined) void channel.setChoices(ref, [], undefined, { text: replacement, format: card.format }).catch(() => this.resolve(house, channel, ref!, outcome ?? "Request closed"));
        else void this.resolve(house, channel, ref, outcome ?? "Request closed");
      }
    };
    const abort = () => finish(undefined, card.cancelledText?.());
    const waiting = this.ownerChoices.get(channel) ?? new Set<() => void>();
    waiting.add(abort);
    this.ownerChoices.set(channel, waiting);
    signal.addEventListener("abort", abort, { once: true });
    const live = this.live.turnOf(house, pet);
    void channel.notice(spot.place, card.text, first.choices, card.format).then((refs) => {
      this.live.replied(live, { channel, place: spot.place });
      this.posted(house, pet, spot.place, refs, { kind: "household" }, card.text);
      const posted = refs.at(-1)!;
      ref = posted;
      try { card.posted?.({ place: spot.place.id, ref: posted }); } catch { /* the card goes on without it */ }
      // Cancellation or a reload may win while Telegram is posting the card.
      if (settled || !this.channels.accepts(house, spot.key, channel)) {
        finish();
        void this.resolve(house, channel, ref, "Request closed");
        return;
      }
      this.follow(posted, {
        house,
        onPress: async (index, label) => {
          // A press on buttons the card has since replaced (a second one before they changed) moves nothing.
          if (settled || pressing || shown.choices.flat()[index] !== label) return;
          const before = { state, shown };
          pressing = true;
          try {
            const changed = card.act ? await card.act(state, index) : card.press(state, index);
            if (settled) return;
            state = changed;
          } finally { pressing = false; }
          const next = card.view(state);
          if ("outcome" in next) return finish(next.outcome, next.text);
          shown = next;
          await channel.setChoices(posted, next.choices, next.note, next.text === undefined ? undefined : { text: next.text, format: card.format }).catch((error) => {
            // The buttons shown stay the ones that answer.
            ({ state, shown } = before);
            this.events.error(`pet ${house}/${pet}: a card was not updated: ${(error as Error).message}`);
          });
        },
      });
    }).catch(() => finish());
    return promise;
  }

  /**
   * The pet's `reply`: posts to its place in one of its channels, with buttons to press if given (a press comes
   * back to the pet as a message). `channel`, Household's id, is where the pet was last written to when left out;
   * any channel the pet is in is taken (its place there: pets never post in General). Throws when it cannot, so
   * the pet learns it was not sent: also when it is too long, its buttons are over the limits, or the pet replies
   * too often (a pet must not flood the chat its notices share). Resolves to Household's ids of the post and of
   * the channel it went to.
   */
  replyFormat(house: string, pet: string, channel?: string, place?: string) {
    const { found, spots } = this.channels.spotsOf(house, pet);
    if (!found) throw new HouseholdError(`unknown pet ${house}/${pet}`);
    const target = this.destination(house, pet, channel, place);
    if (target.problem) throw new HouseholdError(target.problem);
    if (!target.spot) throw new HouseholdError("no chat channel is available");
    const config = this.channels.house(house)!.channels.find(item => channelKey(item) === target.spot!.key)!;
    const header = this.channels.headerChannel(house, config);
    return { channel: header.id, ...header.replyFormat };
  }

  async reply(house: string, pet: string, text: string, buttons?: Choices, channel?: string, format: ReplyMode = "regular", place?: string): Promise<{ id: string; channel: string; place?: string }> {
    if (format === "rich" && !this.replyFormat(house, pet, channel, place).rich) throw new HouseholdError("this channel does not support rich replies");
    return this.publish(house, pet, text, buttons, channel, undefined, undefined, format, place);
  }

  /** Edit only a single text reply authored by this pet; never notices, files, or another pet's post. */
  async editReply(house: string, pet: string, channel: string, id: string, text: string): Promise<{ id: string; channel: string }> {
    if (!text.trim()) throw new HouseholdError("the text is empty");
    if (text.length > this.limits.replyChars) throw new HouseholdError(`the text is over ${this.limits.replyChars} characters: shorten it`);
    if (carriesHouseholdTag(text)) throw new HouseholdError("the text carries a Household tag (household-…): not edited");
    const { found, spots } = this.channels.spotsOf(house, pet);
    if (!found) throw new HouseholdError(`unknown pet ${house}/${pet}`);
    const spot = this.channels.chosen(house, spots, channel);
    expectId("message", id);
    const record = this.records.inJournal(house, pet, channel, id) ? this.records.recordById(house, channel, id) : undefined;
    if (!record || record.pet !== pet || record.sender.kind !== "pet" || record.sender.name !== pet || record.place !== spot.place.id)
      throw new HouseholdError(`${id} is not your own reply in channel ${channel}`);
    if (!record.outgoing || record.outgoing.parts !== 1)
      throw new HouseholdError("Only single-message text replies can be edited; files, split replies and legacy posts cannot. Send a new reply instead.");
    if (!spot.channel?.editPost) throw new HouseholdError("this channel is unavailable or does not support editing replies");
    if (!this.budget("replies", house, pet).take()) throw new HouseholdError("too many replies or edits: wait a little");
    await spot.channel.editPost(spot.place, record.ref as PostRef, text, record.resolved ? undefined : record.outgoing.buttons, record.outgoing.format);
    this.records.revise(house, record.ref, record.ref, text, headAndTail(text), record.facts ?? {});
    // A press can resolve the keyboard while Telegram is accepting/retrying the edit.
    if (!record.resolved && this.records.recordByRef(house, record.ref)?.resolved)
      await spot.channel.setChoices(record.ref as PostRef, []);
    return { id, channel };
  }

  async sendAttachment(house: string, pet: string, attachment: OutgoingAttachment, channel?: string, signal?: AbortSignal, place?: string): Promise<{ id: string; channel: string; place?: string }> {
    return this.publish(house, pet, `(${attachment.kind}) ${attachment.name}${attachment.caption ? `: ${attachment.caption}` : ""}`, undefined, channel, attachment, signal, "regular", place);
  }

  private async publish(house: string, pet: string, text: string, buttons?: Choices, channel?: string, attachment?: OutgoingAttachment, signal?: AbortSignal, format: ReplyMode = "regular", place?: string): Promise<{ id: string; channel: string; place?: string }> {
    if (!text.trim()) throw new HouseholdError("the text is empty");
    const { replyChars, repliesPerMinute } = this.limits;
    if (text.length > replyChars) throw new HouseholdError(`the text has ${text.length} characters, over ${replyChars}: shorten it`);
    const choices = buttons && checkButtons(buttons);
    if (carriesHouseholdTag([text, choices])) throw new HouseholdError("the text or a button carries a Household tag (household-…): not sent, write it some other way");
    const { found, spots } = this.channels.spotsOf(house, pet);
    if (!found) throw new HouseholdError(`unknown pet ${house}/${pet}`);
    const target = this.destination(house, pet, channel, place);
    if (target.problem) throw new HouseholdError(`${target.problem}; the reply was not sent`);
    const { spot } = target;
    if (!spot) {
      const none = this.channels.house(house)?.channels.length ? `${pet} is placed in no channel of house ${house}` : `house ${house} has no chat set up`;
      throw new HouseholdError(`${none}; the reply was not sent`);
    }
    const open = spot.channel;
    const where = { ...spot.place, title: petPlace(found, "").title };
    if (!open) {
      const config = this.channels.house(house)?.channels.find((candidate) => channelKey(candidate) === spot.key);
      throw new HouseholdError(`channel ${config ? channelName(knownChannelKinds(), config) : spot.key} of house ${house} is not open (see the daemon's log); the reply was not sent`);
    }
    if (!this.budget("replies", house, pet).take()) throw new HouseholdError(`too many replies (over ${repliesPerMinute} a minute): not sent, wait a little`);
    const live = this.live.turnOf(house, pet);
    if (attachment && !open.sendAttachment) throw new HouseholdError("this channel does not support sending files");
    const posted = attachment ? [await open.sendAttachment!(where, attachment, signal)] : await open.post(where, text, choices, format);
    this.live.replied(live, { channel: open, place: where });
    const record = this.posted(house, pet, where, posted, { kind: "pet", name: pet }, text, attachment ? undefined : { format, parts: posted.length, ...(choices ? { buttons: choices } : {}) });
    this.delivery.answered(house, pet);
    return { id: record.id, channel: this.records.channelId(house, spot.key), place: this.channels.publicPlace(house, where).id };
  }

  /**
   * The pet's `react`: its reaction (Household's, in the channel; one per message) on message `id` of channel
   * `channel` (Household's ids), one of the pet's own journal; an empty emoji takes it away. Throws when it
   * cannot: a channel the pet is not placed in (any more), a message not in its journal (one error, whether there
   * is no such message, another pet's, or Household's own notice: nothing to probe), too many reactions, or the
   * channel refusing the emoji.
   */
  async react(house: string, pet: string, channel: string, id: string, emoji: string): Promise<{ id: string; reaction: string | null }> {
    const { found, spots } = this.channels.spotsOf(house, pet);
    if (!found) throw new HouseholdError(`unknown pet ${house}/${pet}`);
    const spot = this.channels.chosen(house, spots, channel);
    expectId("message", id);
    const record = this.records.inJournal(house, pet, channel, id) ? this.records.recordById(house, channel, id) : undefined;
    if (!record) throw new HouseholdError(`${id} is not one of your messages in channel ${channel}: react to a message you got or sent (event.id in a header, or the id reply returned)`);
    const open = spot.channel;
    if (!open) throw new HouseholdError(`channel ${channel} is not open now (see the daemon's log)`);
    if (!this.budget("reactions", house, pet).take()) throw new HouseholdError(`too many reactions (over ${REACTIONS_PER_MINUTE} a minute): wait a little`);
    const reaction = emoji.trim() || undefined;
    await open.react(record.ref, reaction);
    return { id: record.id, reaction: reaction ?? null };
  }

  /**
   * A dialog of the pet's agent, put to the person where the pet was last written to; resolves to their answer
   * (see `Dialogs.ask`). Undefined, so the dialog stays in the pet's session, when the pet has no chat or asks
   * too often; then the person is told (now and then) that something waits in the terminal. Refused, with why,
   * when the pet was last written to in a channel that is not open or that it has left (never put elsewhere).
   */
  async ask(house: string, pet: string, dialog: DialogQuestion, signal?: AbortSignal): Promise<DialogAnswer | undefined> {
    const { found } = this.channels.spotsOf(house, pet);
    const name = `${house}/${pet}`;
    const target = this.currentTarget(house, pet);
    if (found && target.problem) {
      this.events.error(`pet ${name}: a dialog was refused: ${target.problem}`);
      return { kind: "refused", message: `Household could not put this to your human: ${target.problem}. Ask with the reply tool instead, naming one of your channels.` };
    }
    if (!found || !target.spot?.channel) {
      this.events.info(`pet ${name}: a dialog stays in the terminal (no chat)`);
      return undefined;
    }
    const permission = dialog.kind === "permission";
    if (!permission && !this.budget("dialogs", house, pet).take()) {
      this.events.error(`pet ${name}: a dialog stays in the terminal (too many dialogs)`);
      if (this.budget("terminal notices", house, pet).take()) {
        void this.notice(house, pet, "Too many questions in a row. Answer in the terminal: `house pet attach`");
      }
      return undefined;
    }
    const waitMs = permission ? this.limits.permissionWaitMs : this.limits.dialogWaitMs;
    const answer = await this.dialogs.ask({ pet: name, title: petDisplay(found), board: this.board(house, pet), waitMs }, dialog, signal);
    this.live.decided(house, pet, dialog); // the live line shows what the pet does next
    return answer;
  }

  /**
   * The pet's conversation, for its history (which reads the pet's journal only): the channels it is placed in,
   * as a header shows them, and how far Household trusts a sender now (no open channel: no one is the owner).
   * Undefined for a pet the house does not have.
   */
  conversation(house: string, pet: string): Conversation | undefined {
    const configured = this.channels.house(house);
    if (!configured?.pets.some(({ name }) => name === pet)) return undefined;
    const channels = channelsOf(configured, pet).map((config) => this.channels.headerChannel(house, config));
    return { channels, trust: (ref) => this.channels.trust(house, ref) };
  }

  /** A notice from Household where the pet was last written to; the log gets it when the chat cannot. Never throws. */
  /** A visible copy of peer correspondence; never routes back into either agent's inbox. */
  async peerMessage(house: string, from: string, to: string, text: string): Promise<void> {
    const title = (name: string) => {
      const pet = this.channels.spotsOf(house, name).found;
      return pet ? petTitle(pet) : name;
    };
    const heading = `💬 ${title(from)} → ${title(to)}:`;
    const shown = `${heading}\n\n${text.split(/\r?\n/).map(line => `> ${line}`).join("\n")}`;
    const participants = [from, to].map(name => this.channels.spotsOf(house, name).found);
    const helper = participants.find(p => p?.originPlace && participants.some(other => other && other.name === (p.sideworker?.parent ?? p.scout?.parent)));
    const parent = helper?.sideworker?.parent ?? helper?.scout?.parent;
    const postedPlaces = new Set<string>();
    const results = await Promise.allSettled([from, to].map(async pet => {
      const target = pet === parent && helper?.originPlace
        ? { spot: this.channels.chosenPlace(house, pet, this.channels.publicPlace(house, { id: helper.originPlace, kind: "pet-thread", title: pet }).id) }
        : this.currentTarget(house, pet);
      if (target.problem) throw new Error(target.problem);
      const spot = target.spot;
      if (!spot?.channel) return;
      const physical = spot.channel.inInbox?.(spot.place) ? inboxKey(spot.key) : spot.place.id;
      if (postedPlaces.has(physical)) return;
      postedPlaces.add(physical);
      const refs = spot.channel.quote
        ? await spot.channel.quote(spot.place, heading, text)
        : await spot.channel.post(spot.place, shown);
      this.posted(house, pet, spot.place, refs, { kind: "household" }, shown);
    }));
    if (results.some(result => result.status === "rejected")) {
      this.events.error(`pet ${house}/${from}: peer message chat copy to ${to} failed`);
      throw new Error("A chat copy could not be posted");
    }
  }

  notice(house: string, pet: string, text: string): Promise<void> {
    return this.noticeTo(house, pet, this.currentTarget(house, pet), text);
  }

  /**
   * A Household notice that changes as it goes (a scout's start, then its outcome): posted where the pet is now and
   * rewritten in place later. None while the pet has no chat place (yet). Never throws.
   */
  async liveNotice(house: string, pet: string, text: string): Promise<LiveNotice | undefined> {
    const { spot } = this.currentTarget(house, pet);
    if (!spot?.channel) return undefined;
    try {
      const refs = await spot.channel.notice(spot.place, text, undefined, "html");
      this.posted(house, pet, spot.place, refs, { kind: "household" }, text);
      return { channel: spot.channel, ref: refs.at(-1)! };
    } catch (error) {
      this.events.error(`pet ${house}/${pet}: notice not sent (${(error as Error).message})`);
      return undefined;
    }
  }

  /** A live notice shows `text` now; a failed edit leaves it as it was. */
  async editLiveNotice(notice: LiveNotice, text: string): Promise<void> {
    await notice.channel.setChoices(notice.ref, [], undefined, { text, format: "html" }).catch(() => {});
  }

  /**
   * Capture the worker's places before lifecycle reconciliation removes its routing. With `remove`, they go then,
   * with all their messages (its channels that can: Telegram deletes the threads); where none could, a notice
   * there says it was stopped.
   */
  prepareSideworkerCloseNotice(house: string, pet: string, kind = "Sideworker", remove = false): () => Promise<void> {
    const target = this.currentTarget(house, pet);
    const { found, spots } = this.channels.spotsOf(house, pet);
    const title = found ? petTitle(found) : pet;
    return async () => {
      if (remove && !found?.chatPlace) {
        let removed = false;
        for (const spot of spots) {
          if (!spot.channel?.removePlace) continue;
          try { removed = (await spot.channel.removePlace(spot.place)) || removed; }
          catch (error) { this.events.error(`pet ${house}/${pet}: its place was not removed (${(error as Error).message})`); }
        }
        if (removed) return;
      }
      return this.noticeTo(house, pet, target, `${kind} ${title} has finished; its VM was removed. Conversation history stays here.`);
    };
  }

  /**
   * The address that opens `pet`'s place where its words go (`target`), when its channel has one; else undefined.
   * Never throws.
   */
  async placeLink(house: string, pet: string): Promise<string | undefined> {
    const { spot } = this.currentTarget(house, pet);
    if (!spot?.channel?.placeLink) return undefined;
    return spot.channel.placeLink(spot.place).catch((error) => {
      this.events.error(`pet ${house}/${pet}: no link to its place (${(error as Error).message})`);
      return undefined;
    });
  }

  /**
   * An HTML notice of Household's in `pet`'s place, with a button that opens `linkTo`'s place under it when given
   * (and its channel has such links). Resolves to its handle, to rewrite it later; undefined when it could not be
   * posted. Never throws.
   */
  async announce(house: string, pet: string, text: string, linkTo?: string, origin?: string): Promise<PostedNotice | undefined> {
    const spot = origin ? this.channels.chosenPlace(house, pet, this.channels.publicPlace(house, { id: origin, kind: "pet-thread", title: pet }).id) : this.currentTarget(house, pet).spot;
    if (!spot?.channel) return undefined;
    try {
      const refs = await spot.channel.notice(spot.place, text, undefined, "html");
      this.posted(house, pet, spot.place, refs, { kind: "household" }, text);
      const notice = { place: spot.place.id, ref: refs.at(-1)! };
      if (linkTo !== undefined) await this.rewrite(house, notice, text, linkTo);
      return notice;
    } catch (error) {
      this.events.error(`pet ${house}/${pet}: notice not sent (${(error as Error).message})`);
      return undefined;
    }
  }

  /**
   * A notice of Household's (`announce`, an owner card once answered) says `text` now (HTML), with no buttons but
   * one that opens `linkTo`'s place, when given and its channel has such links. Never throws: a notice whose channel
   * is gone, or that cannot be edited any more, stays as it was.
   */
  async rewrite(house: string, notice: PostedNotice, text: string, linkTo?: string): Promise<void> {
    const channel = this.channels.spotAt(house, notice.place)?.channel;
    if (!channel) return;
    const url = linkTo === undefined ? undefined : await this.placeLink(house, linkTo);
    await channel.setChoices(notice.ref, [], undefined, { text, format: "html", ...(url ? { link: { label: OPEN_PLACE, url } } : {}) })
      .catch((error) => this.events.error(`house ${house}: a notice was not rewritten (${(error as Error).message})`));
  }

  /**
   * `owner`'s places in every channel `via` is in go, with all their messages, for good: a pet no longer in the
   * config (an ended scout) has them there, as its pet's. Resolves to how many went (0: there were none). Throws
   * when no channel of `via` can remove places, or one refused.
   */
  canRemovePlaces(house: string, via: string, channel?: string): boolean {
    return this.channels.spotsOf(house, via).spots.some(spot => (channel === undefined || spot.key === channel) && !!spot.channel?.removePlace);
  }

  async removePlaces(house: string, via: string, owner: string, channel?: string): Promise<number> {
    const { spots } = this.channels.spotsOf(house, via);
    const able = spots.filter((spot) => (channel === undefined || spot.key === channel) && spot.channel?.removePlace);
    if (able.length === 0) throw new HouseholdError("this chat cannot delete threads: delete it in the chat app yourself");
    let removed = 0;
    for (const spot of able) {
      const place = { id: petPlaceKey(owner, spot.key), kind: "pet-thread" as const, title: owner };
      if (await spot.channel!.removePlace!(place)) removed++;
    }
    return removed;
  }

  onDelivery(update: DeliveryUpdate): void {
    const { house, pet } = update;
    if (update.kind === "notification") { void this.notice(house, pet, update.text); return; }
    if (update.kind === "turn-finished") {
      const context = this.turnPlaces.get(`${house}/${pet}`);
      if (!update.turn || context?.turn === update.turn) this.turnPlaces.delete(`${house}/${pet}`);
      return this.live.finish(house, pet, update.turn);
    }
    if (update.kind === "turn-started") return this.turnStarted(house, pet, update.turn, update.messages);
    if (update.kind === "progress") return this.live.progress(house, pet, update.event);
    if (update.kind === "dialog") {
      // One only the terminal can answer (seen on screen after a restart, or asked without the hook): the person is told.
      const { found } = this.channels.spotsOf(house, pet);
      if (update.dialog === "unknown" && found && this.budget("terminal notices", house, pet).take()) {
        void this.notice(house, pet, `${petTitle(found)} is waiting for an answer in the terminal: \`house pet attach\``);
      }
      return update.dialog ? this.live.dialogOpened(house, pet, update.dialog, update.input) : this.live.dialogClosed(house, pet);
    }
    if (update.kind === "turn-lost") {
      const context = this.turnPlaces.get(`${house}/${pet}`);
      if (!update.turn || context?.turn === update.turn) this.turnPlaces.delete(`${house}/${pet}`);
      return this.live.lost(house, pet, update.why === "failed" ? "failed" : "other", update.turn);
    }
    const { messages } = update;
    if (update.kind === "failed") {
      const worker = !!this.channels.spotsOf(house, pet).found?.sideworker;
      const [first, ...more] = messages.filter((message) => message.origin !== "cron" && (message.origin !== "internal" || worker));
      if (!first) return;
      const what = more.length === 0 ? quote(first.text) : `${quote(first.text)} and ${more.length} more`;
      const text =
        update.why === "interrupted"
          ? `Household restarted while answering ${what}. No reply will come: write again.`
          : `${what} not sent: the agent seems to be in a dialog. \`house pet attach\``;
      // Where the batch came from (never another channel); else where the pet was last written to.
      void this.noticeTo(house, pet, first.place === undefined ? this.currentTarget(house, pet) : this.channels.spotOfMessage(house, pet, first.place), text);
      return;
    }
    const fromChat = messages.filter((message) => message.origin === "chat");
    if (fromChat.length === 0) return;
    let last: Spot | undefined;
    for (const { ref, place } of fromChat) {
      const at = place === undefined ? undefined : this.channels.spotAt(house, place);
      if (!at) continue;
      if (ref !== undefined && at.channel) this.seen(house, at.channel, ref);
      // Written in a channel's inbox, it was delivered in the pet's own place of that channel.
      last = this.channels.spotsOf(house, pet).spots.find((spot) => spot.key === at.key) ?? last;
    }
    if (last) this.channels.rememberLast(house, pet, last);
    void this.passedOn(house, pet, fromChat);
  }

  /**
   * The pet took a prompt. One of Household's messages starts a turn; from the chat, its live message goes where
   * the pet answers them (its place in the channel the last of them came through, as for its reply), from the CLI
   * nowhere. Internal delegated work is visible in a sideworker's thread. The agent's own prompt (no message
   * of Household's) continues the turn going on.
   */
  private turnStarted(house: string, pet: string, turn: string | undefined, messages: Message[]): void {
    if (messages.length === 0) {
      const previous = this.turnPlaces.get(`${house}/${pet}`);
      if (previous) this.turnPlaces.set(`${house}/${pet}`, { ...previous, turn });
      return this.live.continued(house, pet, turn);
    }
    const { found, spots } = this.channels.spotsOf(house, pet);
    if (!found) return;
    const last = messages.filter((message) => message.origin === "chat" && message.place !== undefined).at(-1);
    this.turnPlaces.set(`${house}/${pet}`, { turn, place: last?.place });
    const at = last && this.channels.spotAt(house, last.place!);
    // Delegated work has no chat-origin place. A worker's own thread still shows its native progress;
    // internal reminders delivered to ordinary pets and scheduled tasks remain silent.
    const internalWork = (found.sideworker || found.scout) && messages.some(message => message.origin === "internal");
    const spot = at ? this.currentTarget(house, pet).spot : internalWork ? this.currentTarget(house, pet).spot : undefined;
    this.live.start(house, pet, turn, spot?.channel ? { channel: spot.channel, place: { ...spot.place, title: petPlace(found, "").title } } : undefined);
  }

  /**
   * Stops the pet's turn (its stop button, `/stop`): the agent is interrupted, and its live message collapses as
   * stopped (no agent reports an interruption). False when it is in no turn; a failure is told in its place.
   */
  private async stopPet(house: string, pet: string): Promise<"stopped" | "idle" | "failed"> {
    const turn = this.live.turnOf(house, pet); // the turn being stopped: not one that starts meanwhile
    const { status, leftover } = await this.delivery.interrupt(house, pet, () => this.dialogs.halt(`${house}/${pet}`));
    const title = petTitle(this.channels.spotsOf(house, pet).found ?? { name: pet });
    if (status === "failed") void this.notice(house, pet, `${title} did not stop: \`house pet attach\``);
    if (status === "idle" && turn) this.live.ended(turn); // it was over already (stopped in its terminal, say)
    if (status !== "stopped") return status;
    // Its live message says so; one that showed nothing yet, a notice does.
    if (!(turn && this.live.halt(turn))) void this.notice(house, pet, `${title} stopped`);
    if (leftover) void this.notice(house, pet, `${quote(leftover)} was left unsent in ${title}'s input: \`house pet attach\``);
    return status;
  }

  async stop(): Promise<void> {
    this.live.stop();
    for (const waiting of this.ownerChoices.values()) for (const cancel of waiting) cancel();
    await this.dialogs.stop();
    await this.channels.stop();
  }

  /**
   * A message from one of the house's channels (`key`). Trust is Household's (the house's owners as the channel
   * knows them, never what the message says): a guest is marked, not dropped. The message goes to one pet of the
   * channel (core/routing.ts); one in the place of a pet no longer in the channel goes to none. A message that
   * carries a Household tag (`household-…`) anywhere (text, names, the channel's facts) is refused by the security
   * system before anything reads it. The pet gets the rest under Household's header. Resolves, for a press, to
   * what the one who pressed is told, if anything.
   */
  private async receive(house: string, key: string, channel: Channel, message: InboundMessage, rawApproved?: string): Promise<string | void> {
    const configured = this.channels.house(house);
    const config = configured?.channels.find((candidate) => channelKey(candidate) === key);
    // A channel that is closing (a reload took it away or replaced it) hears no more.
    if (!configured || !config || !this.channels.accepts(house, key, channel)) return this.events.info(`house ${house}: a ${message.kind} through channel ${key}, which is closing, was dropped`);
    // A reaction is where the message it is on was, and for whom (the channel may not know); an edit is for whom the message it changes was.
    const on = message.kind === "reaction" ? this.records.recordByRef(house, message.on) : undefined;
    const original = message.kind === "text" && message.edits !== undefined ? this.records.recordByRef(house, message.edits) : undefined;
    const quoted = message.kind === "text" && message.replyTo !== undefined ? this.records.recordByRef(house, message.replyTo) : undefined;
    const placeId = message.kind === "reaction" ? on?.place : message.place;
    const written = parsePlaceKey(placeId);
    // The pet whose own place of this channel it was written in: one placed in the channel, still the house's.
    const writer = written?.channel === key ? written.pet : undefined;
    const thread = writer !== undefined && config.pets.includes(writer) ? configured.pets.find(({ name }) => name === writer) : undefined;

    const occupants = configured.pets.filter(p => config.pets.includes(p.name) && (p.name === writer || p.chatPlace === placeId));
    const shared = occupants.some(p => p.chatPlace === placeId);
    const addressed = shared && message.kind === "text" && !message.relayed ? addressee(message.text, occupants)?.name : undefined;
    const sharedQuoted = shared && quoted && quoted.place === placeId && occupants.some(p => p.name === quoted.pet) ? quoted.pet : undefined;
    const pet = routedPet(config, configured.pets, {
      about: on?.pet ?? original?.pet ?? addressed ?? sharedQuoted,
      thread: thread?.name,
      // The conversation of the line it quotes, when that line is in this channel.
      quoted: quoted && parsePlaceKey(quoted.place)?.channel === key ? quoted.pet : undefined,
      text: message.kind === "text" && !message.relayed ? message.text : undefined,
    });
    if (rawApproved && pet?.name !== rawApproved) throw new Error("Recipient changed");
    const inbox = this.channels.inbox(key, channel);
    // Written in no pet's place (General): the inbox.
    const place = thread ? petPlace(thread, placeId!) : inbox;
    const spot = { channel, place };
    // Secrets are consumed before security-rejection records, journals, dialogs or agent delivery.
    const trust = this.channels.trust(house, message.from.ref);
    const incomingRef = message.ref;
    const rawEnvelope = message.kind === "text" ? { ...message, text: "" } : undefined;
    if (!rawApproved && message.kind === "text" && this.secretRequests && await this.secretRequests.handle({
      house, pet: pet?.name, text: message.text, owner: trust === "owner", edited: message.edits !== undefined,
      relayed: !!message.relayed,
      sendRaw: async text => {
        if (this.channels.trust(house, message.from.ref) !== "owner") throw new Error("Owner access changed");
        const current = this.channels.house(house);
        const currentChannel = current?.channels.find(candidate => channelKey(candidate) === key);
        if (!pet || !currentChannel?.pets.includes(pet.name) || !current?.pets.some(item => item.name === pet.name)) throw new Error("Recipient changed");
        await this.receive(house, key, channel, { ...rawEnvelope!, text }, pet.name);
      },
      retainsIncomingSecrets: channel.retainsIncomingSecrets,
      remove: async () => {
        if (!channel.removeMessage) throw new Error("This channel cannot remove sensitive messages");
        await channel.removeMessage(incomingRef);
      },
      notice: async text => {
        const refs = await channel.notice(place, text);
        this.posted(house, pet?.name ?? "", place, refs, { kind: "household" }, text);
      },
      choose: (card, signal) => this.ownerCardAt(house, pet?.name ?? "", { key, channel, place }, card, signal),
    })) { message.text = ""; return; }
    if (writer !== undefined && !thread && message.kind !== "choice") return this.gone(house, channel, writer, placeId!);
    if (carriesHouseholdTag(message)) {
      if (pet) return this.rejected(house, pet.name, spot, message);
      return this.events.error(`house ${house}: a ${message.kind} from ${message.from.ref} was rejected by the security system: it carries a Household tag`);
    }
    // A reaction on a message Household has no record of: where it was is not known.
    const unplaced = message.kind === "reaction" && !on;
    const shown = Object.keys(message.external).length > 0 ? message.external : undefined;
    const envelope: Envelope = {
      from: { id: this.records.personId(house, message.from.ref), name: message.from.name, trust },
      channel: this.channels.headerChannel(house, config, shown),
      ...(unplaced ? {} : { place: this.channels.publicPlace(house, place) }),
    };
    const where = { ...(unplaced ? {} : { place: place.id }), ...(message.kept && Object.keys(message.kept).length > 0 ? { facts: message.kept } : {}) };
    // A press goes by the post pressed, so a channel without pets resolves them too.
    if (message.kind === "choice") return this.choose(house, channel, config, message, envelope, where);
    if (!pet) return this.events.error(`house ${house}: a message through channel ${channelName(knownChannelKinds(), config)}, which has no pets, was ignored`);
    if (message.kind === "reaction") return this.reacted(house, pet.name, message, on, envelope, where);
    // An edit is for the pet that got the message it changes; one that has left the channel gets nothing more of it.
    if (original && original.pet !== pet.name) {
      return this.events.info(`house ${house}: an edit of ${original.id} was dropped: ${original.pet || "no pet"} got it, and is not in channel ${channelName(knownChannelKinds(), config)} now`);
    }
    // `/stop` in the pet's own place (not relayed, not an edit): Household stops the pet; the pet never gets it.
    // Kept by its ref in no journal, so a channel replaying it stops nothing twice.
    if (message.kind === "text" && (thread === pet || !thread && channel.inInbox?.(petPlace(pet, petPlaceKey(pet.name, key)))) && message.edits === undefined && !message.relayed && !message.attachments && STOP_COMMAND.test(message.text.trim())) {
      if (this.records.recordByRef(house, message.ref)) return;
      const sender: ChatSender = { kind: "person", ref: message.from.ref, name: message.from.name };
      this.records.remember(house, { refs: [message.ref], place: place.id, pet: pet.name, journals: [], sender, text: message.text, excerpt: message.text });
      const at = { channel, place };
      if (trust !== "owner") return this.noticeIn(house, pet.name, at, "Only the owner can stop it");
      this.seen(house, channel, message.ref);
      if ((await this.stopPet(house, pet.name)) === "idle") await this.noticeIn(house, pet.name, at, `${petTitle(pet)} is not doing anything right now`);
      return;
    }
    const { record, edit } = this.remembered(house, pet.name, place, message, { ...(shown ? { shown } : {}), ...(where.facts ? { kept: where.facts } : {}) });
    const own = { channel, place: petPlace(pet, petPlaceKey(pet.name, key)) };
    if (message.kind === "unsupported") return this.noticeIn(house, pet.name, own, `${UNSUPPORTED_NAMES[message.what] ?? message.what} can't be passed on yet`);
    const { ref, edits, relayed, text, attachments } = message;
    // While a dialog of the pet waits, what its owner writes in the pet's place is the answer (a guest's is a message; files are never one).
    if ((thread === pet || pet.chatPlace === place.id || this.currentTarget(house, pet.name).spot?.place.id === place.id || !thread && channel.inInbox?.(petPlace(pet, petPlaceKey(pet.name, key)))) && trust === "owner" && edits === undefined && !relayed && !attachments && (await this.dialogs.text(`${house}/${pet.name}`, text))) {
      return this.seen(house, channel, ref);
    }
    const event: HeaderEvent = { kind: edit ? "edit" : "message", id: record.id, ...(relayed ? { relayed } : {}) };
    const files = attachments ? { attachments } : {};
    this.delivery.send(house, pet.name, { text, origin: "chat", ref, ...(edits === undefined ? {} : { edits }), header: { event, ...envelope }, ...where, ...files });
  }

  /**
   * A message in the place of a pet no longer in that channel: it goes to nobody. The place is told so once a run
   * (it is not General: the person wrote to that pet), the log every time.
   */
  private async gone(house: string, channel: Channel, pet: string, placeId: string): Promise<void> {
    this.events.info(`house ${house}: a message in the place of ${pet} (${placeId}), which is no longer in that channel, was not delivered`);
    const name = `${house}/${placeId}`;
    if (this.told.has(name)) return;
    keep(this.told, name, () => this.told.add(name));
    const place = petPlace(this.channels.house(house)?.pets.find((candidate) => candidate.name === pet) ?? { name: pet }, placeId);
    await this.noticeIn(house, pet, { channel, place }, `${place.title} is no longer in this channel`);
  }

  /**
   * Messages from a channel's inbox, delivered to the pet: two notes per batch, posted once and never in the
   * poller's way: in the inbox, whose place they went to; in that place, what came (how the first begins and ends,
   * and how many more).
   */
  private async passedOn(house: string, pet: string, delivered: Message[]): Promise<void> {
    const inInbox = ({ place }: Message) => parsePlaceKey(place) !== undefined && parsePlaceKey(place)!.pet === undefined;
    // A message is named by its channel and its id.
    const noted = ({ header }: NewChatMessage) => `${house}/${header.channel.id}/${header.event.id}`;
    const fresh = delivered.filter(batchable).filter((message) => inInbox(message) && !this.noted.has(noted(message)));
    const [first] = fresh;
    const at = first?.place === undefined ? undefined : this.channels.spotAt(house, first.place);
    const own = at && this.channels.spotsOf(house, pet).spots.find((spot) => spot.key === at.key);
    if (!first || !at?.channel || !own) return;
    if (at.channel.inInbox?.(own.place)) return;
    const batch = fresh.filter(({ place }) => place === first.place);
    for (const message of batch) keep(this.noted, noted(message), () => this.noted.add(noted(message)));
    const more = batch.length - 1;
    const count = more === 0 ? "" : ` ${messageCount(batch.length)}`;
    await this.noticeIn(house, pet, { channel: at.channel, place: this.channels.inbox(at.key, at.channel) }, `Passed${count} to the thread "${own.place.title}"`);
    await this.noticeIn(house, pet, own, `From ${at.channel.inbox}: "${headAndTail(withFiles(first.text, first.attachments))}"${more === 0 ? "" : ` and ${more} more`}`);
  }

  /**
   * A message with Household's tag in it: the security system refuses it. It is kept as rejected (no id: no pet
   * ever names it), logged, and the person is told in the place they wrote it; a repeat of it, only dropped.
   */
  private async rejected(house: string, pet: string, spot: { channel: Channel; place: Place }, message: InboundMessage): Promise<void> {
    if (!this.delivery.reject(house, pet, { text: textOf(message), origin: "chat", ref: message.ref })) return;
    this.events.error(`house ${house}: a ${message.kind} from ${message.from.ref} was rejected by the security system: it carries a Household tag`);
    await this.noticeIn(house, pet, spot, REJECTED);
  }

  /**
   * The person's message under Household's id: a new one, or the message an edit changes (with its new text). A
   * text keeps its header's `channel` (an edit's replaces it); an unsupported one never had a header.
   */
  private remembered(
    house: string,
    pet: string,
    place: Place,
    message: Extract<InboundMessage, { kind: "text" | "unsupported" }>,
    facts: ChannelFacts,
  ): { record: ChatRecord; edit: boolean } {
    const text = textOf(message);
    const excerpt = headAndTail(text);
    const said = message.kind === "text" ? { facts } : {};
    const edits = message.kind === "text" ? message.edits : undefined;
    const edited = edits && this.records.revise(house, edits, message.ref, text, excerpt, facts);
    if (edited) return { record: edited, edit: true };
    const sender: ChatSender = { kind: "person", ref: message.from.ref, name: message.from.name };
    const relayed = message.kind === "text" && message.relayed ? { relayed: true as const } : {};
    // The pet it was routed to sees it, in its journal (from General too); no other pet does.
    const record = this.records.remember(house, { refs: [message.ref], place: place.id, pet, journals: [pet], sender, text, excerpt, ...relayed, ...said });
    return { record, edit: false };
  }

  /**
   * What Household or a pet posted, under Household's id (all its pieces; the first is what reactions target): a
   * pet's own words go into its journal; Household's notices and cards into none (a pet cannot reach them).
   */
  private posted(house: string, pet: string, place: Place, refs: PostRef[], sender: ChatSender, text: string, outgoing?: ChatRecord["outgoing"]): ChatRecord {
    const journals = sender.kind === "pet" ? [pet] : [];
    return this.records.remember(house, { refs, place: place.id, pet, journals, sender, text, excerpt: headAndTail(text), ...(outgoing ? { outgoing } : {}) });
  }

  /**
   * A notice from Household where the pet's words go (`target`); when that is a channel the pet cannot be reached
   * in now, only the log gets it, saying why. Never throws.
   */
  private noticeTo(house: string, pet: string, target: Target, text: string): Promise<void> {
    if (target.problem) {
      this.events.error(`pet ${house}/${pet}: notice dropped (${target.problem}): ${text}`);
      return Promise.resolve();
    }
    return this.noticeIn(house, pet, target.spot, text);
  }

  /** A notice from Household in a place, in pet's conversation; the log gets it when the chat cannot. Never throws. */
  private async noticeIn(house: string, pet: string, spot: { channel?: Channel; place: Place } | undefined, text: string): Promise<void> {
    if (!spot?.channel) return this.events.info(`pet ${house}/${pet}: notice (no chat): ${text}`);
    try {
      const live = this.live.turnOf(house, pet);
      const refs = await spot.channel.notice(spot.place, text);
      this.live.replied(live, { channel: spot.channel, place: spot.place });
      this.posted(house, pet, spot.place, refs, { kind: "household" }, text);
    } catch (error) {
      this.events.error(`pet ${house}/${pet}: notice not sent (${(error as Error).message}): ${text}`);
    }
  }

  /** The person's reactions changed on a message: the pet whose conversation it is is told, with what it was (the header shows how it begins). */
  private reacted(house: string, pet: string, reaction: Reaction, on: ChatRecord | undefined, envelope: Envelope, where: Pick<Message, "place" | "facts">): void {
    const { added, removed } = reaction;
    // On a message the pet cannot reach (another's, Household's own notice): nothing to tell it.
    if (on && !this.records.inJournal(house, pet, envelope.channel.id, on.id)) {
      return this.events.info(`house ${house}: a reaction on ${on.id} of ${envelope.channel.id} was dropped: not in ${pet}'s journal`);
    }
    const author = on && this.author(house, pet, on);
    const target = on && { id: on.id, excerpt: on.excerpt, ...(author ? { author } : {}) };
    const event: HeaderEvent = { kind: "reaction", added, removed, ...(target ? { on: target } : {}) };
    this.delivery.send(house, pet, { text: textOf(reaction), origin: "chat", ref: reaction.ref, header: { event, ...envelope }, ...where });
  }

  /** Who wrote a message, for the pet told of a reaction on it: `you`, a person id or `household`. */
  private author(house: string, pet: string, { sender }: ChatRecord): string | undefined {
    if (sender.kind === "household") return "household";
    if (sender.kind === "pet") return sender.name === pet ? "you" : undefined; // another pet's: not in this pet's conversation
    return sender.ref ? this.records.personId(house, sender.ref) : undefined; // records older than M4.1 have no ref
  }

  /**
   * A press. On a pet's reply it goes to that pet, whenever it was posted (the channel vouches for the label:
   * it is the post's own button), once: a reply already answered (its buttons failed to go, say) says so. On one
   * of Household's cards, whatever posted it this run decides, if the owner pressed (anyone else is told only the
   * owner can answer). Anything else (a card from an earlier run, the post of a pet gone from the house or from
   * this channel) says it is stale.
   */
  private async choose(house: string, channel: Channel, config: ChannelConfig, choice: Choice, envelope: Envelope, where: Pick<Message, "place" | "facts">): Promise<string | void> {
    if (this.resolved.has(choice.answersTo)) return;
    // A live message's stop button: the owner's, answered with a toast only (its post is the live message's to change).
    // One whose turn is not the pet's current one stops nothing (never another turn).
    const live = this.live.owns(choice.answersTo);
    if (live?.house === house) {
      if (envelope.from.trust !== "owner") return OWNER_ONLY;
      return live === this.live.turnOf(house, live.pet) ? STOP_TOASTS[await this.stopPet(house, live.pet)] : "Already finished";
    }
    const card = this.cards.get(choice.answersTo);
    // Household's own cards (a pet's dialogs) are its owner's to answer; a pet's own buttons are anyone's.
    if (card?.house === house) return envelope.from.trust === "owner" ? card.onPress(choice.index, choice.label) : OWNER_ONLY;
    const post = this.records.recordByRef(house, choice.answersTo);
    if (post?.resolved) return this.resolve(house, channel, choice.answersTo, "Already answered");
    if (post && this.petsReply(house, post) && config.pets.includes(post.pet)) return this.pressedReply(house, channel, post, choice, envelope, where);
    await this.resolve(house, channel, choice.answersTo, "No longer relevant");
  }

  /** Whether a post is a reply of one of the house's pets, in its own conversation. */
  private petsReply(house: string, { sender, pet }: ChatRecord): boolean {
    return sender.kind === "pet" && sender.name === pet && this.channels.house(house)?.pets.some(({ name }) => name === pet) === true;
  }

  /**
   * A press on a pet's reply (`post`): its buttons give way to the choice, which goes to the pet as a message,
   * with how the post begins and ends (a question is usually at its end).
   */
  private async pressedReply(house: string, channel: Channel, post: ChatRecord, choice: Choice, envelope: Envelope, where: Pick<Message, "place" | "facts">): Promise<void> {
    const { label } = choice;
    this.records.markResolved(house, post.ref);
    await this.resolve(house, channel, choice.answersTo, label);
    const event: HeaderEvent = { kind: "button", label, on: { id: post.id, excerpt: post.excerpt } };
    this.delivery.send(house, post.pet, { text: label, origin: "chat", ref: choice.ref, header: { event, ...envelope }, ...where });
  }

  /** Cards where the pet was last written to, each through the channel it went to. */
  private board(house: string, pet: string): Board {
    const posted = new Map<PostRef, Channel>();
    const board: Board = {
      post: async (text, choices, onPress) => {
        const { spot, problem } = this.currentTarget(house, pet);
        if (!spot?.channel) throw new HouseholdError(problem ?? `house ${house} has no chat any more`);
        const live = this.live.turnOf(house, pet);
        const refs = await spot.channel.notice(spot.place, text, choices);
        this.live.replied(live, { channel: spot.channel, place: spot.place });
        this.posted(house, pet, spot.place, refs, { kind: "household" }, text);
        const card = refs.at(-1)!; // the piece with the choices
        posted.set(card, spot.channel);
        const asking = this.asking.get(spot.channel) ?? this.asking.set(spot.channel, new Set()).get(spot.channel)!;
        keep(asking, board, () => asking.add(board)); // the newest MAX_CARDS: older dialogs are long over
        this.follow(card, { house, onPress });
        return card;
      },
      setChoices: async (ref, choices) => {
        await posted
          .get(ref)
          ?.setChoices(ref, choices)
          .catch((error) => this.events.error(`pet ${house}/${pet}: a card was not updated: ${(error as Error).message}`));
      },
      resolve: (ref, outcome) => this.resolve(house, posted.get(ref), ref, outcome),
    };
    return board;
  }

  private follow(posted: PostRef, card: Card): void {
    keep(this.cards, posted, () => this.cards.set(posted, card));
  }

  /** A post's choices give way to `outcome`, once; it is followed no more. Never throws (failures are logged). */
  private async resolve(house: string, channel: Channel | undefined, ref: PostRef, outcome: string): Promise<void> {
    this.cards.delete(ref);
    keep(this.resolved, ref, () => this.resolved.add(ref));
    await channel?.resolve(ref, outcome).catch((error) => this.events.error(`house ${house}: buttons not replaced: ${(error as Error).message}`));
  }

  /** A pet's budget of replies, of dialogs, and of notices that a dialog stays in the terminal (one per 10 minutes). */
  private budget(kind: "replies" | "dialogs" | "terminal notices" | "reactions", house: string, pet: string): TokenBucket {
    const name = `${kind} ${house}/${pet}`;
    const { repliesPerMinute, replyBurst, dialogsPerMinute, dialogBurst } = this.limits;
    const [perMinute, burst] = {
      replies: [repliesPerMinute, replyBurst],
      dialogs: [dialogsPerMinute, dialogBurst],
      "terminal notices": [0.1, 1],
      reactions: [REACTIONS_PER_MINUTE, 10],
    }[kind];
    if (!this.budgets.has(name)) this.budgets.set(name, new TokenBucket(perMinute! / 60, burst!));
    return this.budgets.get(name)!;
  }

  /** Marks the person's message as taken (cosmetic: a failure is only logged). */
  private seen(house: string, channel: Channel, ref: InboundMessage["ref"]): void {
    channel.delivered(ref).catch((error) => this.events.error(`house ${house}: "seen" mark failed: ${(error as Error).message}`));
  }
}
