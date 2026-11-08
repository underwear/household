import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { SenderRef } from "../../src/core/channel";
import { historyItem, renderHistory } from "../../src/core/history";
import type { ChatSender } from "../../src/core/message";
import { ftsQuery, openReadOnly, searchHistory, type HistoryFilter } from "../../src/infra/history-store";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { ref } from "../app/fake-channel";
import { tempDir } from "../helpers";

const oleg: ChatSender = { kind: "person", ref: "telegram.user.1" as SenderRef, name: "Oleg" };
const ann: ChatSender = { kind: "person", ref: "telegram.user.2" as SenderRef, name: "Ann" };
const sibling: ChatSender = { kind: "pet", name: "sibling" };
/** Places of work's private chat (channel c1 once minted), and of a second chat (c2). */
const SIBLING = "pet:sibling@telegram-private:8";
const CHAIR = "pet:chair@telegram-private:8";
const INBOX = "inbox@telegram-private:8";
const GROUP = "pet:sibling@telegram-private:2";
/** Old databases' records are in place c1, sibling's thread in a private chat: channel c1 once migrated. */
const PLACE = "INSERT INTO chat_ids (house, kind, seq, value) VALUES ('work', 'place', 1, 'pet:sibling@telegram-private:8'), ('home', 'place', 1, 'pet:sibling@telegram-private:9')";

/** A store on a file, a second connection to it as the history process has, and records to search. */
function setup() {
  const path = join(tempDir(), "household.db");
  const store = new SqliteStore(path);
  let n = 0;
  const add = (text: string, fields: { place?: string; pet?: string; journals?: string[]; sender?: ChatSender; house?: string } = {}) => {
    const { place = SIBLING, pet = "sibling", journals = [pet], sender = oleg, house = "work" } = fields;
    return store.remember(house, { refs: [ref(`r${++n}`)], place, pet, journals, sender, text, excerpt: text }).id;
  };
  const db = openReadOnly(path);
  const ids = (filter: Partial<HistoryFilter> = {}) =>
    searchHistory(db, { house: "work", pet: "sibling", channel: "c1", limit: 20, ...filter }).records.map(({ id }) => id);
  return { path, store, db, add, ids };
}

test("words are quoted FTS prefix terms: whatever the pet writes is never search syntax", () => {
  expect(ftsQuery(["elephant", "AND", 'a"b'])).toBe('"elephant"* "AND"* "a""b"*');
});

test("a search: every word, as a word or its start, any case, Latin accents folded, Greek too (ά is not α: no folding there); newest first", () => {
  const { add, ids } = setup();
  const elephant = add("Buy an ELEPHANT in München");
  const two = add("elephants with giraffes");
  add("nothing in common");
  const greek = add("Ελέφαντας στην Αθήνα");
  expect(ids({ words: ["elephant"] })).toEqual([two, elephant]);
  expect(ids({ words: ["Elephant", "munch"] })).toEqual([elephant]);
  expect(ids({ words: ["elephant", "giraff"] })).toEqual([two]);
  expect(ids({ words: ["ΕΛΈΦΑΝΤΑΣ", "αθήν"] })).toEqual([greek]);
  expect(ids({ words: ["ελεφαντας"] })).toEqual([]);
  expect(ids({ words: ["AND"] })).toEqual([]); // a keyword is a word to look for, not an operator
  expect(ids({ words: ["NEAR"] })).toEqual([]);
  expect(ids()).toEqual([greek, "m3", two, elephant]);
});

test("the scope: the pet's own journal in one channel (the only guard): never another pet's, another house's, or Household's notices (in no journal)", () => {
  const { add, ids } = setup();
  const mine = add("elephant, mine");
  add("elephant in another's thread", { place: CHAIR, pet: "chair" });
  add("elephant from General, handed to chair", { place: INBOX, pet: "chair" });
  add("elephant in another house", { house: "home" });
  add("elephant: a notice", { sender: { kind: "household" }, journals: [] });
  const inbox = add("elephant from General", { place: INBOX });
  const reply = add("elephant reply", { sender: sibling });
  // One line in two journals (what `visibility: all` will do): each pet finds it.
  const shared = add("elephant for both", { pet: "chair", journals: ["chair", "sibling"] });
  const group = add("elephant in the group", { place: GROUP });
  expect(ids({ words: ["elephant"] })).toEqual([shared, reply, inbox, mine]);
  expect(ids({ words: ["elephant"], pet: "chair" })).toEqual([shared, "m3", "m2"]); // the notice (m5) is in no journal
  expect(ids({ words: ["elephant"], channel: "c2" })).toEqual([group]);
  expect(group).toBe("m1"); // ids are per channel
});

test("filters: who wrote, since/until, before with more; an edit is found by its latest text only", () => {
  const { store, db, add, ids } = setup();
  const first = add("first");
  const fromAnn = add("from Ann", { sender: ann });
  const mine = add("mine", { sender: sibling });
  const edited = add("old text");
  store.revise("work", "r4", "r4.1", "new text", "new text", {});
  expect(ids({ sender: { kind: "pet", name: "sibling" } })).toEqual([mine]);
  expect(ids({ sender: { kind: "person", ref: "telegram.user.1" } })).toEqual([edited, first]);
  expect(ids({ sender: { kind: "person", ref: "telegram.user.2" } })).toEqual([fromAnn]);
  expect(ids({ words: ["old"] })).toEqual([]);
  expect(ids({ words: ["new"] })).toEqual([edited]);
  db.run("PRAGMA query_only = OFF"); // a test's own times
  db.run("UPDATE chat_messages SET created = '2026-11-0' || seq || 'T12:00:00.000Z'");
  expect(ids({ since: "2026-11-02T00:00:00.000Z", until: "2026-11-04T00:00:00.000Z" })).toEqual([mine, fromAnn]);
  expect(ids({ since: "2026-11-04T12:00:00.000Z" })).toEqual([edited]);
  const page = (before?: number) => searchHistory(db, { house: "work", pet: "sibling", channel: "c1", limit: 2, ...(before ? { before } : {}) });
  expect([page().records.map(({ id }) => id), page().more]).toEqual([[edited, mine], true]);
  expect([page(3).records.map(({ id }) => id), page(3).more]).toEqual([[fromAnn, first], false]);
  expect(page().records[0]).toMatchObject({ id: edited, text: "new text", when: "2026-11-04T12:00:00.000Z" });
});

/** The live schema after C2 and C3 (user_version 8): the queue, state, records and their refs, the ids. */
const V8 = `CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house TEXT NOT NULL, pet TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL, ref TEXT,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), updated TEXT, edits TEXT, meta TEXT);
  CREATE INDEX messages_by_pet ON messages (house, pet, status);
  CREATE INDEX messages_by_ref ON messages (house, ref);
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE INDEX messages_by_edits ON messages (house, edits);
  CREATE TABLE chat_messages (
    house TEXT NOT NULL, seq INTEGER NOT NULL, ref TEXT NOT NULL, place TEXT, pet TEXT NOT NULL, sender TEXT NOT NULL,
    excerpt TEXT NOT NULL, created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), text TEXT, resolved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (house, seq));
  CREATE TABLE chat_refs (house TEXT NOT NULL, ref TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (house, ref));
  CREATE INDEX chat_refs_by_seq ON chat_refs (house, seq);
  CREATE TABLE chat_ids (house TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (house, kind, seq));
  CREATE UNIQUE INDEX chat_ids_by_value ON chat_ids (house, kind, value);
  PRAGMA user_version = 8;`;

/** What H1 added (user_version 9, the live database now): relayed, and the index keyed by the implicit rowid. */
const V9 = `${V8}
  ALTER TABLE chat_messages ADD COLUMN relayed INTEGER NOT NULL DEFAULT 0;
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
  PRAGMA user_version = 9;`;

/** The schema as W1 left it before H1.1 (user_version 10): records keyed by `id`, no `channel` column yet. */
const V10 = `${V8.replace("PRAGMA user_version = 8;", "")}
  DROP TABLE chat_messages;
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    house TEXT NOT NULL, seq INTEGER NOT NULL, ref TEXT NOT NULL, place TEXT, pet TEXT NOT NULL, sender TEXT NOT NULL, excerpt TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')), text TEXT, resolved INTEGER NOT NULL DEFAULT 0, relayed INTEGER NOT NULL DEFAULT 0,
    UNIQUE (house, seq));
  CREATE VIRTUAL TABLE chat_search USING fts5(text, content = 'chat_messages', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER chat_search_add AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_search (rowid, text) VALUES (new.id, new.text);
  END;
  PRAGMA user_version = 10;`;

/** Oleg's database as C2 and C3 left it (user_version 8), with what it holds. */
function v8(path: string): void {
  const raw = new Database(path);
  raw.run(V8);
  const person = JSON.stringify({ kind: "person", ref: "telegram.user.8", name: "Oleg" });
  const rows: [number, string, string | null][] = [
    [1, person, null], // before C2: the queue has its text (and an edit of it)
    [2, JSON.stringify({ kind: "pet", name: "sibling" }), null], // a pet's reply before C2: only its excerpt
    [3, person, null], // forwarded
    [4, person, "already has text"],
    [5, person, null], // the queue has none (a dialog's answer)
    [6, JSON.stringify({ kind: "household" }), null],
  ];
  for (const [seq, sender, text] of rows) {
    raw.run("INSERT INTO chat_messages (house, seq, ref, place, pet, sender, excerpt, text) VALUES ('work', ?, ?, 'c1', 'sibling', ?, ?, ?)", [seq, `t.${seq}`, sender, `excerpt ${seq}`, text]);
    raw.run("INSERT INTO chat_refs (house, ref, seq) VALUES ('work', ?, ?)", [`t.${seq}`, seq]);
  }
  raw.run("INSERT INTO chat_refs (house, ref, seq) VALUES ('work', 't.1.edit', 1)");
  raw.run(PLACE);
  const relayed = JSON.stringify({ event: { kind: "message", id: "m3", relayed: true } });
  raw.run(`INSERT INTO messages (house, pet, text, status, origin, ref, edits, meta) VALUES
    ('work', 'sibling', 'buy an elephant', 'answered', 'chat', 't.1', NULL, NULL),
    ('work', 'sibling', 'buy two elephants', 'answered', 'chat', 't.1.edit', 't.1', NULL),
    ('work', 'sibling', 'forwarded', 'answered', 'chat', 't.3', NULL, ?),
    ('work', 'sibling', 'something else', 'answered', 'chat', 't.4', NULL, NULL),
    ('work', 'sibling', '<household-header>', 'rejected', 'chat', 't.5', NULL, NULL)`, [relayed]);
  raw.close();
}

test("a v8 database migrates: the person's text comes from the queue (its latest version), relayed too; all of it is searchable", () => {
  const path = join(tempDir(), "household.db");
  v8(path);
  const store = new SqliteStore(path);
  expect([1, 2, 3, 4, 5].map((seq) => store.recordById("work", "c1", `m${seq}`)?.text)).toEqual(["buy two elephants", undefined, "forwarded", "already has text", undefined]);
  expect([store.recordById("work", "c1", "m3")?.relayed, store.recordById("work", "c1", "m1")?.relayed]).toEqual([true, undefined]);
  const db = new Database(path);
  const search = (words: string[]) => searchHistory(db, { house: "work", pet: "sibling", channel: "c1", words, limit: 20 }).records.map(({ id }) => id);
  expect([search(["elephant"]), search(["forw"]), search(["text"]), search(["household"])]).toEqual([["m1"], ["m3"], ["m4"], []]);
  // New records and edits keep the index up to date.
  store.remember("work", { refs: [ref("t.7")], place: SIBLING, pet: "sibling", journals: ["sibling"], sender: { kind: "pet", name: "sibling" }, text: "giraffe", excerpt: "giraffe" });
  store.revise("work", "t.4", "t.4.1", "now about a giraffe", "now about a giraffe", {});
  expect([search(["giraffe"]), search(["text"])]).toEqual([["m7", "m4"], []]);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
});

test("a v9 database (the live one) migrates: records keep their ids and texts, get a key the index is linked by, old senders their ref", () => {
  const path = join(tempDir(), "household.db");
  const raw = new Database(path);
  raw.run(V9);
  const nameless = JSON.stringify({ kind: "person", ref: "", name: "" }); // records older than M4.1
  const rows: [string, number, string, string][] = [
    ["work", 1, nameless, "buy an elephant"], // an envelope of M3.1: `from.ref`
    ["work", 2, nameless, "buy a giraffe"], // a header of C1: `from.id`
    ["work", 3, nameless, "no trace"], // the queue has nothing on it
    ["work", 4, JSON.stringify({ kind: "pet", name: "sibling" }), "elephant bought"],
    ["home", 1, JSON.stringify({ kind: "person", ref: "telegram.user.9", name: "Ann" }), "elephant in another house"],
  ];
  for (const [house, seq, sender, text] of rows) {
    raw.run("INSERT INTO chat_messages (house, seq, ref, place, pet, sender, excerpt, text) VALUES (?, ?, ?, 'c1', 'sibling', ?, ?, ?)", [house, seq, `${house}.${seq}`, sender, text, text]);
    raw.run("INSERT INTO chat_refs (house, ref, seq) VALUES (?, ?, ?)", [house, `${house}.${seq}`, seq]);
  }
  raw.run("INSERT INTO chat_ids (house, kind, seq, value) VALUES ('work', 'person', 1, 'telegram.user.7'), ('work', 'person', 2, 'telegram.user.8')");
  raw.run(PLACE);
  const envelope = JSON.stringify({ channel: "telegram", from: { ref: "telegram.user.7", name: "Inker", trust: "owner" }, external: {}, id: "m1" });
  const header = JSON.stringify({ event: { kind: "message", id: "m2" }, from: { id: "p2", name: "Oleg", trust: "owner" } });
  raw.run("INSERT INTO messages (house, pet, text, status, origin, ref, meta) VALUES ('work', 'sibling', 'x', 'answered', 'chat', 'work.1', ?), ('work', 'sibling', 'y', 'answered', 'chat', 'work.2', ?)", [envelope, header]);
  raw.close();

  const store = new SqliteStore(path);
  expect([1, 2, 3, 4].map((seq): unknown => store.recordById("work", "c1", `m${seq}`)?.sender)).toEqual([
    { kind: "person", ref: "telegram.user.7", name: "Inker" },
    { kind: "person", ref: "telegram.user.8", name: "Oleg" },
    { kind: "person", ref: "", name: "" }, // nothing tells: stays
    { kind: "pet", name: "sibling" },
  ]);
  expect(store.recordById("home", "c1", "m1")).toMatchObject({ text: "elephant in another house" });
  const db = openReadOnly(path);
  expect(db.query("SELECT name, pk FROM pragma_table_info('chat_messages') WHERE pk > 0").all()).toEqual([{ name: "id", pk: 1 }]);
  const search = (house: string, words: string[]) => searchHistory(db, { house, pet: "sibling", channel: "c1", words, limit: 20 }).records.map(({ id }) => id);
  expect([search("work", ["elephant"]), search("home", ["elephant"]), search("work", ["giraffe"])]).toEqual([["m4", "m1"], ["m1"], ["m2"]]);
  store.remember("work", { refs: [ref("work.5")], place: SIBLING, pet: "sibling", journals: ["sibling"], sender: oleg, text: "elephant again", excerpt: "elephant again" });
  store.revise("work", "work.2", "work.2.1", "buy an elephant, not a giraffe", "x", {});
  store.close();
  const vacuumed = new Database(path);
  vacuumed.run("VACUUM"); // the index is linked by `id`, which VACUUM keeps
  vacuumed.close();
  expect([search("work", ["elephant"]), search("work", ["giraffe"])]).toEqual([["m5", "m4", "m2", "m1"], ["m2"]]);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
});

test("a v10 database migrates: a person's records get their header's channel from the queue, an old envelope's made into one", () => {
  const path = join(tempDir(), "household.db");
  const raw = new Database(path);
  raw.run(V10);
  raw.run(PLACE);
  const rows: [number, ChatSender][] = [[1, oleg], [2, oleg], [3, oleg], [4, oleg], [5, oleg], [6, sibling], [7, oleg], [8, oleg]];
  for (const [seq, sender] of rows) {
    raw.run("INSERT INTO chat_messages (house, seq, ref, place, pet, sender, excerpt, text) VALUES ('work', ?, ?, 'c1', 'sibling', ?, 'x', ?)", [seq, `t.${seq}`, JSON.stringify(sender), `text ${seq}`]);
    raw.run("INSERT INTO chat_refs (house, ref, seq) VALUES ('work', ?, ?)", [`t.${seq}`, seq]);
  }
  raw.run("INSERT INTO chat_refs (house, ref, seq) VALUES ('work', 't.3.1', 3)");
  const forward = { name: "Julia", user: 77, date: 1730000000 };
  const header = (id: string, meta: object) => JSON.stringify({ event: { kind: "message", id, relayed: true }, from: { id: "p1", name: "Oleg", trust: "owner" }, channel: { kind: "telegram", meta } });
  const envelope = (meta: object) => JSON.stringify({ channel: "telegram", from: { ref: "telegram.user.1", name: "Oleg", trust: "owner" }, id: "m2", ...meta });
  const queued: [string, string | null, string, string | null][] = [
    ["t.1", null, "answered", header("m1", { message: 1, forward })], // a header: as it is
    ["t.2", null, "answered", envelope({ external: { message: 2 }, forwarded: { name: "Julia", external: { user: 77, date: 1730000000 } } })], // M3.1
    ["t.3", null, "answered", envelope({ external: { message: 3 } })],
    ["t.3.1", "t.3", "answered", header("m3", { message: 3, edited: 1730000100 })], // its edit: the newest wins
    ["t.4", null, "answered", null], // no meta (before M3.1): nothing to tell
    ["t.5", null, "rejected", header("m5", { message: 5 })],
    ["t.7", null, "answered", "{not json"], // unreadable: nothing to tell, and the migration goes on
    ["t.8", null, "answered", envelope({ external: {} })], // no facts: no `meta`, as a header has it
  ];
  for (const [at, edits, status, meta] of queued) {
    raw.run("INSERT INTO messages (house, pet, text, status, origin, ref, edits, meta) VALUES ('work', 'sibling', 'x', ?, 'chat', ?, ?, ?)", [status, at, edits, meta]);
  }
  raw.close();

  const store = new SqliteStore(path);
  // Then K2 (migration 13): the facts only, split as the adapter does: the context shown, all of them kept.
  const shownForward = { name: "Julia", date: 1730000000 };
  expect([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => store.recordById("work", "c1", `m${seq}`)?.facts)).toEqual([
    { shown: { forward: shownForward }, kept: { message: 1, forward } },
    { shown: { forward: shownForward }, kept: { message: 2, forward } },
    { kept: { message: 3, edited: 1730000100 } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // no facts at all
  ]);
  const [found] = searchHistory(openReadOnly(path), { house: "work", pet: "sibling", channel: "c1", words: ["text", "2"], limit: 1 }).records;
  const item = historyItem(found!, { id: "c1", kind: "telegram-private", name: "DM", audience: "private" }, { id: "p1", name: "Oleg", trust: "owner" });
  expect(renderHistory({ messages: [{ ...item, when: "…" }], more: false })).toBe(
    '{"messages":[{"id":"m2","when":"…","channel":{"id":"c1","kind":"telegram-private","name":"DM","audience":"private","meta":{"forward":{"name":"Julia","date":1730000000}}},' +
      '"from":{"id":"p1","name":"Oleg","trust":"owner"},"text":"text 2"}],"more":false}',
  );
});

test("a record's channel facts: kept for the person's message, replaced by an edit's; over 4 KB (bytes), what is only kept goes first", () => {
  const { store } = setup();
  const facts = (kept: object, shown: object = { username: "oleg" }) => ({ shown: shown as never, kept: kept as never });
  const said = { place: SIBLING, pet: "sibling", journals: ["sibling"], sender: oleg };
  store.remember("work", { refs: [ref("a")], ...said, text: "a", excerpt: "a", facts: facts({ message: 1 }) });
  expect(store.revise("work", "a", "a.1", "b", "b", facts({ message: 1, edited: 2 }))?.facts).toEqual(facts({ message: 1, edited: 2 }));
  // 2100 accented letters (two bytes each): under 4096 UTF-16 units, over 4096 bytes. Too much kept: the shown part stays.
  const big = "é".repeat(2100);
  store.remember("work", { refs: [ref("big")], ...said, text: "c", excerpt: "c", facts: facts({ name: big }) });
  expect([store.recordById("work", "c1", "m1")?.facts, store.recordById("work", "c1", "m2")?.facts]).toEqual([facts({ message: 1, edited: 2 }), { shown: { username: "oleg" } }]);
  // Too much shown too: nothing (an edit's latest version then has none, not the old one's).
  expect(store.revise("work", "a", "a.2", "d", "d", facts({ name: big }, { name: big }))).not.toHaveProperty("facts");
  expect(store.recordById("work", "c1", "m1")).not.toHaveProperty("facts");
});

test("the history process's connection refuses writes", () => {
  const { path, add } = setup();
  add("elephant");
  const db = openReadOnly(path);
  expect(() => db.run("DELETE FROM chat_messages")).toThrow("attempt to write a readonly database");
  expect(() => db.run("INSERT INTO state (key, value) VALUES ('x', 'y')")).toThrow("attempt to write a readonly database");
  expect(db.query("SELECT count(*) AS n FROM chat_messages").get()).toEqual({ n: 1 });
  expect(() => openReadOnly(join(tempDir(), "none.db"))).toThrow(); // never creates one
});

test("WAL: a long read on the history connection does not block the daemon's writes", () => {
  const { store, db, add, ids } = setup();
  add("before");
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  db.run("BEGIN");
  expect(ids()).toEqual(["m1"]); // a read transaction stays open
  add("during");
  store.set("offset", "1");
  expect(ids()).toEqual(["m1"]); // its snapshot
  db.run("COMMIT");
  expect(ids()).toEqual(["m2", "m1"]);
});
