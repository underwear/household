import { telegramBotToken } from "../channel-adapters/telegram";
import type { ChannelConfig, ChannelKinds, FieldCheck } from "../core/channels";
import { HouseholdError } from "../core/errors";
import type { Household } from "../core/household";
import type { AlsoChannel } from "../infra/config-store";

/** What checks each kind's fields that have a check: by kind, then by field key. */
export type ChannelChecks = ReadonlyMap<string, ReadonlyMap<string, FieldCheck>>;

/**
 * The FieldChecks of the kinds' fields, from their adapter packages: one bot token check for every Telegram kind
 * (it asks the Bot API at `telegramApi`, the real one when absent). Make one per process: it remembers what it
 * learnt of the tokens it saw (a bot's @username).
 */
export function channelChecks(telegramApi?: string): ChannelChecks {
  const botToken = telegramBotToken(telegramApi);
  return new Map([["telegram-private", new Map([["token", botToken]])]]);
}

const fieldOf = (channel: ChannelConfig, key: string) => (channel as unknown as Record<string, unknown>)[key];

/**
 * A channel's own fields as a form gives them (`chat`: the channel's, when it is edited), checked: a value of a
 * field with a check is accepted by it (it throws what is wrong; one the channel has already is not asked about
 * again) and kept as it says (trimmed); an empty one is refused. One bot, one house: a token of a bot another
 * house's channel runs is refused. The house's other channels on the same bot with another token take the new one
 * too (`also`), so the bot runs on one token.
 */
export async function checkFields(
  kinds: ChannelKinds,
  checks: ChannelChecks,
  kind: string,
  given: Record<string, string>,
  { household, house, chat }: { household: Household; house: string; chat?: string },
): Promise<{ own: Record<string, string>; also: AlsoChannel[] }> {
  const own: Record<string, string> = { ...given };
  const also: AlsoChannel[] = [];
  const spec = kinds.get(kind);
  const current = household.houses.find((each) => each.name === house)?.channels.find((channel) => channel.chat === chat);
  for (const [key, raw] of Object.entries(given)) {
    const check = checks.get(kind)?.get(key);
    if (!check) continue;
    const value = raw.trim();
    if (!value) throw new HouseholdError(`${spec?.fields.find((field) => field.key === key)?.label ?? key} is required`);
    if (current && fieldOf(current, key) === value) {
      own[key] = value;
      continue;
    }
    const accepted = await check.accept(value);
    own[key] = accepted.value;
    for (const other of household.houses) {
      for (const channel of other.channels) {
        const theirs = fieldOf(channel, key);
        if (channel.kind !== kind || typeof theirs !== "string" || check.identityOf(theirs) !== accepted.identity) continue;
        if (other.name !== house) throw new HouseholdError(`${accepted.shown} is house ${other.name}'s bot, and a bot serves one house`);
        if (channel.chat !== chat && theirs !== accepted.value) also.push({ chat: channel.chat, fields: { [key]: accepted.value } });
      }
    }
  }
  return { own, also };
}

/** How the channel's fields that have a check are shown (its bot's @username), by key, from memory; null for a value that is not such. */
export function fieldsShown(checks: ChannelChecks, channel: ChannelConfig): Record<string, string | null> {
  return Object.fromEntries(
    [...(checks.get(channel.kind) ?? new Map<string, FieldCheck>())].map(([key, check]) => {
      const value = fieldOf(channel, key);
      return [key, typeof value === "string" ? check.describe(value) : null];
    }),
  );
}
