import { Database } from "bun:sqlite";
import { historyText, type FoundRecord } from "../core/history";
import { toRecord, type ChatRow } from "./sqlite-store";

/**
 * What one history search looks at: records of `house` in `pet`'s journal in channel `channel` (Household's id;
 * Household's own notices and cards are in no journal). `words`: all of them, each as a word or the start of one. `sender`:
 * the pet itself or a person (by the channel's ref). `since` <= created < `until` (ISO, as kept). `before`: older
 * than that message of the channel.
 */
export interface HistoryFilter {
  house: string;
  pet: string;
  channel: string;
  words?: string[];
  excludeTopics?: boolean;
  sender?: { kind: "pet"; name: string } | { kind: "person"; ref: string };
  since?: string;
  until?: string;
  before?: number;
  limit: number;
}

/** Newest first, texts cut to what a result shows; `more`: there are older ones. */
export interface HistoryPage {
  records: FoundRecord[];
  more: boolean;
}

/** Runs searches somewhere they cannot hold up the daemon (`HistoryRunner`). */
export interface HistorySearch {
  search(filter: HistoryFilter): Promise<HistoryPage>;
}

/** Each word as a quoted FTS5 prefix term: whatever it holds, it is never FTS syntax (`AND`, `NEAR`, `*`, columns). */
export const ftsQuery = (words: string[]) => words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" ");

/**
 * The history process's connection: read-only by `query_only` (SQLite's `readonly` cannot open a WAL database
 * whose -shm file is not there yet).
 */
export function openReadOnly(path: string): Database {
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  db.run("PRAGMA query_only = ON");
  return db;
}

/** One search, on `db` (the history process's read-only connection). Texts are cut here, before they travel. */
export function searchHistory(db: Database, { house, pet, channel, words, sender, since, until, before, limit, excludeTopics }: HistoryFilter): HistoryPage {
  const where = ["house = ?", "channel_id = ?", "id IN (SELECT record FROM chat_journal WHERE house = ? AND pet = ?)"];
  const values: (string | number)[] = [house, channel, house, pet];
  const and = (condition: string, ...more: (string | number)[]) => {
    where.push(condition);
    values.push(...more);
  };
  if (excludeTopics) and("place NOT LIKE 'topic:%'");
  if (words && words.length > 0) and("id IN (SELECT rowid FROM chat_search WHERE chat_search MATCH ?)", ftsQuery(words));
  if (sender?.kind === "pet") and("json_extract(sender, '$.kind') = 'pet' AND json_extract(sender, '$.name') = ?", sender.name);
  if (sender?.kind === "person") and("json_extract(sender, '$.kind') = 'person' AND json_extract(sender, '$.ref') = ?", sender.ref);
  if (since !== undefined) and("created >= ?", since);
  if (until !== undefined) and("created < ?", until);
  if (before !== undefined) and("seq < ?", before);
  const rows = db
    .query<ChatRow & { created: string }, (string | number)[]>(`SELECT * FROM chat_messages WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`)
    .all(...values, limit + 1);
  const records = rows.slice(0, limit).map((row): FoundRecord => {
    const { id, sender, relayed, facts, text, excerpt } = toRecord(row);
    const meta = facts?.shown;
    // Household's own records are in no journal.
    return {
      id,
      sender: sender as FoundRecord["sender"],
      when: row.created,
      ...(relayed ? { relayed } : {}),
      ...(meta ? { meta } : {}),
      ...historyText(text, excerpt),
    };
  });
  return { records, more: rows.length > limit };
}
