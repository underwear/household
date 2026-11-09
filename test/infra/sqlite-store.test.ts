import { expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { SenderRef } from "../../src/core/channel";
import type { Header } from "../../src/core/header";
import { searchHistory } from "../../src/infra/history-store";
import type { NewChatRecord } from "../../src/infra/sqlite-store";
import { ref } from "../app/fake-channel";
import { tempDir } from "../helpers";

test("messages keep their status, text and ref across reopening; unfinished ones come back in order", () => {
  const path = join(tempDir(), "household.db");
  const store = new SqliteStore(path);
  const one = store.add("work", "sibling", { text: "one", origin: "chat", ref: ref("7") });
  const two = store.add("work", "sibling", { text: "two", origin: "cli" });
  store.add("work", "chair", { text: "elsewhere", origin: "cli" });
  expect(one).toEqual({ id: 1, text: "one", status: "received", origin: "chat", ref: ref("7") });
  expect(two).toEqual({ id: 2, text: "two", status: "received", origin: "cli" });
  store.setStatus(one.id, "delivered");
  store.setText(two.id, "two, edited");
  store.close();

  const again = new SqliteStore(path);
  expect(again.unfinished("work", "sibling")).toEqual([
    { ...one, status: "delivered" },
    { ...two, text: "two, edited" },
  ]);
  again.setStatus(one.id, "answered");
  again.setStatus(two.id, "failed");
  expect(again.unfinished("work", "sibling")).toEqual([]);
  again.close();
});

test("byRef finds the newest message of the house that is that ref or an edit of it, and its pet", () => {
  const store = new SqliteStore(":memory:");
  store.add("work", "sibling", { text: "first", origin: "chat", ref: ref("7") });
  store.add("work", "sibling", { text: "edit", origin: "chat", ref: ref("7.1"), edits: ref("7") });
  store.add("home", "cat", { text: "other house", origin: "chat", ref: ref("7") });
  expect(store.byRef("work", ref("7"))).toMatchObject({ id: 2, text: "edit", pet: "sibling", edits: "7" });
  expect(store.byRef("work", ref("7.1"))).toMatchObject({ id: 2 });
  expect(store.byRef("work", ref("8"))).toBeUndefined();
});

/** A database whose places name no channel (before K1's rollout) stops at v12, loudly: its state, as it is then. */
function stopsBeforeK2(path: string): Database {
  expect(() => new SqliteStore(path)).toThrow("names no channel: run K1 (channels) on this database first");
  const raw = new Database(path);
  expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 12 });
  return raw;
}
const kv = (db: Database, key: string) => db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value;
const placeKeyOf = (db: Database, house: string, id: string) =>
  db.query<{ value: string }, [string, number]>("SELECT value FROM chat_ids WHERE house = ? AND kind = 'place' AND seq = ?").get(house, Number(id.slice(1)))?.value;

test("the schema is versioned: an M3 database gets the new columns and its thread places back, then waits for K1; a newer one is refused", () => {
  const path = join(tempDir(), "household.db");
  const m3 = new Database(path);
  m3.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, house TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, ref TEXT, created TEXT NOT NULL DEFAULT 'x', updated TEXT)");
  m3.run("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  m3.run("INSERT INTO messages (house, pet, text, status, origin, ref) VALUES ('work', 'sibling', 'kept', 'received', 'chat', '7')");
  m3.run("INSERT INTO state (key, value) VALUES ('telegram.1.2.thread.sibling', '100'), ('telegram.1.2.pet.100', 'sibling')");
  m3.close();
  const raw = stopsBeforeK2(path);
  // The thread is the pet's place again, not the inbox (migration 6), kept by the place's id (7: the house is the one with that pet).
  expect([kv(raw, "telegram.1.2.place.100"), kv(raw, "telegram.1.2.pet.100"), kv(raw, "telegram.1.2.thread.c1")]).toEqual(["c1", undefined, "100"]);
  raw.close();

  const fresh = join(tempDir(), "household.db");
  const store = new SqliteStore(fresh);
  const header: Header = {
    event: { kind: "edit", id: "m1", relayed: true },
    from: { id: "p1", name: "Oleg", trust: "owner" },
    channel: { id: "c1", kind: "telegram-private", name: "DM", audience: "private", meta: { username: "oleg" } },
  };
  const facts = { message: 8, username: "oleg", forward: { name: "Ann", user: 66 } };
  store.add("work", "sibling", { text: "edit", origin: "chat", ref: ref("7.1"), edits: ref("7"), header, place: DM_SIBLING, facts });
  store.close();
  expect(new SqliteStore(fresh).unfinished("work", "sibling")[0]).toMatchObject({ edits: "7", header, place: DM_SIBLING, facts }); // read back whole
  const db = new Database(fresh);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 18 });
  db.run("PRAGMA user_version = 99");
  db.close();
  expect(() => new SqliteStore(fresh)).toThrow("newer than this Household knows");
});

test("key-value state is kept and overwritten", () => {
  const path = join(tempDir(), "household.db");
  const store = new SqliteStore(path);
  expect(store.get("offset")).toBeUndefined();
  store.set("offset", "5");
  store.set("offset", "6");
  store.close();
  expect(new SqliteStore(path).get("offset")).toBe("6");
});

test("a v2 database (what the live daemon has) gets the meta column and keeps its messages", () => {
  const path = join(tempDir(), "household.db");
  const v2 = new Database(path);
  v2.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, house TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, ref TEXT, created TEXT NOT NULL DEFAULT 'x', updated TEXT, edits TEXT)");
  v2.run("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  v2.run("INSERT INTO messages (house, pet, text, status, origin, ref, edits) VALUES ('work', 'sibling', 'kept', 'received', 'chat', '7.1', '7')");
  v2.run("INSERT INTO state VALUES ('telegram.1.offset', '42')");
  v2.run("PRAGMA user_version = 2");
  v2.close();
  const store = new SqliteStore(path);
  expect(store.unfinished("work", "sibling")).toEqual([{ id: 1, text: "kept", status: "received", origin: "chat", ref: ref("7.1"), edits: ref("7") }]);
  expect(store.get("telegram.1.offset")).toBe("42");
  store.close();
  const raw = new Database(path);
  expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 18 });
  raw.close();
  expect(new SqliteStore(path).remember("work", { refs: [ref("7")], place: DM_SIBLING, pet: "sibling", journals: ["sibling"], sender: oleg, text: "kept", excerpt: "kept" }).id).toBe("m1"); // the chat tables came
});

const oleg = { kind: "person" as const, ref: "telegram.user.1" as SenderRef, name: "Oleg" };
/** Places in work's private chat (channel c1 once minted) and in a second one. */
const DM = "telegram-private:1";
const DM_SIBLING = `pet:sibling@${DM}`;
const DM_INBOX = `inbox@${DM}`;
const GROUP_SIBLING = "pet:sibling@telegram-private:2";

test("chat records: ids per channel (of their place), every piece's ref, a replay keeps its id and journals, an edit its record; found only in their house and channel", () => {
  const path = join(tempDir(), "household.db");
  const store = new SqliteStore(path);
  const said = (refs: string[], fields: Partial<NewChatRecord> = {}): NewChatRecord => ({
    refs, place: DM_SIBLING, pet: "sibling", journals: ["sibling"], sender: oleg, text: "x", excerpt: "x", ...fields,
  });
  const first = store.remember("work", said(["t.1.7"], { text: "Buy an elephant?", excerpt: "Buy an elephant?" }));
  expect(first).toEqual({ id: "m1", ref: ref("t.1.7"), place: DM_SIBLING, pet: "sibling", sender: oleg, text: "Buy an elephant?", excerpt: "Buy an elephant?" });
  expect(store.channelKeyOf("work", "c1")).toBe(DM); // minted for the place's channel
  // A replay is the record as it was: its journals too.
  expect(store.remember("work", said(["t.1.7"], { place: DM_INBOX, pet: "x", journals: ["chair"], sender: { kind: "household" }, text: "again" }))).toEqual(first);
  expect(store.inJournal("work", "chair", "c1", "m1")).toBe(false);
  const post = store.remember("work", said(["t.1.8", "t.1.9"], { place: DM_INBOX, sender: { kind: "pet", name: "sibling" }, text: "Yes", excerpt: "Yes" }));
  expect(post).toMatchObject({ id: "m2", ref: ref("t.1.8") }); // the first piece; General is the same channel
  expect(store.remember("home", said(["t.2.1"], { pet: "cat", journals: ["cat"] })).id).toBe("m1"); // its own numbers
  // Another channel of the house counts its own: m1 there is another message.
  const elsewhere = store.remember("work", said(["t.3.1"], { place: GROUP_SIBLING, text: "in the group" }));
  expect([elsewhere.id, store.channelKeyOf("work", "c2")]).toEqual(["m1", "telegram-private:2"]);
  const facts = { shown: { username: "oleg" }, kept: { message: 7, username: "oleg" } };
  expect(store.revise("work", "t.1.7", "t.1.7.1700000000", "Buy a giraffe? A big one", "Buy a giraffe?…", facts)).toEqual({ ...first, text: "Buy a giraffe? A big one", excerpt: "Buy a giraffe?…", facts });
  expect(store.revise("work", "t.1.99", "t.1.99.1", "x", "x", facts)).toBeUndefined();
  store.markResolved("work", "t.1.9"); // by any piece
  store.markResolved("work", "t.1.99"); // unknown: nothing
  // A place that names no channel is still kept (in no channel), never a failure after a post went out.
  expect(store.remember("work", said(["t.0.1"], { place: "pet:sibling" })).id).toBe("m1");
  store.close();
  const again = new SqliteStore(path);
  expect(again.recordByRef("work", ref("t.1.8"))).toEqual({ ...post, resolved: true }); // its choices made
  expect(again.recordByRef("work", ref("t.1.7.1700000000"))).toMatchObject({ id: "m1", text: "Buy a giraffe? A big one", excerpt: "Buy a giraffe?…" });
  expect(again.recordById("work", "c1", "m1")).toMatchObject({ text: "Buy a giraffe? A big one" });
  expect(again.recordById("work", "c2", "m1")).toMatchObject({ text: "in the group" });
  expect(again.recordById("work", "c1", "m1")?.resolved).toBeUndefined();
  for (const id of ["m3", "2", "m2; DROP TABLE chat_messages", "M2"]) expect(again.recordById("work", "c1", id)).toBeUndefined();
  expect([again.recordById("home", "c1", "m2"), again.recordById("work", "c2", "m2")]).toEqual([undefined, undefined]);
  expect(again.remember("work", said(["t.1.10"])).id).toBe("m3");
  expect(again.remember("work", said(["t.3.2"], { place: GROUP_SIBLING })).id).toBe("m2");
});

test("journals: a record is in the journals it was written into, by channel and id; one record in several journals, so an edit is seen in each", () => {
  const store = new SqliteStore(":memory:");
  const record = (refs: string[], journals: string[]): NewChatRecord => ({ refs, place: DM_SIBLING, pet: journals[0] ?? "", journals, sender: oleg, text: "elephant", excerpt: "elephant" });
  const shared = store.remember("work", record(["a"], ["sibling", "chair"])); // one call, two journals
  const own = store.remember("work", record(["b"], ["chair"]));
  expect([store.inJournal("work", "sibling", "c1", shared.id), store.inJournal("work", "chair", "c1", shared.id)]).toEqual([true, true]);
  expect([store.inJournal("work", "sibling", "c1", own.id), store.inJournal("work", "chair", "c1", own.id)]).toEqual([false, true]);
  expect([store.inJournal("work", "sibling", "c2", shared.id), store.inJournal("home", "sibling", "c1", shared.id), store.inJournal("work", "sibling", "c1", "c1")]).toEqual([false, false, false]);
  store.revise("work", "a", "a.1", "giraffe", "giraffe", {});
  expect(store.recordById("work", "c1", shared.id)?.text).toBe("giraffe");
});

test("a v4 database keeps the ids its chat records had (migration 5), then waits for K1: its places name no channel", () => {
  const path = join(tempDir(), "household.db");
  const raw = new Database(path);
  raw.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, house TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, ref TEXT,
    created TEXT NOT NULL DEFAULT 'x', updated TEXT, edits TEXT, meta TEXT);
    CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chat (id INTEGER PRIMARY KEY AUTOINCREMENT, house TEXT NOT NULL, ref TEXT NOT NULL, place TEXT, author TEXT NOT NULL,
    excerpt TEXT NOT NULL, created TEXT NOT NULL DEFAULT 'x');
    PRAGMA user_version = 4;`);
  raw.run("INSERT INTO chat (id, house, ref, place, author, excerpt) VALUES (3, 'work', 'a', 'sibling', 'pet', 'mine'), (7, 'home', 'b', NULL, 'person', 'theirs'), (9, 'work', 'c', 'sibling', 'household', 'notice')");
  raw.close();
  const db = stopsBeforeK2(path);
  // Places were pets' names (none: the inbox), and became ids per house (migration 7).
  const rows = db.query<{ house: string; seq: number; place: string; pet: string }, []>("SELECT house, seq, place, pet FROM chat_messages ORDER BY house, seq").all();
  expect(rows).toEqual([{ house: "home", seq: 7, place: "c1", pet: "" }, { house: "work", seq: 3, place: "c1", pet: "sibling" }, { house: "work", seq: 9, place: "c1", pet: "sibling" }]);
  expect([placeKeyOf(db, "work", "c1"), placeKeyOf(db, "home", "c1")]).toEqual(["pet:sibling", "inbox"]);
});

test("channels and people get Household's ids per house, minted once and kept", () => {
  const path = join(tempDir(), "household.db");
  const store = new SqliteStore(path);
  expect([store.channelId("work", DM), store.channelId("work", "telegram-private:2"), store.channelId("work", DM), store.channelId("home", DM)]).toEqual(["c1", "c2", "c1", "c1"]);
  expect([store.personId("work", "telegram.user.1" as SenderRef), store.personId("work", "telegram.user.2" as SenderRef)]).toEqual(["p1", "p2"]);
  store.close();
  const again = new SqliteStore(path);
  expect([again.personId("work", "telegram.user.1" as SenderRef), again.channelKeyOf("work", "c2")]).toEqual(["p1", "telegram-private:2"]);
  for (const id of ["c3", "m1", "p1", "2", "c2; DROP TABLE chat_ids"]) expect(again.channelKeyOf("work", id)).toBeUndefined();
});

/** The schema as P1 left it (user_version 6), what the running daemon's database had before C1. */
const V6 = `CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, ref TEXT,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), updated TEXT, edits TEXT, meta TEXT);
  CREATE INDEX messages_by_pet ON messages (house, pet, status);
  CREATE INDEX messages_by_ref ON messages (house, ref);
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX messages_by_edits ON messages (house, edits);
  CREATE TABLE chat_messages (
    house TEXT NOT NULL, seq INTEGER NOT NULL, ref TEXT NOT NULL, place TEXT, pet TEXT NOT NULL, sender TEXT NOT NULL,
    excerpt TEXT NOT NULL, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), PRIMARY KEY (house, seq));
  CREATE TABLE chat_refs (house TEXT NOT NULL, ref TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (house, ref));
  CREATE INDEX chat_refs_by_seq ON chat_refs (house, seq);
  PRAGMA user_version = 6;`;

test("the live schema (v6) migrates: places become ids, the Telegram thread stays the pet's, old queued envelopes fail; then it waits for K1", () => {
  const path = join(tempDir(), "household.db");
  const raw = new Database(path);
  raw.run(V6);
  // As in the running daemon's database: sibling's thread 21837, its records under the pet's name, the inbox's under none.
  const chat = "telegram.9070374622.100200300";
  raw.run("INSERT INTO state (key, value) VALUES (?, '21837'), (?, 'sibling'), ('telegram.9070374622.offset', '500')", [`${chat}.thread.sibling`, `${chat}.place.21837`]);
  const person = JSON.stringify({ kind: "person", ref: "telegram.user.100200300", name: "Inker" });
  raw.run("INSERT INTO chat_messages (house, seq, ref, place, pet, sender, excerpt) VALUES ('work', 1, ?, 'sibling', 'sibling', ?, 'notice'), ('work', 2, ?, NULL, 'sibling', ?, 'Hey')", [
    `${chat}.10`, JSON.stringify({ kind: "household" }), `${chat}.11`, person,
  ]);
  raw.run("INSERT INTO chat_refs (house, ref, seq) VALUES ('work', ?, 1), ('work', ?, 2)", [`${chat}.10`, `${chat}.11`]);
  const old = JSON.stringify({ channel: "telegram", from: { ref: "telegram.user.100200300", name: "Inker", trust: "owner" }, external: { message: 11 }, id: "m2" });
  raw.run("INSERT INTO messages (house, pet, text, status, origin, ref, meta) VALUES ('work', 'sibling', 'Hey', 'received', 'chat', ?, ?), ('work', 'sibling', 'cli', 'received', 'cli', NULL, NULL), ('work', 'sibling', 'done', 'answered', 'chat', 'x', ?)", [
    `${chat}.11`, old, old,
  ]);
  raw.close();

  const db = stopsBeforeK2(path);
  expect([kv(db, `${chat}.thread.c1`), kv(db, `${chat}.thread.sibling`), kv(db, `${chat}.place.21837`), kv(db, "telegram.9070374622.offset")]).toEqual(["21837", undefined, "c1", "500"]);
  expect([placeKeyOf(db, "work", "c1"), placeKeyOf(db, "work", "c2")]).toEqual(["pet:sibling", "inbox"]);
  expect(db.query("SELECT place FROM chat_messages ORDER BY seq").all()).toEqual([{ place: "c1" }, { place: "c2" }]);
  // An old envelope cannot be shown: the message is redelivered as interrupted (the person is asked to repeat).
  expect(db.query("SELECT text, status FROM messages ORDER BY id").all()).toEqual([{ text: "Hey", status: "delivered" }, { text: "cli", status: "received" }, { text: "done", status: "answered" }]);
});

test("a v6 thread whose chat has no records goes to the one house with a pet of that name; an ambiguous one is left", () => {
  const path = join(tempDir(), "household.db");
  const raw = new Database(path);
  raw.run(V6);
  raw.run("INSERT INTO state (key, value) VALUES ('telegram.1.2.thread.sibling', '100'), ('telegram.1.2.place.100', 'sibling'), ('telegram.3.4.thread.cat', '7')");
  raw.run("INSERT INTO messages (house, pet, text, status, origin) VALUES ('work', 'sibling', 'hi', 'answered', 'cli'), ('home', 'cat', 'a', 'answered', 'cli'), ('attic', 'cat', 'b', 'answered', 'cli')");
  raw.close();
  const db = stopsBeforeK2(path);
  expect([kv(db, "telegram.1.2.thread.c1"), kv(db, "telegram.1.2.place.100"), placeKeyOf(db, "work", "c1")]).toEqual(["100", "c1", "pet:sibling"]);
  expect(kv(db, "telegram.3.4.thread.cat")).toBe("7"); // two houses have a cat: no telling whose
});

/** The schema as K1 left it (user_version 12): what the running daemon's database has before K2. */
const V12 = `CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, ref TEXT,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), updated TEXT, edits TEXT, meta TEXT);
  CREATE INDEX messages_by_pet ON messages (house, pet, status);
  CREATE INDEX messages_by_ref ON messages (house, ref);
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX messages_by_edits ON messages (house, edits);
  CREATE TABLE chat_refs (house TEXT NOT NULL, ref TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (house, ref));
  CREATE INDEX chat_refs_by_seq ON chat_refs (house, seq);
  CREATE TABLE chat_ids (house TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (house, kind, seq));
  CREATE UNIQUE INDEX chat_ids_by_value ON chat_ids (house, kind, value);
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    house TEXT NOT NULL, seq INTEGER NOT NULL, ref TEXT NOT NULL, place TEXT, pet TEXT NOT NULL, sender TEXT NOT NULL, excerpt TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), text TEXT, resolved INTEGER NOT NULL DEFAULT 0, relayed INTEGER NOT NULL DEFAULT 0, channel TEXT,
    UNIQUE (house, seq));
  CREATE VIRTUAL TABLE chat_search USING fts5(text, content = 'chat_messages', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER chat_search_add AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_search (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TABLE web_sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  PRAGMA user_version = 12;`;

/** Oleg's database as K1 left it (v12): places c1 sibling's thread «🐾 Sibling» (Telegram thread 21837), c2 General. */
function ownersV12(path: string, more: (raw: Database) => void = () => {}): void {
  const raw = new Database(path);
  raw.run(V12);
  raw.run("INSERT INTO chat_ids (house, kind, seq, value) VALUES ('work', 'place', 1, ?), ('work', 'place', 2, ?), ('work', 'person', 1, 'telegram.user.100200300')", [OLEG_SIBLING, OLEG_INBOX]);
  raw.run("INSERT INTO state (key, value) VALUES (?, '21837'), (?, 'c1'), ('chat.last-place.work/sibling', 'c1'), ('telegram.9070374622.offset', '500')", [`${OLEG_CHAT}.thread.c1`, `${OLEG_CHAT}.place.21837`]);
  const person = JSON.stringify({ kind: "person", ref: "telegram.user.100200300", name: "Oleg" });
  const k1 = (meta: object) => JSON.stringify({ kind: "telegram-private", name: "DM", meta });
  const rows: [number, string, string, string, string, string | null, number][] = [
    // seq, place, pet, sender, text, the header's channel (K1), relayed
    [1, "c1", "sibling", JSON.stringify({ kind: "household" }), "container started", null, 0],
    [2, "c1", "sibling", person, "Buy an elephant", k1({ message: 11, thread: 21837, user: 100200300, username: "inkerfu" }), 0],
    [3, "c1", "sibling", JSON.stringify({ kind: "pet", name: "sibling" }), "Will buy the elephant tomorrow", null, 0],
    [4, "c2", "sibling", person, "an elephant from General", k1({ message: 12, user: 100200300, username: "inkerfu", forward: { name: "Julia", user: 77, date: 1730000000 } }), 1],
    [5, "c2", "sibling", JSON.stringify({ kind: "household" }), "passed to the thread «🐾 Sibling»", null, 0],
    [6, "c2", "", person, "nobody's elephant", null, 0], // from before places had ids: no pet's
  ];
  for (const [seq, place, pet, sender, text, channel, relayed] of rows) {
    raw.run("INSERT INTO chat_messages (house, seq, ref, place, pet, sender, excerpt, text, channel, relayed) VALUES ('work', ?, ?, ?, ?, ?, ?, ?, ?, ?)", [seq, `${OLEG_CHAT}.${seq + 10}`, place, pet, sender, text, text, channel, relayed]);
    raw.run("INSERT INTO chat_refs (house, ref, seq) VALUES ('work', ?, ?)", [`${OLEG_CHAT}.${seq + 10}`, seq]);
  }
  // A message still queued at the upgrade, with its K1 header.
  const header = { event: { kind: "message", id: "m2" }, from: { id: "p1", name: "Oleg", trust: "owner" }, place: { id: "c1", kind: "pet-thread", name: "🐾 Sibling" }, channel: JSON.parse(k1({ message: 11, username: "inkerfu" })) };
  raw.run("INSERT INTO messages (house, pet, text, status, origin, ref, meta) VALUES ('work', 'sibling', 'Buy an elephant', 'received', 'chat', ?, ?)", [`${OLEG_CHAT}.12`, JSON.stringify(header)]);
  more(raw);
  raw.close();
}
const OLEG_DM = "telegram-private:100200300";
const OLEG_SIBLING = `pet:sibling@${OLEG_DM}`;
const OLEG_INBOX = `inbox@${OLEG_DM}`;
const OLEG_CHAT = "telegram.9070374622.100200300";

test("Oleg's v12 database migrates (K2): places by key (the thread stays his), the DM is c1 with every old id (General's too), journals are sibling's", () => {
  const path = join(tempDir(), "household.db");
  ownersV12(path);
  const store = new SqliteStore(path);
  // Thread 21837 is sibling's place in the DM, by key both ways; so is where he was last written to.
  expect([store.get(`${OLEG_CHAT}.thread.${OLEG_SIBLING}`), store.get(`${OLEG_CHAT}.place.21837`), store.get("chat.last-place.work/sibling"), store.get("telegram.9070374622.offset")]).toEqual([
    "21837", OLEG_SIBLING, OLEG_SIBLING, "500",
  ]);
  expect(store.get(`${OLEG_CHAT}.thread.c1`)).toBeUndefined();
  // The DM is c1, the channel of both places; place ids are gone.
  expect([store.channelId("work", OLEG_DM), store.channelKeyOf("work", "c1"), store.channelKeyOf("work", "c2")]).toEqual(["c1", OLEG_DM, undefined]);
  for (const seq of [1, 2, 3, 4, 5, 6]) expect(store.recordById("work", "c1", `m${seq}`)).toMatchObject({ ref: `${OLEG_CHAT}.${seq + 10}`, place: seq < 4 ? OLEG_SIBLING : OLEG_INBOX });
  // Sibling's journal is what he could reach: not Household's notices, not the record of no pet.
  expect([1, 2, 3, 4, 5, 6].map((seq) => store.inJournal("work", "sibling", "c1", `m${seq}`))).toEqual([false, true, true, true, false, false]);
  // A person's record keeps its facts as the adapter splits them now: the context shown, every fact kept.
  expect(store.recordById("work", "c1", "m4")?.facts).toEqual({
    shown: { username: "inkerfu", forward: { name: "Julia", date: 1730000000 } },
    kept: { message: 12, user: 100200300, username: "inkerfu", forward: { name: "Julia", user: 77, date: 1730000000 } },
  });
  // The queued message fails as interrupted (its header had a place, no channel id), in its place by key.
  expect(store.unfinished("work", "sibling")).toMatchObject([{ status: "delivered", place: OLEG_SIBLING }]);
  // The DM goes on counting from its last message; a channel added later starts after the house's old ones too.
  const next = (place: string, ref: string) => store.remember("work", { refs: [ref], place, pet: "sibling", journals: ["sibling"], sender: oleg, text: "next", excerpt: "next" }).id;
  expect([next(OLEG_SIBLING, "a"), next("pet:sibling@telegram-private:42", "b"), next("pet:sibling@telegram-private:42", "c")]).toEqual(["m7", "m7", "m8"]);
  store.close();
  // All his history is found in the DM: the thread's and General's, never the record of no pet.
  const found = searchHistory(new Database(path), { house: "work", pet: "sibling", channel: "c1", words: ["elephant"], limit: 10 });
  expect(found.records.map(({ id, meta }) => [id, meta])).toEqual([
    ["m4", { username: "inkerfu", forward: { name: "Julia", date: 1730000000 } }],
    ["m3", undefined],
    ["m2", { username: "inkerfu" }], // Telegram's numbers are kept only
  ]);
  const raw = new Database(path);
  expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 18 });
  expect(raw.query("SELECT count(*) AS n FROM chat_ids WHERE kind = 'place'").get()).toEqual({ n: 0 });
  raw.close();
});

test("a v12 database with a record whose place names no channel (K1 never ran) is refused loudly at v13, and left at v12", () => {
  const path = join(tempDir(), "household.db");
  ownersV12(path, (raw) => raw.run("INSERT INTO chat_ids (house, kind, seq, value) VALUES ('work', 'place', 3, 'pet:chair')"));
  expect(() => new SqliteStore(path)).toThrow("house work: place c3 (pet:chair) names no channel: run K1 (channels) on this database first");
  const noKey = join(tempDir(), "household.db");
  ownersV12(noKey, (raw) => raw.run("UPDATE chat_messages SET place = 'c9' WHERE seq = 3"));
  expect(() => new SqliteStore(noKey)).toThrow("house work: message m3 is in place c9 (no key), which names no channel");
  const raw = new Database(noKey);
  expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 12 });
  expect(raw.query("SELECT value FROM state WHERE key = ?").get(`${OLEG_CHAT}.thread.c1`)).toEqual({ value: "21837" });
  raw.close();
});
