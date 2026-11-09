import { InboxEventStore } from "./inbox-event-store";
import { MemoryStore } from "./memory-store";
import type { AgentEvent } from "../core/agent-events";
import { CronStore } from "./cron-store";
import { Database } from "bun:sqlite";
import type { Attachment } from "../core/attachment";
import type { External, MessageRef, SenderRef } from "../core/channel";
import { parsePlaceKey } from "../core/channels";
import type { Header } from "../core/header";
import { makeId, parseId } from "../core/ids";
import type { ChannelFacts, ChatRecord, ChatSender, Message, MessageDraft, MessageStatus } from "../core/message";
import { factsColumn, floorKey, migrate, mint } from "./sqlite-schema";

export { SCHEMA_VERSION } from "./sqlite-schema";

/** Messages to pets and their statuses; Delivery is its only user. */
export interface MessageStore {
  cronEvent?(ids: number[], event: AgentEvent): void;
  /** A new message, `received` unless said otherwise (a rejected one is kept as `rejected`). */
  add(house: string, pet: string, draft: MessageDraft, status?: MessageStatus): Message;
  setStatus(id: number, status: MessageStatus): void;
  setText(id: number, text: string): void;
  /** The message's files, as Household has fetched them now. */
  setAttachments(id: number, attachments: Attachment[]): void;
  /** The newest message of the house that is `ref` or an edit of it, with the pet it went to. */
  byRef(house: string, ref: MessageRef): (Message & { pet: string }) | undefined;
  /** A pet's messages not answered or failed yet, oldest first. */
  unfinished(house: string, pet: string): Message[];
  /** The ids of a pet's messages the security system refused after message `after`, oldest first. */
  rejectedAfter(house: string, pet: string, after: number): number[];
}

/**
 * Messages of each house's chat, under Household's ids (`m<n>`, counted in each channel: a message is named by its
 * channel and its id), and each pet's journal: the messages it was shown. A journal is
 * decided when a message is written, never by a filter on reading: it holds the record itself (one record, in as
 * many journals as it was meant for), so an edit is seen in each. Chat is its only user.
 */
export interface ChatRecords {
  /**
   * Remembers a message under the next id of its place's channel, with the refs of all its pieces (the first is
   * its `ref`), in the journals of `journals` (pets). One the house already has (a channel replaying) is returned
   * as it is: its journals were decided when it was first written. Never throws for a place it cannot read (it is
   * then in no channel). Kept for good: the pets' history (`history-store.ts`).
   */
  remember(house: string, record: NewChatRecord): ChatRecord;
  /** An edit: message `original` gets the edit's `ref` too, its new text and channel facts. Undefined if it is unknown. */
  revise(house: string, original: string, ref: string, text: string, excerpt: string, facts: ChannelFacts): ChatRecord | undefined;
  /** Whether message `id` of channel `channel` is in the pet's journal. */
  inJournal(house: string, pet: string, channel: string, id: string): boolean;
  /** The choices of the message one of whose pieces is `ref` are made: a later press on it is answered, not taken. */
  markResolved(house: string, ref: string): void;
  /** Message `id` of channel `channel` (Household's ids). */
  recordById(house: string, channel: string, id: string): ChatRecord | undefined;
  /** The message one of whose pieces (or versions) is `ref`. */
  recordByRef(house: string, ref: string): ChatRecord | undefined;
}

export type NewChatRecord = Omit<ChatRecord, "id" | "ref" | "text" | "resolved"> & { refs: string[]; text: string; journals: string[] };

/**
 * Household's ids of each house's channels and people (`c<n>`, `p<n>`), minted on first sight and kept for good;
 * Chat is its only user. Places have none: a place is known by its key.
 */
export interface ChatIds {
  /** The id of the channel Household knows by `key` (`channelKey`: kind and chat). */
  channelId(house: string, key: string): string;
  /** The key of channel `id`; undefined when the house has no such channel. */
  channelKeyOf(house: string, id: string): string | undefined;
  /** The id of the person the channel refers to as `ref`. */
  personId(house: string, ref: SenderRef): string;
  /** The channel's ref of person `id`; undefined when the house has no such person. */
  personRef(house: string, id: string): SenderRef | undefined;
}

/** The web UI's signed-in browsers, by a hash of their session id (never the id itself); WebAuth is its only user. */
export interface SessionStore {
  /** `expires`: ms since the epoch. */
  addSession(hash: string, expires: number): void;
  /** When the session ends (ms since the epoch); undefined when there is no such session. */
  sessionExpiry(hash: string): number | undefined;
  removeSession(hash: string): void;
  /** Forgets the sessions ended by `now`. */
  pruneSessions(now: number): void;
}

/** Small values that must survive restarts, such as a channel's position in its update stream. */
export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

interface Row {
  id: number;
  pet: string;
  text: string;
  status: MessageStatus;
  origin: Message["origin"];
  ref: string | null;
  edits: string | null;
  meta: string | null;
  place: string | null;
  facts: string | null;
  attachments: string | null;
}

const toMessage = ({ id, text, status, origin, ref, edits, meta, place, facts, attachments }: Row): Message => ({
  id,
  text,
  status,
  origin,
  ...(ref === null ? {} : { ref: ref as MessageRef }),
  ...(edits === null ? {} : { edits: edits as MessageRef }),
  ...(meta === null ? {} : { header: JSON.parse(meta) as Header }),
  ...(place === null ? {} : { place }),
  ...(facts === null ? {} : { facts: JSON.parse(facts) as External }),
  ...(attachments === null ? {} : { attachments: JSON.parse(attachments) as Attachment[] }),
});

export interface ChatRow {
  seq: number;
  ref: string;
  /** The key of the record's place (migration 13; an id from migration 7 until then). */
  place: string;
  /** Household's id of the place's channel (migration 13). */
  channel_id: string | null;
  pet: string;
  sender: string;
  excerpt: string;
  text: string | null;
  relayed: number;
  /** JSON, `ChannelFacts`: a person's message's channel facts (migration 13; its header's `channel` from migration 11). */
  facts: string | null;
  resolved: number;
  outgoing?: string | null;
}

export const toRecord = ({ seq, ref, place, pet, sender, excerpt, text, relayed, facts, resolved, outgoing }: ChatRow): ChatRecord => ({
  id: makeId("message", seq),
  ref: ref as ChatRecord["ref"],
  place,
  pet,
  sender: JSON.parse(sender) as ChatSender,
  excerpt,
  ...(text === null ? {} : { text }),
  ...(relayed ? { relayed: true as const } : {}),
  ...(facts === null ? {} : { facts: JSON.parse(facts) as ChannelFacts }),
  ...(resolved ? { resolved: true as const } : {}),
  ...(outgoing ? { outgoing: JSON.parse(outgoing) as ChatRecord["outgoing"] } : {}),
});

/** SQLite in the state dir (`:memory:` in tests). Only the daemon opens it: the control socket keeps it single. */
export class SqliteStore implements MessageStore, KeyValueStore, ChatRecords, ChatIds, SessionStore {
  private readonly db: Database;
  readonly crons: CronStore;
  readonly memory: MemoryStore;
  readonly inboxEvents: InboxEventStore;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    migrate(this.db);
    this.crons = new CronStore(this.db);
    this.memory = new MemoryStore(this.db);
    this.inboxEvents = new InboxEventStore(this.db);
  }

  cronEvent(ids: number[], event: AgentEvent) { this.crons.event(ids,event); }

  add(house: string, pet: string, { text, origin, ref, edits, header, place, facts, attachments }: MessageDraft, status: MessageStatus = "received"): Message {
    // The header is kept in the column `meta`, so a redelivered message has the same one.
    const row = this.db
      .query<Row, [string, string, string, string, string, string | null, string | null, string | null, string | null, string | null, string | null]>(
        "INSERT INTO messages (house, pet, text, status, origin, ref, edits, meta, place, facts, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(house, pet, text, status, origin, ref ?? null, edits ?? null, header ? JSON.stringify(header) : null, place ?? null, facts ? JSON.stringify(facts) : null, attachments?.length ? JSON.stringify(attachments) : null)!;
    return toMessage(row);
  }

  setStatus(id: number, status: MessageStatus): void {
    this.db.run("UPDATE messages SET status = ?, updated = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?", [status, id]);
  }

  setText(id: number, text: string): void {
    this.db.run("UPDATE messages SET text = ?, updated = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?", [text, id]);
  }

  setAttachments(id: number, attachments: Attachment[]): void {
    this.db.run("UPDATE messages SET attachments = ?, updated = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?", [JSON.stringify(attachments), id]);
  }

  byRef(house: string, ref: MessageRef): (Message & { pet: string }) | undefined {
    const row = this.db
      .query<Row, [string, string, string]>(
        "SELECT * FROM messages WHERE house = ? AND (ref = ? OR edits = ?) ORDER BY id DESC LIMIT 1",
      )
      .get(house, ref, ref);
    return row ? { ...toMessage(row), pet: row.pet } : undefined;
  }

  unfinished(house: string, pet: string): Message[] {
    return this.db
      .query<Row, [string, string]>(
        "SELECT * FROM messages WHERE house = ? AND pet = ? AND status IN ('received', 'dispatching', 'delivered') ORDER BY id",
      )
      .all(house, pet)
      .map(toMessage);
  }

  rejectedAfter(house: string, pet: string, after: number): number[] {
    return this.db
      .query<{ id: number }, [string, string, number]>("SELECT id FROM messages WHERE house = ? AND pet = ? AND status = 'rejected' AND id > ? ORDER BY id")
      .all(house, pet, after)
      .map(({ id }) => id);
  }

  remember(house: string, { refs, journals, ...record }: NewChatRecord): ChatRecord {
    return this.db.transaction(() => {
      const known = this.recordByRef(house, refs[0]!);
      if (known) return known;
      const at = parsePlaceKey(record.place);
      const channel = at ? this.channelId(house, at.channel) : null;
      // Each channel counts on from its last message, and from the house's last one before K2 (migration 13).
      const { seq } = this.db
        .query<{ seq: number }, [string, string | null, string]>(
          "SELECT MAX(COALESCE((SELECT MAX(seq) FROM chat_messages WHERE house = ?1 AND channel_id IS ?2), 0), COALESCE((SELECT CAST(value AS INTEGER) FROM state WHERE key = ?3), 0)) + 1 AS seq",
        )
        .get(house, channel, floorKey(house))!;
      const key = Number(
        this.db.run("INSERT INTO chat_messages (house, channel_id, seq, ref, place, pet, sender, excerpt, text, relayed, facts, outgoing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          house, channel, seq, refs[0]!, record.place, record.pet, JSON.stringify(record.sender), record.excerpt, record.text, record.relayed ? 1 : 0, factsColumn(record.facts), record.outgoing ? JSON.stringify(record.outgoing) : null,
        ]).lastInsertRowid,
      );
      for (const ref of refs) this.db.run("INSERT OR IGNORE INTO chat_refs (house, ref, record) VALUES (?, ?, ?)", [house, ref, key]);
      for (const pet of journals) this.db.run("INSERT OR IGNORE INTO chat_journal (house, pet, record) VALUES (?, ?, ?)", [house, pet, key]);
      return this.recordByRef(house, refs[0]!)!;
    })();
  }

  revise(house: string, original: string, ref: string, text: string, excerpt: string, facts: ChannelFacts): ChatRecord | undefined {
    const key = this.keyOf(house, original);
    if (key === undefined) return undefined;
    this.db.run("UPDATE chat_messages SET text = ?, excerpt = ?, facts = ? WHERE id = ?", [text, excerpt, factsColumn(facts), key]);
    this.db.run("INSERT OR IGNORE INTO chat_refs (house, ref, record) VALUES (?, ?, ?)", [house, ref, key]);
    return this.recordByRef(house, ref);
  }

  inJournal(house: string, pet: string, channel: string, id: string): boolean {
    const parsed = parseId(id);
    if (parsed?.kind !== "message") return false;
    return (
      this.db
        .query<{ id: number }, [string, string, string, number]>(
          "SELECT chat_messages.id FROM chat_journal JOIN chat_messages ON chat_messages.id = chat_journal.record WHERE chat_journal.house = ? AND chat_journal.pet = ? AND chat_messages.channel_id = ? AND chat_messages.seq = ?",
        )
        .get(house, pet, channel, parsed.seq) !== null
    );
  }

  markResolved(house: string, ref: string): void {
    const key = this.keyOf(house, ref);
    if (key !== undefined) this.db.run("UPDATE chat_messages SET resolved = 1 WHERE id = ?", [key]);
  }

  recordById(house: string, channel: string, id: string): ChatRecord | undefined {
    const parsed = parseId(id);
    if (parsed?.kind !== "message") return undefined;
    const row = this.db.query<ChatRow, [string, string, number]>("SELECT * FROM chat_messages WHERE house = ? AND channel_id = ? AND seq = ?").get(house, channel, parsed.seq);
    return row ? toRecord(row) : undefined;
  }

  recordByRef(house: string, ref: string): ChatRecord | undefined {
    const row = this.db
      .query<ChatRow, [string, string]>("SELECT chat_messages.* FROM chat_refs JOIN chat_messages ON chat_messages.id = chat_refs.record WHERE chat_refs.house = ? AND chat_refs.ref = ?")
      .get(house, ref);
    return row ? toRecord(row) : undefined;
  }

  /** The key (`chat_messages.id`) of the record one of whose pieces (or versions) is `ref`. */
  private keyOf(house: string, ref: string): number | undefined {
    return this.db.query<{ record: number }, [string, string]>("SELECT record FROM chat_refs WHERE house = ? AND ref = ?").get(house, ref)?.record;
  }

  channelId(house: string, key: string): string {
    return makeId("channel", mint(this.db, house, "channel", key));
  }

  channelKeyOf(house: string, id: string): string | undefined {
    const parsed = parseId(id);
    return parsed?.kind === "channel" ? this.known(house, "channel", parsed.seq) : undefined;
  }

  personId(house: string, ref: SenderRef): string {
    return makeId("person", mint(this.db, house, "person", ref));
  }

  personRef(house: string, id: string): SenderRef | undefined {
    const parsed = parseId(id);
    return parsed?.kind === "person" ? (this.known(house, "person", parsed.seq) as SenderRef | undefined) : undefined;
  }

  /** What channel or person number `seq` of the house stands for (a channel's key, a person's ref). */
  private known(house: string, kind: "channel" | "person", seq: number): string | undefined {
    return this.db.query<{ value: string }, [string, string, number]>("SELECT value FROM chat_ids WHERE house = ? AND kind = ? AND seq = ?").get(house, kind, seq)?.value;
  }

  get(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value;
  }

  set(key: string, value: string): void {
    this.db.run("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  delete(key: string): void {
    this.db.run("DELETE FROM state WHERE key = ?", [key]);
  }

  addSession(hash: string, expires: number): void {
    this.db.run("INSERT OR REPLACE INTO web_sessions (hash, expires) VALUES (?, ?)", [hash, expires]);
  }

  sessionExpiry(hash: string): number | undefined {
    return this.db.query<{ expires: number }, [string]>("SELECT expires FROM web_sessions WHERE hash = ?").get(hash)?.expires;
  }

  removeSession(hash: string): void {
    this.db.run("DELETE FROM web_sessions WHERE hash = ?", [hash]);
  }

  pruneSessions(now: number): void {
    this.db.run("DELETE FROM web_sessions WHERE expires <= ?", [now]);
  }

  close(): void {
    this.db.close();
  }
}
