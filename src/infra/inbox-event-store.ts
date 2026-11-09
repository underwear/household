import type { Database, SQLQueryBindings } from "bun:sqlite";
import { houseInboxSchema, inboxHistoryQuery, inboxItemSchema, type HouseInbox, type InboxItem } from "../core/house-inboxes";
import { HouseholdError } from "../core/errors";

type Row = { id: number; inbox: string; inbox_title: string; source: string; channel: string; delivery: string; title: string; text: string; metadata: string; url: string | null; received: number; occurred: number | null };
/** Immutable event journal, separate from the bounded scheduler cursor and chat delivery. */
export class InboxEventStore {
  constructor(private readonly db: Database) {}
  record(house: string, inbox: HouseInbox, item: InboxItem, received = Date.now()) {
    houseInboxSchema.parse(inbox); inboxItemSchema.parse(item);
    this.db.transaction(() => {
      const row = this.db.query<{id: number}, SQLQueryBindings[]>(`INSERT INTO inbox_events
        (house,inbox,event_id,inbox_title,source,channel,delivery,title,text,metadata,url,received,occurred)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(house,inbox,event_id) DO NOTHING RETURNING id`).get(
          house,inbox.name,item.id,inbox.title,inbox.source.kind,inbox.channel,inbox.delivery,item.title,item.text,JSON.stringify(item.metadata ?? {}),item.url ?? null,received,item.occurredAt ? Date.parse(item.occurredAt) : null);
      // Replays must not grant old events to newly subscribed pets.
      if (row) for (const pet of inbox.pets) this.db.run("INSERT INTO inbox_event_pets(event,pet) VALUES(?,?)", [row.id,pet]);
    })();
  }
  list(house: string, pet: string) {
    return this.db.query<{inbox: string; events: number; lastReceived: string}, [string,string]>(`SELECT inbox,count(*) AS events,
      strftime('%Y-%m-%dT%H:%M:%fZ',max(received)/1000.0,'unixepoch') AS lastReceived FROM inbox_events e
      WHERE house=? AND EXISTS(SELECT 1 FROM inbox_event_pets p WHERE p.event=e.id AND p.pet=?) GROUP BY inbox ORDER BY inbox`).all(house,pet);
  }
  find(house: string, pet: string, input: unknown) {
    const parsed = inboxHistoryQuery.safeParse(input);
    if (!parsed.success) throw new HouseholdError("Invalid inbox history query. Use ISO timestamps, since < until, positive before, and limit 1–50.");
    const q = parsed.data;
    const terms = q.query?.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (q.query && !terms.length) return { events: [] };
    const clauses = ["e.house=?", "EXISTS(SELECT 1 FROM inbox_event_pets p WHERE p.event=e.id AND p.pet=?)"];
    const params: SQLQueryBindings[] = [house,pet];
    if (q.inbox) { clauses.push("e.inbox=?"); params.push(q.inbox); }
    if (q.before) { clauses.push("e.id<?"); params.push(q.before); }
    const time = q.time === "received" ? "e.received" : "coalesce(e.occurred,e.received)";
    if (q.since) { clauses.push(`${time}>=?`); params.push(Date.parse(q.since)); }
    if (q.until) { clauses.push(`${time}<?`); params.push(Date.parse(q.until)); }
    if (terms.length) { clauses.push("e.id IN(SELECT rowid FROM inbox_event_search WHERE inbox_event_search MATCH ?)"); params.push(terms.map(t => `"${t}"*`).join(" AND ")); }
    const rows = this.db.query<Row, SQLQueryBindings[]>(`SELECT e.* FROM inbox_events e WHERE ${clauses.join(" AND ")} ORDER BY e.id DESC LIMIT ?`).all(...params,q.limit+1);
    const events = [];
    let size = 0;
    for (const row of rows.slice(0,q.limit)) {
      const event = { id: row.id, inbox: row.inbox, inboxTitle: row.inbox_title, source: row.source, delivery: row.delivery, title: row.title, text: row.text, metadata: JSON.parse(row.metadata), ...(row.url ? {url:row.url}:{}), receivedAt: new Date(row.received).toISOString(), occurredAt: row.occurred === null ? null : new Date(row.occurred).toISOString() };
      size += JSON.stringify(event).length;
      if (events.length && size > 64000) break;
      events.push(event);
    }
    return { events, ...(rows.length > events.length ? {next: events.at(-1)!.id} : {}) };
  }
}
