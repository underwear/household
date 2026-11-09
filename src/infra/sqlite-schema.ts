import type { Database } from "bun:sqlite";
import type { External, SenderRef } from "../core/channel";
import { parsePlaceKey } from "../core/channels";
import { makeId, parseId, type IdKind } from "../core/ids";
import type { ChannelFacts, ChatSender } from "../core/message";

/** The house's number for `value` among its channels, places or people, minted if it has none yet. */
export function mint(db: Database, house: string, kind: Exclude<IdKind, "message"> | "place", value: string): number {
  // Places had ids from C1 to K2 (migration 7, `c<n>` in a namespace of their own); migration 13 took them back.
  const known = db.query<{ seq: number }, [string, string, string]>("SELECT seq FROM chat_ids WHERE house = ? AND kind = ? AND value = ?").get(house, kind, value);
  if (known) return known.seq;
  const { seq } = db.query<{ seq: number }, [string, string]>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM chat_ids WHERE house = ? AND kind = ?").get(house, kind)!;
  db.run("INSERT INTO chat_ids (house, kind, seq, value) VALUES (?, ?, ?, ?)", [house, kind, seq, value]);
  return seq;
}

/**
 * The house a bot's chat belongs to: the one whose records have the chat's refs or, failing that, the one house
 * with a pet of that name (the pet the thread was made for).
 */
function houseOf(db: Database, chat: string, pet: string): string | undefined {
  const byRef = db.query<{ house: string }, [string]>("SELECT house FROM chat_refs WHERE ref GLOB ? LIMIT 1").get(`${chat}.*`);
  if (byRef) return byRef.house;
  const byPet = db
    .query<{ house: string }, [string, string]>("SELECT house FROM messages WHERE pet = ? UNION SELECT house FROM chat_messages WHERE pet = ?")
    .all(pet, pet);
  return byPet.length === 1 ? byPet[0]!.house : undefined;
}

/**
 * Places and people get Household's ids (C1). Records name places by id (a pet's place was its name; none, the
 * inbox); a Telegram thread, kept by its place, moves to that place's id, so it stays the pet's thread. Queued messages have an old-style header that is not
 * shown any more: they fail as interrupted, so the person is asked to write again.
 */
function placeAndPersonIds(db: Database): void {
  db.run(`CREATE TABLE chat_ids (house TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (house, kind, seq));
    CREATE UNIQUE INDEX chat_ids_by_value ON chat_ids (house, kind, value);`);
  const keyOf = (place: string | null) => (place === null ? "inbox" : `pet:${place}`);
  // In order, so places are numbered as they first appeared.
  const records = db.query<{ house: string; seq: number; place: string | null }, []>("SELECT house, seq, place FROM chat_messages ORDER BY house, seq").all();
  for (const { house, seq, place } of records) {
    const id = `c${mint(db, house, "place", keyOf(place))}`;
    db.run("UPDATE chat_messages SET place = ? WHERE house = ? AND seq = ?", [id, house, seq]);
  }
  const threads = db.query<{ key: string; value: string }, []>("SELECT key, value FROM state WHERE key GLOB 'telegram.*.thread.*'").all();
  for (const { key, value: thread } of threads) {
    const [chat, pet] = key.split(".thread.") as [string, string];
    const house = houseOf(db, chat, pet);
    if (house === undefined) continue; // no telling whose: a thread is made again if needed
    const id = `c${mint(db, house, "place", `pet:${pet}`)}`;
    db.run("DELETE FROM state WHERE key = ?", [key]);
    db.run("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", [`${chat}.thread.${id}`, thread]);
    db.run("UPDATE state SET value = ? WHERE key = ?", [id, `${chat}.place.${thread}`]);
  }
  db.run("UPDATE messages SET status = 'delivered' WHERE status = 'received' AND meta IS NOT NULL");
}

/** The search index over records' text, keyed by their `id`, kept up to date by triggers (H1). */
const CHAT_SEARCH = `CREATE VIRTUAL TABLE chat_search USING fts5(text, content = 'chat_messages', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER chat_search_add AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_search (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chat_search_remove AFTER DELETE ON chat_messages BEGIN
    INSERT INTO chat_search (chat_search, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER chat_search_change AFTER UPDATE OF text ON chat_messages BEGIN
    INSERT INTO chat_search (chat_search, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chat_search (rowid, text) VALUES (new.id, new.text);
  END;
  INSERT INTO chat_search (chat_search) VALUES ('rebuild');`;

/**
 * Records get a key of their own, `id`, that the search index is linked by (the implicit rowid it had may change
 * on VACUUM), and senders of records older than M4.1 get their ref (so their person id) from the queued
 * message's meta, where it has one: an old envelope's `from.ref`, a header's `from.id`.
 */
function recordKeysAndSenders(db: Database): void {
  db.run(`DROP TABLE chat_search;
    CREATE TABLE chat_records (
      id INTEGER PRIMARY KEY,
      house TEXT NOT NULL, seq INTEGER NOT NULL, ref TEXT NOT NULL, place TEXT, pet TEXT NOT NULL, sender TEXT NOT NULL, excerpt TEXT NOT NULL,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), text TEXT, resolved INTEGER NOT NULL DEFAULT 0, relayed INTEGER NOT NULL DEFAULT 0,
      UNIQUE (house, seq));
    INSERT INTO chat_records (house, seq, ref, place, pet, sender, excerpt, created, text, resolved, relayed)
      SELECT house, seq, ref, place, pet, sender, excerpt, created, text, resolved, relayed FROM chat_messages ORDER BY house, seq;
    DROP TABLE chat_messages;
    ALTER TABLE chat_records RENAME TO chat_messages;`);
  const nameless = db
    .query<{ house: string; seq: number; name: string | null }, []>(
      "SELECT house, seq, json_extract(sender, '$.name') AS name FROM chat_messages WHERE json_extract(sender, '$.kind') = 'person' AND COALESCE(json_extract(sender, '$.ref'), '') = ''",
    )
    .all();
  for (const { house, seq, name } of nameless) {
    const metas = db
      .query<{ meta: string }, [string, number]>(
        `SELECT messages.meta FROM chat_refs JOIN messages ON messages.house = chat_refs.house AND messages.ref = chat_refs.ref
          WHERE chat_refs.house = ? AND chat_refs.seq = ? AND messages.origin = 'chat' AND messages.meta IS NOT NULL ORDER BY messages.id`,
      )
      .all(house, seq);
    for (const { meta } of metas) {
      const from = (JSON.parse(meta) as { from?: { ref?: string; id?: string; name?: string } }).from ?? {};
      const person = from.id === undefined ? undefined : parseId(from.id);
      const ref =
        from.ref ??
        (person?.kind === "person"
          ? db.query<{ value: string }, [string, number]>("SELECT value FROM chat_ids WHERE house = ? AND kind = 'person' AND seq = ?").get(house, person.seq)?.value
          : undefined);
      if (!ref) continue;
      const sender: ChatSender = { kind: "person", ref: ref as SenderRef, name: name || from.name || "" };
      db.run("UPDATE chat_messages SET sender = ? WHERE house = ? AND seq = ?", [JSON.stringify(sender), house, seq]);
      break;
    }
  }
  db.run(CHAT_SEARCH);
}

/** The most a record's `channel` takes (JSON, bytes): more is not kept (today's adapter never comes near it). */
const CHANNEL_MAX = 4096;

/** A header's `channel` as it was before K2: no id or audience, maybe no name, all the channel's facts in `meta`. */
type OldChannel = { kind: string; name?: string; meta?: External };

/** A record's header `channel` as migration 11 kept it: null for none, or for one too big to keep. */
function channelColumn(channel: OldChannel | undefined): string | null {
  const json = channel ? JSON.stringify(channel) : null;
  return json !== null && Buffer.byteLength(json) <= CHANNEL_MAX ? json : null;
}

/**
 * A record's channel facts as the column `facts` keeps them: null for none. Over CHANNEL_MAX, what is only kept
 * goes first; the shown part, if that is still too big.
 */
export function factsColumn(facts: ChannelFacts | undefined): string | null {
  const fits = (value: ChannelFacts) => {
    const json = JSON.stringify(value);
    return Object.keys(value).length > 0 && Buffer.byteLength(json) <= CHANNEL_MAX ? json : null;
  };
  if (!facts) return null;
  const { shown, kept } = facts;
  return fits({ ...(shown ? { shown } : {}), ...(kept ? { kept } : {}) }) ?? (shown ? fits({ shown }) : null);
}

type QueuedMeta = { event?: unknown; channel?: OldChannel | string; external?: External; forwarded?: { name: string; external?: External } };

/**
 * What a queued message's meta, a header or an old envelope of M3.1, says of its channel (as a header has it);
 * nothing when it cannot be read.
 */
function channelOf(meta: string): OldChannel | undefined {
  let parsed: QueuedMeta;
  try {
    parsed = JSON.parse(meta) as QueuedMeta;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (parsed.event !== undefined) return typeof parsed.channel === "object" && parsed.channel !== null ? parsed.channel : undefined;
  if (typeof parsed.channel !== "string") return undefined;
  const { forwarded } = parsed;
  // The move C1 made live: who a forward is from goes into the channel's facts, as `forward`.
  const facts = { ...parsed.external, ...(forwarded ? { forward: { name: forwarded.name, ...forwarded.external } } : {}) };
  return { kind: parsed.channel, ...(Object.keys(facts).length > 0 ? { meta: facts } : {}) };
}

/**
 * A person's records keep their header's `channel` (H1.1), so the pets' history shows what the header did (who a
 * forward is from). Records so far get it from the newest queued message of theirs with meta (an edit's wins);
 * none for records the queue kept no meta of.
 */
function recordChannels(db: Database): void {
  db.run("ALTER TABLE chat_messages ADD COLUMN channel TEXT");
  const metas = db
    .query<{ id: number; meta: string | null }, []>(
      `SELECT chat_messages.id, (SELECT messages.meta FROM chat_refs JOIN messages ON messages.house = chat_refs.house AND messages.ref = chat_refs.ref
          WHERE chat_refs.house = chat_messages.house AND chat_refs.seq = chat_messages.seq AND messages.origin = 'chat' AND messages.status != 'rejected'
            AND messages.meta IS NOT NULL ORDER BY messages.id DESC LIMIT 1) AS meta
        FROM chat_messages WHERE json_extract(sender, '$.kind') = 'person'`,
    )
    .all();
  for (const { id, meta } of metas) {
    const channel = meta === null ? null : channelColumn(channelOf(meta));
    if (channel !== null) db.run("UPDATE chat_messages SET channel = ? WHERE id = ?", [channel, id]);
  }
}

/**
 * What a Telegram message's facts showed the pet once K2 split them (the adapter's split since, `updates.ts`):
 * its sender's username, and who a forward is from (name, username, date). Telegram's numbers (message,
 * thread, user, chat ids) are kept only. Records until then are all Telegram's.
 */
function shownOf(meta: External | undefined): External | undefined {
  if (!meta) return undefined;
  const pick = (from: External, keys: string[]) => Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]!])) as External;
  const forward = meta.forward && typeof meta.forward === "object" && !Array.isArray(meta.forward) ? pick(meta.forward, ["name", "username", "date"]) : undefined;
  const shown: External = { ...pick(meta, ["username"]), ...(forward ? { forward } : {}) };
  return Object.keys(shown).length > 0 ? shown : undefined;
}

/** Where the house's pre-K2 message numbers end: every channel counts on from there (`SqliteStore.remember`). */
export const floorKey = (house: string) => `chat.message-floor.${house}`;

/**
 * Per-pet journals; pets see channels, not places (K2). A place is known by its key from now on (`pet:<name>@<channel
 * key>`, `inbox@<channel key>`), not by an id: everything that held a place id holds its key (records, queued
 * messages, the Telegram thread keys and their places, where each pet was last written to), so a thread stays its
 * pet's. A place or record that names no channel (a key from before K1) stops the migration: such a database
 * needs K1's rollout first. Channels get Household's ids, minted in the order their places were (a house's first channel
 * is `c1`, as its first place was). A message's id is per channel from now on (`m<n>` in each); records keep their
 * numbers, which were per house, and every channel counts on from the house's last one, so an old id is never
 * given again. Refs and journals name a record by its own key. Every record but Household's own goes into the
 * journal of its pet, the one whose conversation it was; records of no pet (the inbox before C1) were no pet's to
 * see, and stay so. A person's record keeps its channel facts, split into shown and kept. A message still queued
 * fails as interrupted (its header has a place, no channel id): the person is asked to write again.
 */
function journalsAndChannels(db: Database): void {
  const keyOfPlace = new Map<string, string>();
  const places = db.query<{ house: string; seq: number; value: string }, []>("SELECT house, seq, value FROM chat_ids WHERE kind = 'place' ORDER BY house, seq").all();
  for (const { house, seq, value } of places) {
    keyOfPlace.set(`${house}/c${seq}`, value);
    const at = parsePlaceKey(value);
    if (!at) throw new Error(`house ${house}: place c${seq} (${value}) names no channel: run K1 (channels) on this database first`);
    mint(db, house, "channel", at.channel);
  }
  const channelIdOf = (house: string, key: string | undefined) => {
    const at = parsePlaceKey(key);
    return at ? makeId("channel", mint(db, house, "channel", at.channel)) : undefined;
  };
  const records = db.query<{ id: number; house: string; seq: number; place: string | null; channel: string | null }, []>("SELECT id, house, seq, place, channel FROM chat_messages").all();
  const moved = records.map((record) => {
    const key = record.place === null ? undefined : keyOfPlace.get(`${record.house}/${record.place}`);
    const channel = channelIdOf(record.house, key);
    if (channel === undefined) {
      throw new Error(`house ${record.house}: message m${record.seq} is in place ${record.place ?? "none"} (${key ?? "no key"}), which names no channel: run K1 (channels) on this database first`);
    }
    const old = record.channel === null ? undefined : (JSON.parse(record.channel) as OldChannel);
    const facts = old?.meta && Object.keys(old.meta).length > 0 ? { ...(shownOf(old.meta) ? { shown: shownOf(old.meta) } : {}), kept: old.meta } : undefined;
    return { id: record.id, place: key!, channel, facts: factsColumn(facts) };
  });
  const floors = db.query<{ house: string; seq: number }, []>("SELECT house, MAX(seq) AS seq FROM chat_messages GROUP BY house").all();
  for (const { house, seq } of floors) db.run("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", [floorKey(house), String(seq)]);
  db.run(`DROP TABLE chat_search;
    CREATE TABLE chat_records (
      id INTEGER PRIMARY KEY,
      house TEXT NOT NULL, channel_id TEXT, seq INTEGER NOT NULL, ref TEXT NOT NULL, place TEXT NOT NULL, pet TEXT NOT NULL, sender TEXT NOT NULL, excerpt TEXT NOT NULL,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), text TEXT, resolved INTEGER NOT NULL DEFAULT 0, relayed INTEGER NOT NULL DEFAULT 0,
      facts TEXT, UNIQUE (house, channel_id, seq));
    INSERT INTO chat_records (id, house, seq, ref, place, pet, sender, excerpt, created, text, resolved, relayed)
      SELECT id, house, seq, ref, '', pet, sender, excerpt, created, text, resolved, relayed FROM chat_messages;
    CREATE TABLE chat_record_refs (house TEXT NOT NULL, ref TEXT NOT NULL, record INTEGER NOT NULL, PRIMARY KEY (house, ref));
    INSERT INTO chat_record_refs (house, ref, record) SELECT chat_refs.house, chat_refs.ref, chat_messages.id FROM chat_refs JOIN chat_messages USING (house, seq);
    DROP TABLE chat_refs;
    DROP TABLE chat_messages;
    ALTER TABLE chat_records RENAME TO chat_messages;
    ALTER TABLE chat_record_refs RENAME TO chat_refs;
    CREATE INDEX chat_refs_by_record ON chat_refs (record);
    CREATE TABLE chat_journal (house TEXT NOT NULL, pet TEXT NOT NULL, record INTEGER NOT NULL, PRIMARY KEY (house, pet, record));
    CREATE INDEX chat_journal_by_record ON chat_journal (record);
    INSERT INTO chat_journal (house, pet, record) SELECT house, pet, id FROM chat_messages WHERE pet != '' AND json_extract(sender, '$.kind') != 'household';
    ALTER TABLE messages ADD COLUMN place TEXT;
    ALTER TABLE messages ADD COLUMN facts TEXT;`);
  for (const { id, place, channel, facts } of moved) db.run("UPDATE chat_messages SET place = ?, channel_id = ?, facts = ? WHERE id = ?", [place, channel, facts, id]);
  db.run(CHAT_SEARCH);
  // Queued messages: the place their header named, by key; those not given to the pet yet fail as interrupted.
  const queued = db.query<{ id: number; house: string; meta: string }, []>("SELECT id, house, meta FROM messages WHERE meta IS NOT NULL").all();
  for (const { id, house, meta } of queued) {
    let place: unknown;
    try {
      place = (JSON.parse(meta) as { place?: { id?: unknown } } | null)?.place?.id;
    } catch {
      continue; // unreadable: no place to tell
    }
    const key = typeof place === "string" ? keyOfPlace.get(`${house}/${place}`) : undefined;
    if (key !== undefined) db.run("UPDATE messages SET place = ? WHERE id = ?", [key, id]);
  }
  db.run("UPDATE messages SET status = 'delivered' WHERE status = 'received' AND meta IS NOT NULL");
  // The Telegram threads, by place key: a thread's chat is in its key and in its place's key, so no guessing whose.
  const owner = (chat: string, id: string) => {
    const keys = places.filter(({ seq, value }) => `c${seq}` === id && parsePlaceKey(value)?.channel.endsWith(`:${chat}`)).map(({ value }) => value);
    return keys.length === 1 ? keys[0] : undefined;
  };
  const threads = db.query<{ key: string; value: string }, []>("SELECT key, value FROM state WHERE key GLOB 'telegram.*.thread.c*'").all();
  for (const { key, value } of threads) {
    const [prefix, id] = key.split(".thread.") as [string, string];
    const placeKey = owner(prefix.split(".").at(-1)!, id);
    db.run("DELETE FROM state WHERE key = ?", [key]);
    if (placeKey !== undefined) db.run("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", [`${prefix}.thread.${placeKey}`, value]);
  }
  const placesOfThreads = db.query<{ key: string; value: string }, []>("SELECT key, value FROM state WHERE key GLOB 'telegram.*.place.*'").all();
  for (const { key, value } of placesOfThreads) {
    const placeKey = owner(key.split(".place.")[0]!.split(".").at(-1)!, value);
    if (placeKey === undefined) db.run("DELETE FROM state WHERE key = ?", [key]);
    else db.run("UPDATE state SET value = ? WHERE key = ?", [placeKey, key]);
  }
  const lastPlaces = db.query<{ key: string; value: string }, []>("SELECT key, value FROM state WHERE key GLOB 'chat.last-place.*'").all();
  for (const { key, value } of lastPlaces) {
    const placeKey = keyOfPlace.get(`${key.slice("chat.last-place.".length).split("/")[0]}/${value}`);
    if (placeKey === undefined) db.run("DELETE FROM state WHERE key = ?", [key]);
    else db.run("UPDATE state SET value = ? WHERE key = ?", [placeKey, key]);
  }
  db.run("DELETE FROM chat_ids WHERE kind = 'place'");
}

/** Schema changes in order; `PRAGMA user_version` says how many a database has had. Append only. */
const MIGRATIONS: (string | ((db: Database) => void))[] = [
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, ref TEXT,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), updated TEXT);
  CREATE INDEX IF NOT EXISTS messages_by_pet ON messages (house, pet, status);
  CREATE INDEX IF NOT EXISTS messages_by_ref ON messages (house, ref);
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `ALTER TABLE messages ADD COLUMN edits TEXT;
  CREATE INDEX messages_by_edits ON messages (house, edits);`,
  // Who sent it, from where, and the channel's facts (JSON), so a redelivered message has the same envelope.
  `ALTER TABLE messages ADD COLUMN meta TEXT;`,
  // Every message of a house's chat (the person's, pets', Household's), so pets can name it and react to it.
  `CREATE TABLE chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house TEXT NOT NULL, ref TEXT NOT NULL, place TEXT, author TEXT NOT NULL, excerpt TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')));
  CREATE UNIQUE INDEX chat_by_ref ON chat (house, ref);`,
  // Ids per house (m1, m2, … in each), every piece's ref, whose conversation, a sender. Ids given so far stay.
  `CREATE TABLE chat_messages (
    house TEXT NOT NULL, seq INTEGER NOT NULL, ref TEXT NOT NULL, place TEXT, pet TEXT NOT NULL, sender TEXT NOT NULL,
    excerpt TEXT NOT NULL, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), PRIMARY KEY (house, seq));
  CREATE TABLE chat_refs (house TEXT NOT NULL, ref TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (house, ref));
  CREATE INDEX chat_refs_by_seq ON chat_refs (house, seq);
  INSERT INTO chat_messages (house, seq, ref, place, pet, sender, excerpt, created)
    SELECT house, id, ref, place, COALESCE(place, ''),
      CASE author WHEN 'pet' THEN json_object('kind', 'pet', 'name', place) WHEN 'household' THEN json_object('kind', 'household')
        ELSE json_object('kind', 'person', 'ref', '', 'name', '') END,
      excerpt, created FROM chat;
  INSERT INTO chat_refs (house, ref, seq) SELECT house, ref, id FROM chat;
  DROP TABLE chat;`,
  // A Telegram thread's place was kept under `.pet.` before M3's review fixes: threads made then read as the inbox.
  `UPDATE OR IGNORE state SET key = replace(key, '.pet.', '.place.') WHERE key GLOB 'telegram.*.pet.*';
  DELETE FROM state WHERE key GLOB 'telegram.*.pet.*';`,
  placeAndPersonIds,
  // A message's whole text (records before have none), and whether its choices are made (C2).
  `ALTER TABLE chat_messages ADD COLUMN text TEXT;
  ALTER TABLE chat_messages ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;`,
  // The pets' history (H1): whether a message was relayed; the person's text where only the queue has it (its
  // newest version: an edit's ref is the record's too); a full-text index of every record's text, kept by triggers.
  `ALTER TABLE chat_messages ADD COLUMN relayed INTEGER NOT NULL DEFAULT 0;
  CREATE TEMP VIEW queued AS SELECT chat_refs.house, chat_refs.seq, messages.id, messages.text, messages.meta
    FROM chat_refs JOIN messages ON messages.house = chat_refs.house AND messages.ref = chat_refs.ref
    WHERE messages.origin = 'chat' AND messages.status != 'rejected';
  UPDATE chat_messages SET text = (SELECT text FROM queued WHERE queued.house = chat_messages.house AND queued.seq = chat_messages.seq ORDER BY id DESC LIMIT 1)
    WHERE text IS NULL AND json_extract(sender, '$.kind') = 'person';
  UPDATE chat_messages SET relayed = 1 WHERE EXISTS (SELECT 1 FROM queued WHERE queued.house = chat_messages.house AND queued.seq = chat_messages.seq
    AND json_extract(queued.meta, '$.event.relayed') = 1);
  DROP VIEW queued;
  CREATE VIRTUAL TABLE chat_search USING fts5(text, content = 'chat_messages', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER chat_search_add AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_search (rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER chat_search_remove AFTER DELETE ON chat_messages BEGIN
    INSERT INTO chat_search (chat_search, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER chat_search_change AFTER UPDATE OF text ON chat_messages BEGIN
    INSERT INTO chat_search (chat_search, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO chat_search (rowid, text) VALUES (new.rowid, new.text);
  END;
  INSERT INTO chat_search (chat_search) VALUES ('rebuild');`,
  recordKeysAndSenders,
  recordChannels,
  // The web UI's sessions (W1): a hash of the session id, and when it ends (ms since the epoch).
  `CREATE TABLE IF NOT EXISTS web_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);`,
  journalsAndChannels,
  `CREATE TABLE cron_jobs (
    id TEXT PRIMARY KEY, house TEXT NOT NULL, pet TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL,
    at TEXT NOT NULL, cron TEXT, localAt TEXT, revision INTEGER NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE INDEX cron_due ON cron_jobs(state,at);
  CREATE INDEX cron_pet ON cron_jobs(house,pet);
  CREATE TABLE cron_runs (
    id INTEGER PRIMARY KEY, job TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, scheduled TEXT NOT NULL,
    queued TEXT NOT NULL, message INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, delivered TEXT, started TEXT, finished TEXT, result TEXT, error TEXT);
  CREATE INDEX cron_runs_job ON cron_runs(job,id);
  CREATE TABLE cron_events (id INTEGER PRIMARY KEY, job TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE INDEX cron_events_job ON cron_events(job,id);
  CREATE TRIGGER cron_message_status AFTER UPDATE OF status ON messages
  WHEN NEW.origin='cron' AND OLD.status != NEW.status BEGIN
    UPDATE cron_runs SET status=NEW.status,
      delivered=CASE WHEN NEW.status='delivered' THEN strftime('%Y-%m-%dT%H:%M:%fZ') ELSE delivered END,
      finished=CASE WHEN NEW.status IN ('answered','failed') THEN strftime('%Y-%m-%dT%H:%M:%fZ') ELSE finished END
      WHERE message=NEW.id;
    INSERT INTO cron_events (job,at,kind,detail)
      SELECT job,strftime('%Y-%m-%dT%H:%M:%fZ'),NEW.status,'Message ' || NEW.id FROM cron_runs WHERE message=NEW.id;
  END;`,
  `CREATE TABLE pet_memory (
    id INTEGER PRIMARY KEY, house TEXT NOT NULL, pet TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT, revision INTEGER NOT NULL, updated TEXT NOT NULL, actor TEXT NOT NULL, UNIQUE(house,pet,key));
  CREATE TABLE pet_memory_history (
    house TEXT NOT NULL, pet TEXT NOT NULL, key TEXT NOT NULL, value TEXT, revision INTEGER NOT NULL,
    updated TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(house,pet,key,revision));
  CREATE VIRTUAL TABLE pet_memory_search USING fts5(key,value,content='pet_memory',content_rowid='id',tokenize='unicode61');
  CREATE TRIGGER memory_insert AFTER INSERT ON pet_memory BEGIN
    INSERT INTO pet_memory_search(rowid,key,value) VALUES(new.id,new.key,new.value);
  END;
  CREATE TRIGGER memory_update AFTER UPDATE ON pet_memory BEGIN
    INSERT INTO pet_memory_search(pet_memory_search,rowid,key,value) VALUES('delete',old.id,old.key,old.value);
    INSERT INTO pet_memory_search(rowid,key,value) VALUES(new.id,new.key,new.value);
  END;
  CREATE TRIGGER memory_delete AFTER DELETE ON pet_memory BEGIN
    INSERT INTO pet_memory_search(pet_memory_search,rowid,key,value) VALUES('delete',old.id,old.key,old.value);
  END;`,
  // The files a message came with (JSON, `Attachment[]`), and what Household made of each: kept, so a message
  // queued over a restart is fetched, or shown, the same.
  `ALTER TABLE messages ADD COLUMN attachments TEXT;`,
  `ALTER TABLE chat_messages ADD COLUMN outgoing TEXT;`,
  `CREATE TABLE inbox_events (
    id INTEGER PRIMARY KEY, house TEXT NOT NULL, inbox TEXT NOT NULL, event_id TEXT NOT NULL,
    inbox_title TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL, delivery TEXT NOT NULL,
    title TEXT NOT NULL, text TEXT NOT NULL, metadata TEXT NOT NULL, url TEXT,
    received INTEGER NOT NULL, occurred INTEGER, UNIQUE(house,inbox,event_id));
  CREATE INDEX inbox_events_received ON inbox_events(house,received,id);
  CREATE INDEX inbox_events_occurred ON inbox_events(house,occurred,id);
  CREATE INDEX inbox_events_source ON inbox_events(house,inbox,id);
  CREATE TABLE inbox_event_pets (event INTEGER NOT NULL REFERENCES inbox_events(id), pet TEXT NOT NULL, PRIMARY KEY(event,pet));
  CREATE INDEX inbox_event_pet ON inbox_event_pets(pet,event);
  CREATE VIRTUAL TABLE inbox_event_search USING fts5(title,text,metadata,content='inbox_events',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER inbox_event_insert AFTER INSERT ON inbox_events BEGIN
    INSERT INTO inbox_event_search(rowid,title,text,metadata) VALUES(new.id,new.title,new.text,new.metadata);
  END;
  CREATE TRIGGER inbox_event_delete AFTER DELETE ON inbox_events BEGIN
    INSERT INTO inbox_event_search(inbox_event_search,rowid,title,text,metadata) VALUES('delete',old.id,old.title,old.text,old.metadata);
    DELETE FROM inbox_event_pets WHERE event=old.id;
  END;`,
];

/** The schema version this code migrates databases to; a database with a newer one is not opened. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: Database): void {
  const { user_version: version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  if (version > SCHEMA_VERSION) throw new Error(`${db.filename} has schema ${version}, newer than this Household knows`);
  MIGRATIONS.slice(version).forEach((sql, i) =>
    db.transaction(() => {
      if (typeof sql === "string") db.run(sql);
      else sql(db);
      db.run(`PRAGMA user_version = ${version + i + 1}`);
    })(),
  );
}
