import type { Channel, InboundMessage, Place, SenderRef } from "../core/channel";
import { PLAIN_REPLY_FORMAT, audienceOf, channelKey, channelName, channelsOf, inboxKey, parsePlaceKey, petPlaceKey, platformOf, type ChannelConfig } from "../core/channels";
import { HouseholdError } from "../core/errors";
import type { HeaderChannel, Trust } from "../core/header";
import { petPlace, trustOf, type House, type Pet } from "../core/household";
import { expectId } from "../core/ids";
import type { EventLog } from "../infra/event-log";
import type { ChatIds, KeyValueStore } from "../infra/sqlite-store";
import { knownChannelKinds } from "./kinds";

/** A channel of a house's config as opened: the channel, or why it cannot be (logged). */
export type Opened = { channel: Channel; problem?: undefined } | { channel?: undefined; problem: string };

/**
 * The channels the houses' configs list, by house and channel key (`channelKey`), asked on every reload: a
 * channel that has not changed since the last call is the same instance (it goes on as it is); a new instance
 * is a channel to start (the one it replaces, if any, stops).
 */
export type OpenChannels = (houses: House[]) => Map<string, Map<string, Opened>>;

interface Line {
  house: House;
  /** The house's open channels, by key. */
  channels: Map<string, Channel>;
  /** Why the others the config lists are not open, by key. */
  problems: Map<string, string>;
}

/** Somewhere in a house's chat: a place in one of its channels (by key), and the channel if open. */
export interface Spot {
  key: string;
  channel?: Channel;
  place: Place;
}

/**
 * Where a pet's words go when they name no channel: its spot, or why there is none to take (`problem`: it was
 * last written to in a channel that is not open now, or that it has left; never another channel instead).
 * Neither for a pet in no channel.
 */
export type Target = { spot: Spot; problem?: undefined } | { spot?: undefined; problem?: string };

/** Where a pet was last written to: persisted across daemon restarts. */
const lastPlaceKey = (house: string, pet: string) => `chat.last-place.${house}/${pet}`;

/** Configured channel connections and pet addressing; conversation state stays in Chat. */
export class ChatChannels {
  private readonly lines = new Map<string, Line>();

  constructor(
    private readonly open: OpenChannels,
    private readonly events: EventLog,
    private readonly records: ChatIds & KeyValueStore,
    private readonly stopWaitMs: number,
  ) {}

  house(name: string): House | undefined {
    return this.lines.get(name)?.house;
  }

  /** A receiver from a replaced channel must not deliver late updates. */
  accepts(house: string, key: string, channel: Channel): boolean {
    return this.lines.get(house)?.channels.get(key) === channel;
  }

  /** The live status remains valid only while its channel and pet placement do. */
  livePlace(house: string, pet: string, place: string): { channel?: Channel; placed: boolean } {
    const line = this.lines.get(house);
    const at = parsePlaceKey(place);
    const config = at && line?.house.channels.find((candidate) => channelKey(candidate) === at.channel);
    const placed = config !== undefined && config.pets.includes(pet) && line!.house.pets.some(({ name }) => name === pet);
    return { channel: at && line?.channels.get(at.channel), placed };
  }

  /** Remember a delivered message's channel, including inbox messages delivered to the pet's own place. */
  rememberLast(house: string, pet: string, spot: Spot): void {
    this.records.set(lastPlaceKey(house, pet), spot.place.id);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.lines.values()].flatMap((line) => [...line.channels.values()].map((channel) => channel.stop())));
    this.lines.clear();
  }

  /**
   * Follows the config (at the start and on every reload): houses, pets (their places renamed with their emoji and
   * title), people, who is placed in which channel, and the channels themselves. A channel the config no longer lists stops, one it lists anew opens and starts, one
   * whose connection changed (another bot) is reopened; the rest go on as they are. A channel that cannot open (its
   * bot secret missing) is retried on the next call. Resolves once the channels that go have stopped and the new
   * ones started (stopped first: a bot that moves to another channel is never polled twice).
   */
  async setHouses(
    houses: House[],
    receive: (house: string, key: string, channel: Channel, message: InboundMessage) => Promise<string | void>,
    disconnect: (channels: Channel[]) => Promise<void>,
  ): Promise<void> {
    const opened = this.open(houses);
    const wanted = new Set(houses.map((house) => house.name));
    const stopping: Channel[] = [];
    const starting: { house: string; key: string; channel: Channel }[] = [];
    for (const [name, line] of this.lines) {
      if (wanted.has(name)) continue;
      this.lines.delete(name);
      stopping.push(...line.channels.values());
    }
    for (const house of houses) {
      this.mintChannels(house);
      const before = this.lines.get(house.name)?.channels ?? new Map<string, Channel>();
      const line: Line = { house, channels: new Map(), problems: new Map() };
      for (const [key, { channel, problem }] of opened.get(house.name) ?? []) {
        if (problem !== undefined) line.problems.set(key, problem);
        else line.channels.set(key, channel);
        if (channel && before.get(key) !== channel) starting.push({ house: house.name, key, channel });
      }
      const gone = [...before].filter(([key, channel]) => line.channels.get(key) !== channel).map(([, channel]) => channel);
      stopping.push(...gone);
      this.lines.set(house.name, line);
      this.forgetGoneChannels(house);
    }
    // End conversations on the old channels before any of their connections stop.
    await disconnect(stopping);
    await Promise.all(stopping.map((channel) => this.stopChannel(channel)));
    for (const { house, key, channel } of starting) channel.start((message) => receive(house, key, channel, message));
    this.retitle();
  }

  /**
   * Every pet's place in every open channel, under its title now: a channel renames a place it shows under another
   * (the pet's emoji or title changed), in the background (a reload does not wait on Telegram).
   */
  private retitle(): void {
    for (const { house, channels } of this.lines.values()) {
      for (const config of house.channels) {
        const key = channelKey(config);
        const channel = channels.get(key);
        if (!channel) continue;
        for (const pet of house.pets.filter(({ name }) => config.pets.includes(name))) {
          const place = petPlace(pet, petPlaceKey(pet.name, key));
          channel.retitle(place).catch((error) => this.events.error(`a place was not renamed: ${(error as Error).message}`));
          channel.ensurePlace?.(place).catch((error) => this.events.error(`a place was not created for ${house.name}/${pet.name}: ${(error as Error).message}`));
        }
      }
    }
  }

  /** Stops a channel that goes, waiting for it `stopWaitMs` at most (then logged): a reload is never held for long. */
  private async stopChannel(channel: Channel): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), this.stopWaitMs)));
    const stopped = channel.stop().then(
      () => "stopped" as const,
      (error) => void this.events.error(`a channel did not stop cleanly: ${(error as Error).message}`),
    );
    if ((await Promise.race([stopped, late])) === "late") {
      this.events.error(`a channel did not stop within ${this.stopWaitMs / 1000} s (still handling an update?): going on without it`);
    }
    clearTimeout(timer);
  }

  /** Where the house's pets were last written to, when that channel is no longer the house's: forgotten (the first channel they are in takes over). */
  private forgetGoneChannels(house: House): void {
    const listed = new Set(house.channels.map(channelKey));
    for (const { name } of house.pets) {
      const at = parsePlaceKey(this.records.get(lastPlaceKey(house.name, name)));
      if (at && !listed.has(at.channel)) this.records.delete(lastPlaceKey(house.name, name));
    }
  }

  /** Why the house's channel (by key) is not open, when the config lists it and it could not open. */
  problem(house: string, key: string): string | undefined {
    return this.lines.get(house)?.problems.get(key);
  }

  /** Household's ids of the house's channels, minted in config order the first time a channel is seen. */
  private mintChannels(house: House): void {
    for (const channel of house.channels) this.records.channelId(house.name, channelKey(channel));
  }

  /**
   * A channel of the house as a header shows it: Household's id of it, its kind, name and audience, and `meta`,
   * the channel's facts that are context (as it split them).
   */
  headerChannel(house: string, config: ChannelConfig, meta?: HeaderChannel["meta"]): HeaderChannel {
    return {
      id: this.records.channelId(house, channelKey(config)),
      kind: config.kind,
      name: channelName(knownChannelKinds(), config),
      audience: audienceOf(knownChannelKinds(), config.kind),
      replyFormat: knownChannelKinds().get(config.kind)?.replyFormat ?? PLAIN_REPLY_FORMAT,
      ...(meta ? { meta } : {}),
    };
  }

  /**
   * The pet's place in the channel it named (to reply, to react): Household's id of a channel it is placed in now.
   * Throws, saying what to use instead, when not (no such channel, one the pet is not in or has left): never a
   * fallback to another.
   */
  chosen(house: string, spots: Spot[], channel: string): Spot {
    expectId("channel", channel);
    const key = this.records.channelKeyOf(house, channel);
    const spot = key === undefined ? undefined : spots.find((candidate) => candidate.key === key);
    if (spot) return spot;
    const yours = spots.map((candidate) => this.records.channelId(house, candidate.key)).join(", ") || "none";
    const what = key === undefined ? `there is no channel ${channel} in your house` : `${channel} is not one of your channels`;
    throw new HouseholdError(`${what} (yours: ${yours}): use one of them, or leave channel out`);
  }

  /**
   * The pet's place in the channel a message came through (from its place): that channel only, never another; a
   * problem when the pet has left it or it is not open.
   */
  spotOfMessage(house: string, pet: string, place: string): Target {
    const at = this.spotAt(house, place);
    const spot = at && this.spotsOf(house, pet).spots.find((candidate) => candidate.key === at.key);
    if (!at) return {};
    if (!spot) return { problem: `${pet} is no longer in channel ${this.records.channelId(house, at.key)}, which the message came through` };
    return spot.channel ? { spot } : { problem: `channel ${this.records.channelId(house, at.key)}, which the message came through, is not open now` };
  }

  /** The pet, and its place in each channel of the house it is placed in (in config order); none for a pet the house does not have. */
  spotsOf(house: string, pet: string): { found?: Pet; spots: Spot[] } {
    const line = this.lines.get(house);
    const found = line?.house.pets.find((candidate) => candidate.name === pet);
    if (!line || !found) return { spots: [] };
    const spots = channelsOf(line.house, pet).map((config) => {
      const key = channelKey(config);
      return { key, channel: line.channels.get(key), place: petPlace(found, petPlaceKey(pet, key)) };
    });
    return { found, spots };
  }

  /**
   * Where the pet's words go when they name no channel: its place where it was last written to ("answer where
   * you were asked"). When that channel is not open, or the pet has left it, a problem naming it:
   * never another channel instead. Only a pet never written to yet gets its place in the first channel of the
   * house it is in that is open (any, if none is). Neither for a pet in no channel.
   */
  target(house: string, pet: string): Target {
    const { spots } = this.spotsOf(house, pet);
    const last = this.records.get(lastPlaceKey(house, pet));
    if (last === undefined) {
      const first = spots.find((spot) => spot.channel) ?? spots[0];
      return first ? { spot: first } : {};
    }
    const spot = spots.find((candidate) => candidate.place.id === last);
    const at = parsePlaceKey(last);
    const id = at ? this.records.channelId(house, at.channel) : last;
    const yours = spots.map((candidate) => this.records.channelId(house, candidate.key)).join(", ") || "none";
    if (!spot) return { problem: `you were last written to in channel ${id}, which you are no longer in: pass channel (yours: ${yours})` };
    if (!spot.channel) return { problem: `channel ${id}, where you were last written to, is not open now (see the daemon's log): pass another channel (yours: ${yours})` };
    return { spot };
  }

  /** The channel a place of the house is in: its key, and the channel if open. */
  spotAt(house: string, place: string): Omit<Spot, "place"> | undefined {
    const line = this.lines.get(house);
    const at = parsePlaceKey(place);
    if (!line || !at) return undefined;
    return { key: at.channel, channel: line.channels.get(at.channel) };
  }

  /** A channel's inbox (its General), by its key. */
  inbox(key: string, channel: Channel | undefined): Place {
    return { id: inboxKey(key), kind: "house-inbox", title: channel?.inbox ?? "inbox" };
  }

  /** How far Household trusts a sender: one of the house's owners, as one of its open channels knows them, or a guest. */
  trust(house: string, ref: SenderRef): Trust {
    const line = this.lines.get(house);
    if (!line) return "guest";
    // An owner is told apart by the open channels of their platform, each in its own terms.
    return trustOf(line.house.people, (owner) =>
      line.house.channels.some((config) => platformOf(knownChannelKinds(), config.kind) === owner.platform && line.channels.get(channelKey(config))?.isSender(ref, owner.id) === true),
    );
  }
}
