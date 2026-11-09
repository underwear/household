import type { SenderRef } from "../core/channel";
import { HouseholdError } from "../core/errors";
import type { HeaderChannel, Trust } from "../core/header";
import { historyItem, historyRange, searchWords, type FoundRecord, type HistoryFrom, type HistoryResult } from "../core/history";
import { expectId, parseId } from "../core/ids";
import type { HistoryFilter, HistorySearch } from "../infra/history-store";
import type { ChatIds } from "../infra/sqlite-store";
import { TokenBucket } from "./token-bucket";

/**
 * A pet's searches: this many a minute, in bursts of `burst`; this many results unless asked, at most
 * `maxResults`; each search given `timeoutMs` (the daemon's `HistoryRunner` kills one that takes longer).
 */
export const HISTORY_LIMITS = { perMinute: 20, burst: 10, results: 20, maxResults: 50, timeoutMs: 10_000 };

/** The pet's `history` arguments, as given (all optional but the channel). */
export interface HistoryArgs {
  channel: string;
  query?: string;
  from?: string;
  since?: string;
  until?: string;
  before?: string;
  limit?: number;
}

/**
 * A pet's conversation as Household sees it now: the channels it is placed in, as a header shows them (without
 * `meta`), and who it trusts.
 */
export interface Conversation {
  channels: HeaderChannel[];
  trust(ref: SenderRef): Trust;
}

/**
 * The pet's `history`: messages of its own journal (what it was shown: the reach `react` has; not Household's
 * notices and cards) in one channel it is placed in (one channel is one chat: several, several searches), newest
 * first, under the header's ids. A channel the pet is not in, or has left, is refused: what it had there stays
 * kept, out of its reach. Presses, reactions and messages the security system refused are never records, so they
 * are never found.
 */
export class History {
  private readonly budgets = new Map<string, TokenBucket>();

  constructor(
    private readonly conversation: (house: string, pet: string) => Conversation | undefined,
    private readonly ids: Pick<ChatIds, "personId" | "personRef">,
    private readonly runner: HistorySearch,
    private readonly limits = HISTORY_LIMITS,
  ) {}

  async find(house: string, pet: string, args: HistoryArgs): Promise<HistoryResult> {
    const conversation = this.conversation(house, pet);
    if (!conversation) throw new HouseholdError(`unknown bot ${house}/${pet}`);
    const filter = this.filter(house, pet, conversation, args);
    if (!this.budget(house, pet).take()) throw new HouseholdError(`too many history searches (over ${this.limits.perMinute} a minute): wait a little`);
    if (!filter) return { messages: [], more: false };
    const { records, more } = await this.runner.search(filter);
    const channel = conversation.channels.find(({ id }) => id === filter.channel)!; // checked by `filter`
    const messages = records.map((record) => historyItem(record, channel, this.from(house, pet, record, conversation)));
    return { messages, more };
  }

  /**
   * The search the arguments ask for, checked; throws, naming the expected form, when one is wrong. Undefined
   * when nothing can match: `from` a person the house has never heard (found as empty, not told apart from one
   * who wrote nothing, so a pet cannot count people).
   */
  private filter(house: string, pet: string, conversation: Conversation, args: HistoryArgs): HistoryFilter | undefined {
    const { results, maxResults } = this.limits;
    const limit = args.limit ?? results;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxResults) throw new HouseholdError(`limit must be a whole number from 1 to ${maxResults}`);
    expectId("channel", args.channel);
    if (!conversation.channels.some(({ id }) => id === args.channel)) {
      throw new HouseholdError(`${args.channel} is not one of your channels (yours: ${conversation.channels.map(({ id }) => id).join(", ") || "none"})`);
    }
    const sender = args.from === undefined ? undefined : this.sender(house, pet, args.from);
    const filter: HistoryFilter = {
      house,
      pet,
      channel: args.channel,
      ...(args.query === undefined ? {} : { words: searchWords(args.query) }),
      ...(sender ? { sender } : {}),
      ...historyRange(args.since, args.until),
      ...(args.before === undefined ? {} : { before: expectId("message", args.before) }),
      limit,
    };
    return sender === null ? undefined : filter;
  }

  /** `from`: "you", or a person's id from a header; null for a person the house does not have. */
  private sender(house: string, pet: string, from: string): HistoryFilter["sender"] | null {
    if (from === "you") return { kind: "pet", name: pet };
    if (parseId(from)?.kind !== "person") throw new HouseholdError(`from must be a person's id (from.id in a header, e.g. p1) or "you"`);
    const ref = this.ids.personRef(house, from);
    return ref === undefined ? null : { kind: "person", ref };
  }

  /** A record's sender as the header's `from`: the pet's own words are `you`, another pet's are that pet's. */
  private from(house: string, pet: string, { sender }: FoundRecord, conversation: Conversation): HistoryFrom {
    if (sender.kind === "pet") return sender.name === pet ? { kind: "you" } : { kind: "pet", name: sender.name };
    const id = sender.ref ? this.ids.personId(house, sender.ref) : undefined; // a few records older than M4.1 have no ref
    return { ...(id ? { id } : {}), name: sender.name, trust: conversation.trust(sender.ref) };
  }

  private budget(house: string, pet: string): TokenBucket {
    const name = `${house}/${pet}`;
    const { perMinute, burst } = this.limits;
    if (!this.budgets.has(name)) this.budgets.set(name, new TokenBucket(perMinute / 60, burst));
    return this.budgets.get(name)!;
  }
}
