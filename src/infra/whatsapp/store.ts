import type { Database } from "bun:sqlite";

/** What a message is, as bots see it; `text` is its text or caption (empty for media without one). */
export type WhatsAppKind = "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact" | "poll" | "other";
export interface WhatsAppMedia { mimetype?: string; fileName?: string; size?: number; seconds?: number }
export interface WhatsAppMessage {
  chat: string; id: string; sender?: string; fromMe: boolean;
  /** Seconds since the epoch, as WhatsApp stamps messages. */
  at: number; kind: WhatsAppKind; text: string; quoted?: string; media?: WhatsAppMedia;
  /** The whole message (Baileys' BufferJSON), kept only for media: what a download needs. */
  raw?: string;
}
export interface WhatsAppContact { jid: string; name?: string; notify?: string; phone?: string }
export interface WhatsAppChatSummary { jid: string; name: string; group: boolean; last?: string; lastText?: string; lastFrom?: string }
/** A text the message had before an edit, and until when. */
export interface WhatsAppVersion { text: string; until: string }
export interface WhatsAppMessageView {
  chat: string; chatName: string; id: string; from: string; fromMe: boolean; at: string; kind: WhatsAppKind; text: string; quoted?: string; media?: WhatsAppMedia;
  /** When it was last edited; `previous` holds its earlier texts, oldest first. */
  edited?: string; previous?: WhatsAppVersion[];
  /** When its author deleted it for everyone; Household keeps what it had, as the owner chose. */
  deleted?: string;
  /** In words, for a reader: edited how many times, deleted when. */
  note?: string;
}

interface MessageRow { chat: string; id: string; sender: string | null; from_me: number; at: number; kind: WhatsAppKind; text: string; quoted: string | null; media: string | null; raw?: string | null; chat_name: string | null; sender_name: string | null; edited: number | null; deleted: number | null; versions: string | null }
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
/** What happened to a message, so a reader (a bot) can't mistake its last text for what was first said, or miss that it was withdrawn. */
function note(r: { versions: string | null; deleted: number | null }) {
  const edits = r.versions ? (JSON.parse(r.versions) as unknown[]).length : 0;
  const edited = edits ? `Edited ${edits === 1 ? "once" : `${edits} times`} by its author: text is the last version, previous the earlier ones, oldest first` : "";
  const deleted = r.deleted ? `${edited ? "; then d" : "D"}eleted for everyone by its author at ${iso(r.deleted)}: the other side no longer sees it; Household kept it` : "";
  return `${edited}${deleted}.`;
}
/** Words of a query as an FTS5 prefix match: punctuation never reaches the query language. */
export const searchTerms = (query: string) => (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map(t => `"${t}"*`).join(" AND ");

/** Names a chat or person: what the owner saved, else what they call themselves, else the number. */
const NAME = (jid: string, alias: string) => `coalesce(
  (SELECT name FROM whatsapp_chats WHERE connection=${alias}.connection AND jid=${jid} AND name IS NOT NULL),
  (SELECT coalesce(name, notify) FROM whatsapp_contacts WHERE connection=${alias}.connection AND jid=${jid} AND coalesce(name, notify) IS NOT NULL),
  (SELECT coalesce(name, notify) FROM whatsapp_contacts WHERE connection=${alias}.connection AND phone=${jid} AND coalesce(name, notify) IS NOT NULL))`;

/**
 * Each WhatsApp connection's keys and the chats, contacts and messages Household has seen. WhatsApp has no API to
 * read a chat back, so this is what bots read. Keys are per pairing (`auth`), the rest per connection, so a
 * connection paired again keeps its history.
 */
export class WhatsAppStore {
  constructor(private readonly db: Database) {}

  authGet(auth: string, key: string): string | undefined {
    return this.db.query<{ value: string }, [string, string]>("SELECT value FROM whatsapp_auth WHERE auth=? AND key=?").get(auth, key)?.value;
  }
  authSet(auth: string, entries: [string, string | null][]) {
    const put = this.db.query("INSERT INTO whatsapp_auth(auth,key,value) VALUES(?,?,?) ON CONFLICT(auth,key) DO UPDATE SET value=excluded.value");
    const drop = this.db.query("DELETE FROM whatsapp_auth WHERE auth=? AND key=?");
    this.db.transaction(() => { for (const [key, value] of entries) value === null ? drop.run(auth, key) : put.run(auth, key, value); })();
  }
  authClear(auth: string) { this.db.run("DELETE FROM whatsapp_auth WHERE auth=?", [auth]); }
  /** Pairings no connection names: started and never finished, or replaced. */
  authOrphans(keep: string[]) {
    const all = this.db.query<{ auth: string }, []>("SELECT DISTINCT auth FROM whatsapp_auth").all().map(r => r.auth);
    return all.filter(a => !keep.includes(a));
  }

  upsertChat(connection: string, jid: string, fields: { name?: string; last?: number }) {
    this.db.run(`INSERT INTO whatsapp_chats(connection,jid,name,last) VALUES(?,?,?,?) ON CONFLICT(connection,jid) DO UPDATE SET
      name=coalesce(excluded.name, name), last=max(coalesce(last,0), coalesce(excluded.last,0))`, [connection, jid, fields.name ?? null, fields.last ?? null]);
  }
  upsertContact(connection: string, c: WhatsAppContact) {
    this.db.run(`INSERT INTO whatsapp_contacts(connection,jid,name,notify,phone) VALUES(?,?,?,?,?) ON CONFLICT(connection,jid) DO UPDATE SET
      name=coalesce(excluded.name,name), notify=coalesce(excluded.notify,notify), phone=coalesce(excluded.phone,phone)`, [connection, c.jid, c.name ?? null, c.notify ?? null, c.phone ?? null]);
  }
  addMessages(connection: string, messages: WhatsAppMessage[]) {
    const put = this.db.query(`INSERT INTO whatsapp_messages(connection,chat,id,sender,from_me,at,kind,text,quoted,media,raw) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(connection,chat,id) DO UPDATE SET text=CASE WHEN excluded.text='' OR edited IS NOT NULL THEN text ELSE excluded.text END, media=coalesce(excluded.media,media), raw=coalesce(excluded.raw,raw)`);
    this.db.transaction(() => {
      for (const m of messages) {
        put.run(connection, m.chat, m.id, m.sender ?? null, m.fromMe ? 1 : 0, m.at, m.kind, m.text, m.quoted ?? null, m.media ? JSON.stringify(m.media) : null, m.raw ?? null);
        this.upsertChat(connection, m.chat, { last: m.at });
      }
    })();
  }
  /**
   * An edit keeps the text it replaces (`versions`); a deletion for everyone only marks the message, keeping its
   * text, versions and file. Either changes only a message of its own author: no one rewrites what someone else said.
   */
  editMessage(connection: string, chat: string, id: string, change: { text: string; at: number } | { deleted: number }, by: { fromMe: boolean; sender?: string }) {
    const author = by.fromMe ? "from_me=1" : by.sender ? "from_me=0 AND sender=?" : undefined;
    if (!author) return;
    const args = [connection, chat, id, ...(by.fromMe ? [] : [by.sender!])];
    this.db.transaction(() => {
      const row = this.db.query<{ text: string; edited: number | null; at: number; versions: string | null; deleted: number | null }, any[]>(`SELECT text, edited, at, versions, deleted FROM whatsapp_messages WHERE connection=? AND chat=? AND id=? AND ${author}`).get(...args);
      if (!row || row.deleted) return;
      if ("deleted" in change) {
        this.db.run(`UPDATE whatsapp_messages SET deleted=? WHERE connection=? AND chat=? AND id=? AND ${author}`, [change.deleted, ...args]);
        return;
      }
      if (change.text === row.text) return;
      const versions = [...(row.versions ? JSON.parse(row.versions) as { text: string; until: number }[] : []), { text: row.text, until: change.at }];
      this.db.run(`UPDATE whatsapp_messages SET text=?, edited=?, versions=? WHERE connection=? AND chat=? AND id=? AND ${author}`, [change.text, change.at, JSON.stringify(versions), ...args]);
    })();
  }
  /** WhatsApp told which number a LID is: what was kept under the LID moves to the number. */
  mergeJid(connection: string, from: string, to: string) {
    if (from === to) return;
    this.db.transaction(() => {
      this.db.run("UPDATE OR IGNORE whatsapp_messages SET chat=? WHERE connection=? AND chat=?", [to, connection, from]);
      this.db.run("DELETE FROM whatsapp_messages WHERE connection=? AND chat=?", [connection, from]);
      this.db.run("UPDATE whatsapp_messages SET sender=? WHERE connection=? AND sender=?", [to, connection, from]);
      const chat = this.db.query<{ name: string | null; last: number | null }, [string, string]>("SELECT name, last FROM whatsapp_chats WHERE connection=? AND jid=?").get(connection, from);
      if (chat) { this.upsertChat(connection, to, { ...(chat.name ? { name: chat.name } : {}), ...(chat.last ? { last: chat.last } : {}) }); this.db.run("DELETE FROM whatsapp_chats WHERE connection=? AND jid=?", [connection, from]); }
      const person = this.db.query<{ name: string | null; notify: string | null }, [string, string]>("SELECT name, notify FROM whatsapp_contacts WHERE connection=? AND jid=?").get(connection, from);
      if (person) { this.upsertContact(connection, { jid: to, phone: to, ...(person.name ? { name: person.name } : {}), ...(person.notify ? { notify: person.notify } : {}) }); this.db.run("DELETE FROM whatsapp_contacts WHERE connection=? AND jid=?", [connection, from]); }
    })();
  }
  /** A pairing found to be an account already connected: what it saw joins that account's history. */
  moveConnection(from: string, to: string) {
    this.db.transaction(() => {
      for (const table of ["whatsapp_messages", "whatsapp_chats", "whatsapp_contacts"]) {
        this.db.run(`UPDATE OR IGNORE ${table} SET connection=? WHERE connection=?`, [to, from]);
        this.db.run(`DELETE FROM ${table} WHERE connection=?`, [from]);
      }
    })();
  }
  clear(connection: string) {
    this.db.transaction(() => {
      for (const table of ["whatsapp_messages", "whatsapp_chats", "whatsapp_contacts"]) this.db.run(`DELETE FROM ${table} WHERE connection=?`, [connection]);
    })();
  }

  chats(connection: string, input: { query?: string; limit: number; before?: number }): WhatsAppChatSummary[] {
    const rows = this.db.query<{ jid: string; name: string | null; last: number | null; text: string | null; from_me: number | null; sender_name: string | null }, any[]>(`
      SELECT c.jid, ${NAME("c.jid", "c")} AS name, c.last,
        m.text, m.from_me, ${NAME("m.sender", "m")} AS sender_name
      FROM whatsapp_chats c
      LEFT JOIN whatsapp_messages m ON m.rowid = (SELECT rowid FROM whatsapp_messages WHERE connection=c.connection AND chat=c.jid ORDER BY at DESC LIMIT 1)
      WHERE c.connection=? AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter' AND (? IS NULL OR coalesce(c.last,0) < ?)
      ORDER BY coalesce(c.last,0) DESC LIMIT ?`).all(connection, input.before ?? null, input.before ?? null, input.query ? 5000 : input.limit);
    const query = input.query?.toLocaleLowerCase();
    return rows.filter(r => !query || (r.name ?? "").toLocaleLowerCase().includes(query) || r.jid.includes(query.replace(/\D/g, "") || query))
      .slice(0, input.limit).map(r => ({
        jid: r.jid, name: r.name ?? r.jid.split("@")[0]!, group: r.jid.endsWith("@g.us"),
        ...(r.last ? { last: iso(r.last) } : {}),
        ...(r.text !== null && r.text !== undefined ? { lastText: r.text.slice(0, 160), lastFrom: r.from_me ? "me" : r.sender_name ?? undefined } : {}),
      }));
  }
  private view(r: MessageRow): WhatsAppMessageView {
    return {
      chat: r.chat, chatName: r.chat_name ?? r.chat.split("@")[0]!, id: r.id, fromMe: !!r.from_me,
      from: r.from_me ? "me" : r.sender_name ?? (r.sender ?? r.chat).split("@")[0]!,
      at: iso(r.at), kind: r.kind, text: r.text, ...(r.quoted ? { quoted: r.quoted } : {}), ...(r.media ? { media: JSON.parse(r.media) } : {}),
      ...(r.edited ? { edited: iso(r.edited) } : {}),
      ...(r.versions ? { previous: (JSON.parse(r.versions) as { text: string; until: number }[]).map(v => ({ text: v.text, until: iso(v.until) })) } : {}),
      ...(r.deleted ? { deleted: iso(r.deleted) } : {}),
      ...(r.versions || r.deleted ? { note: note(r) } : {}),
    };
  }
  private select(where: string) {
    return `SELECT m.chat, m.id, m.sender, m.from_me, m.at, m.kind, m.text, m.quoted, m.media, m.edited, m.deleted, m.versions,
      ${NAME("m.chat", "m")} AS chat_name, ${NAME("coalesce(m.sender, m.chat)", "m")} AS sender_name
      FROM whatsapp_messages m WHERE ${where}`;
  }
  /** A chat's messages before `before` (seconds), oldest first. */
  messages(connection: string, chat: string, input: { limit: number; before?: number; after?: number }): WhatsAppMessageView[] {
    return this.db.query<MessageRow, any[]>(`${this.select("m.connection=? AND m.chat=? AND (? IS NULL OR m.at < ?) AND (? IS NULL OR m.at > ?)")} ORDER BY m.at DESC LIMIT ?`)
      .all(connection, chat, input.before ?? null, input.before ?? null, input.after ?? null, input.after ?? null, input.limit).reverse().map(r => this.view(r));
  }
  /** The newest messages of every chat, newest first. */
  recent(connection: string, input: { limit: number; before?: number; after?: number }): WhatsAppMessageView[] {
    return this.db.query<MessageRow, any[]>(`${this.select("m.connection=? AND (? IS NULL OR m.at < ?) AND (? IS NULL OR m.at > ?)")} ORDER BY m.at DESC LIMIT ?`)
      .all(connection, input.before ?? null, input.before ?? null, input.after ?? null, input.after ?? null, input.limit).map(r => this.view(r));
  }
  search(connection: string, input: { query: string; chat?: string; limit: number }): WhatsAppMessageView[] {
    const match = searchTerms(input.query);
    if (!match) return [];
    return this.db.query<MessageRow, any[]>(`${this.select("m.connection=? AND (? IS NULL OR m.chat=?) AND m.rowid IN (SELECT rowid FROM whatsapp_message_search WHERE whatsapp_message_search MATCH ?)")} ORDER BY m.at DESC LIMIT ?`)
      .all(connection, input.chat ?? null, input.chat ?? null, match, input.limit).map(r => this.view(r));
  }
  /** One message, with what a reply, a reaction or a download needs: its sender's JID and, for media, the whole message. */
  message(connection: string, chat: string, id: string): (WhatsAppMessageView & { raw?: string; senderJid?: string }) | undefined {
    const row = this.db.query<MessageRow, any[]>(`${this.select("m.connection=? AND m.chat=? AND m.id=?").replace("m.media,", "m.media, m.raw,")}`).get(connection, chat, id);
    return row ? { ...this.view(row), ...(row.raw ? { raw: row.raw } : {}), ...(row.sender ? { senderJid: row.sender } : {}) } : undefined;
  }
  /** SQLite folds case for ASCII only; names are matched here, in any script. */
  contacts(connection: string, input: { query: string; limit: number }) {
    const q = input.query.toLocaleLowerCase(), digits = input.query.replace(/\D/g, "");
    return this.db.query<{ jid: string; name: string | null; notify: string | null; phone: string | null }, [string]>("SELECT jid, name, notify, phone FROM whatsapp_contacts WHERE connection=? ORDER BY name IS NULL, name, notify").all(connection)
      .filter(r => [r.name, r.notify].some(v => v?.toLocaleLowerCase().includes(q)) || (digits.length >= 3 && [r.jid, r.phone].some(v => v?.split("@")[0]!.includes(digits))))
      .slice(0, input.limit)
      .map(r => ({ jid: r.jid, ...(r.name ? { name: r.name } : {}), ...(r.notify ? { pushName: r.notify } : {}), ...(r.phone ? { phone: r.phone } : {}) }));
  }
  /** What a chat or person is called, for an approval card; undefined when Household has no name for it. */
  name(connection: string, jid: string): string | undefined {
    return this.db.query<{ name: string | null }, [string, string]>(`SELECT ${NAME("?2", "x")} AS name FROM (SELECT ?1 AS connection) x`).get(connection, jid)?.name ?? undefined;
  }
  counts(connection: string) {
    return this.db.query<{ chats: number; messages: number }, [string, string]>("SELECT (SELECT count(*) FROM whatsapp_chats WHERE connection=?) AS chats, (SELECT count(*) FROM whatsapp_messages WHERE connection=?) AS messages").get(connection, connection)!;
  }
}
