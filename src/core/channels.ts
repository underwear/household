import type { House, Pet } from "./household";
import { petTitle } from "./household";

/**
 * The chats a house is in. A channel is one chat: a private chat with the house's bot now
 * (`telegram-private`, threads on), a group later. Its pets are placed in it explicitly; each has its own place
 * there (a thread), and what is addressed to none of them (General) goes to the channel's default pet.
 */
export const CHANNEL_KINDS = ["telegram-private", "slack-private"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * The platforms people are on, as Household tells them apart: an owner is a platform's (one id serves every
 * channel of the platform, whatever its kind). A fixed set: a new one (WhatsApp) is one more name here and its
 * adapter's `PlatformSpec`.
 */
export const PLATFORMS = ["telegram", "slack"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** A field a channel kind asks for (a bot token, a chat id, …), as a form shows it: text, for now. */
export interface ChannelKindField {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** A code-like value (an id, a token): typed character for character. */
  mono?: boolean;
  /** Long (a bot token): on a row of its own in a form. */
  wide?: true;
}

/**
 * What checks a channel field's value on the server when a form gives it (its kind's adapter package has it): its
 * shape, then with its service; says whose it is (a bot's id: one bot, one house) and what it is (a bot's
 * @username) — never repeating the value in what it says.
 */
export interface FieldCheck {
  /** The value as it is kept (trimmed), whose it is and how to show it; throws a HouseholdError saying what is wrong. */
  accept(value: string): Promise<{ value: string; identity: string; shown: string }>;
  /** Whose a value is (its bot's id), from the value alone; undefined for one that is not such a value. */
  identityOf(value: string): string | undefined;
  /** Some platforms reveal bot identity only through an authenticated API call. */
  identify?(value: string): Promise<string | undefined>;
  /** How to show a value (its bot's @username), from what is known now (never waits); null when it is not such a value. */
  describe(value: string): string | null;
}

/** A glyph as SVG path data, drawn inline by the web UI in the text's colour (monochrome, like the UI's own icons). */
export interface Icon {
  viewBox: string;
  d: string;
}

/**
 * Who may read what is said in a channel, as the pet is told (`channel.audience`): `private`, only an owner (a
 * private chat of an owner); `group`, other people may (K3). From the channel's kind alone.
 */
export type Audience = "private" | "group";

/**
 * A kind of channel as its adapter describes it (as an agent adapter lists its models), the one source of what a
 * kind is: its platform (several kinds may share one: Telegram's private chats now, its groups later), who reads
 * it, its label (also the name of a channel the config names not), a line on it, the field that names the
 * channel (the config's `chat`: given when it is added, never changed; another one is another channel), and its
 * other fields. The fields every channel has (name, pets, default) are not among them.
 */
export interface ReplyFormat {
  name: string;
  instructions: string;
  rich?: { name: string; instructions: string };
}

export const PLAIN_REPLY_FORMAT: ReplyFormat = { name: "plain-text", instructions: "Send plain text without markup." };

export interface ChannelKindSpec {
  /** Adapter-owned contract for the text accepted by Channel.post. */
  replyFormat?: ReplyFormat;
  kind: ChannelKind;
  platform: Platform;
  audience: Audience;
  label: string;
  description: string;
  chat: ChannelKindField;
  fields: ChannelKindField[];
}

/** The kinds of channel a build knows, by kind (the app's registry). */
export type ChannelKinds = ReadonlyMap<string, ChannelKindSpec>;

/**
 * How a platform's people are told apart, as its adapter describes it, once per platform: what an owner's id is
 * (for a form) and whether a given one is one (the server's check).
 */
export interface PlatformSpec {
  platform: Platform;
  label: string;
  /** Its mark, on its channels and owners in the web UI. */
  icon: Icon;
  ownerId: { label: string; placeholder?: string; hint?: string };
  valid: (id: string) => boolean;
}

/** A kind's platform; undefined for a kind the build does not know. */
export const platformOf = (kinds: ChannelKinds, kind: string): Platform | undefined => kinds.get(kind)?.platform;

/** A kind's audience; `group` for a kind the build does not know (the safer guess). */
export const audienceOf = (kinds: ChannelKinds, kind: string): Audience => kinds.get(kind)?.audience ?? "group";

/**
 * One channel of a house, as configured. `token` is its bot's token (Telegram's, from @BotFather). `chat` is the chat's
 * id in its service (a private chat's is its person's Telegram user id) and also its filter: nothing from a chat
 * not listed is heard. `pets` are placed in it; `default` gets what is addressed to none of them (it must be
 * given with two or more pets; with one, that one is it).
 */
export interface ChannelConfig {
  kind: ChannelKind;
  name?: string;
  /** The owner's own words about it («test bot, delete later»): for the web UI only, never told to a pet or a chat. */
  note?: string;
  token: string;
  /** Slack Socket Mode credential; host-only, never included in pet prompts. */
  appToken?: string;
  chat: string;
  pets: string[];
  default?: string;
}

/** The channel's name: the config's, or its kind's label. Shown to pets in the header, and in the UI. */
export const channelName = (kinds: ChannelKinds, channel: ChannelConfig) => channel.name ?? kinds.get(channel.kind)?.label ?? channel.kind;

/**
 * Names a channel inside Household, in its places' keys: from what it is (kind, chat), never from where it is in
 * the list, what it is called or which token its bot runs on, so reordering, renaming or rotating the token
 * keeps its places, threads and history. One house has one channel per kind and chat.
 */
export const channelKey = ({ kind, chat }: Pick<ChannelConfig, "kind" | "chat">) => `${kind}:${chat}`;

/** The pet that gets what is addressed to no pet of the channel; none for a channel without pets. */
export const defaultPet = (channel: ChannelConfig): string | undefined => channel.default ?? channel.pets[0];

/**
 * A channel's pets and default once `pet` joins it: one joining a channel of one pet makes two, so the default it
 * had (that pet, or the one named) stays; a pet alone needs none.
 */
export function joining(channel: { pets: string[]; default?: string | null }, pet: string): { pets: string[]; default?: string } {
  const pets = channel.pets.includes(pet) ? channel.pets : [...channel.pets, pet];
  return pets.length > 1 ? { pets, default: channel.default ?? channel.pets[0] } : { pets };
}

/** The channels of the house the pet is placed in, in config order. */
export const channelsOf = (house: House, pet: string) => house.channels.filter((channel) => channel.pets.includes(pet));

/**
 * What a place of a house is, inside Household: a pet's own place in a channel, or a channel's inbox (General).
 * Its key is stable, so a pet that leaves a channel and comes back has the same place. Public addresses replace the channel key with its Household channel id.
 */
export const petPlaceKey = (pet: string, channel: string) => `pet:${pet}@${channel}`;
export const inboxKey = (channel: string) => `inbox@${channel}`;

/** The channel (key) and, for a pet's place, the pet a place key names; undefined for anything else. */
export function parsePlaceKey(key: string | undefined): { channel: string; pet?: string } | undefined {
  const at = key?.indexOf("@") ?? -1;
  if (key === undefined || at < 0) return undefined;
  const [what, channel] = [key.slice(0, at), key.slice(at + 1)];
  if (what === "inbox") return { channel };
  return what.startsWith("pet:") ? { channel, pet: what.slice(4) } : undefined;
}

/**
 * A bot serves one house: a token that channels of two houses give, one line each (the second house's). Two
 * tokens of one bot are only told apart by its kind's adapter (the daemon then keeps the bot with the house it
 * serves, and a form refuses another house's bot).
 */
export function botProblems(houses: House[]): string[] {
  const owner = new Map<string, string>();
  const problems: string[] = [];
  for (const house of houses) {
    for (const [index, channel] of house.channels.entries()) {
      const first = owner.get(channel.token);
      if (first !== undefined && first !== house.name) problems.push(`houses.${house.name}.channels[${index}].token: the same bot as house ${first}'s, and a bot serves one house`);
      else owner.set(channel.token, house.name);
    }
  }
  return problems;
}

/** The names a person may call a pet by: its name, title and aliases. */
export const petNames = (pet: Pet) => [...new Set([pet.name, petTitle(pet), ...(pet.aliases ?? [])])];

/**
 * What is wrong with the house's channels, one line each (none: fine): the same chat twice, a pet that is not the house's or listed twice, a default missing (two pets or more) or not one of the
 * channel's pets, and two pets of one channel answering to the same name (names, titles, aliases; case does not
 * count).
 */
export function channelProblems(house: House): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  house.channels.forEach((channel, index) => {
    const at = `houses.${house.name}.channels[${index}]`;
    const key = channelKey(channel);
    if (seen.has(key)) problems.push(`${at}: the same chat as an earlier channel (${channel.kind}, chat ${channel.chat})`);
    seen.add(key);
    const listed = new Set<string>();
    for (const name of channel.pets) {
      if (!house.pets.some((pet) => pet.name === name)) problems.push(`${at}.pets: '${name}' is not a pet of house ${house.name}`);
      if (listed.has(name)) problems.push(`${at}.pets: '${name}' is listed twice`);
      listed.add(name);
    }
    if (channel.default === undefined && channel.pets.length > 1) problems.push(`${at}: default is required when a channel has two pets or more (one of ${channel.pets.join(", ")})`);
    if (channel.default !== undefined && !channel.pets.includes(channel.default)) problems.push(`${at}.default: '${channel.default}' is not one of the channel's pets`);
    const owner = new Map<string, string>();
    for (const pet of house.pets.filter(({ name }) => listed.has(name))) {
      for (const name of petNames(pet)) {
        const folded = name.toLocaleLowerCase();
        const other = owner.get(folded);
        if (other !== undefined && other !== pet.name) problems.push(`${at}: pets ${other} and ${pet.name} both answer to '${name}'`);
        owner.set(folded, pet.name);
      }
    }
  });
  return problems;
}
