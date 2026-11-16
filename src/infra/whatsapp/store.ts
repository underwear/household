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
export interface WhatsAppChatSummary { jid: string; name: string; group: boolean; last?: string; lastText?: string; lastFrom?: string; lastKind?: WhatsAppKind; lastEdited?: true; lastDeleted?: true }
/** A text the message had before an edit, and until when; null when Household never saw that version. */
export interface WhatsAppVersion { text: string | null; until: string }
export interface WhatsAppMessageView {
  chat: string; chatName: string; id: string; from: string; fromMe: boolean; at: string; kind: WhatsAppKind; text: string; quoted?: string; media?: WhatsAppMedia;
  /** When it was last edited; \`previous\` holds its earlier texts, oldest first. */
  edited?: string; previous?: WhatsAppVersion[];
  /** When it was deleted for everyone; Household keeps what it had, as the owner chose. */
  deleted?: string;
  /** Who deleted it, when not its author (a group admin). */
  deletedBy?: string;
  /** Household heard of an edit or deletion of this message but has not seen the message itself. */
  unseen?: true;
  /** In words, for a reader: what happened to the message. */
  note?: string;
}
/** Who sent an edit or a deletion. */
export interface WhatsAppAuthor { fromMe: boolean; sender?: string }
export type WhatsAppChange = { text: string; at: number } | { deleted: number };

interface MessageRow { chat: string; id: string; sender: string | null; from_me: number; at: number; kind: WhatsAppKind; text: string; quoted: string | null; media: string | null; raw?: string | null; chat_name: string | null; sender_name: string | null; edited: number | null; deleted: number | null; deleted_by: string | null; deleted_by_name?: string | null; versions: string | null; placeholder: number | null; kept_file: number }
interface Stored { text: string; sender: string | null; from_me: number; edited: number | null; deleted: number | null; deleted_by: string | null; versions: string | null; placeholder: number | null; raw: string | null; kind: WhatsAppKind }
type Version = { text: string | null; until: number };
const MEDIA_KINDS = new Set<WhatsAppKind>(["image", "video", "audio", "document", "sticker"]);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const versionsOf = (value: string | null): Version[] => value ? JSON.parse(value) : [];
/** What happened to a message, in words, so a reader (a bot) can't mistake its last text for what was first said, or miss that it was withdrawn. */
function note(r: MessageRow) {
  const parts: string[] = [];
  const versions = versionsOf(r.versions);
  if (r.placeholder) parts.push("Household has not seen this message itself, only what happened to it: text and from may be empty or unknown");
  if (versions.length) parts.push(`Edited ${versions.length === 1 ? "once" : `${versions.length} times`} by its author: text is the last version, previous the earlier ones, oldest first${versions[0]?.text === null ? " (the original text was not seen by Household: null)" : ""}`);
  if (r.deleted) {
    const by = r.deleted_by ? `by ${r.deleted_by === "me" ? "the owner" : r.deleted_by_name ?? r.deleted_by.split("@")[0]}, not its author (WhatsApp lets group admins do that; Household can't confirm the deleter is one),` : r.placeholder ? "" : "by its author";
    const kept = r.placeholder ? "Household never had its content" : MEDIA_KINDS.has(r.kind) ? (r.kept_file ? "Household kept its text and file" : "Household kept its text; its file was not saved and may be gone from WhatsApp") : "Household kept its text";
    parts.push(`${parts.length ? "then d" : "D"}eleted for everyone ${by} at ${iso(r.deleted)}: people in the chat no longer see it; ${kept}`.replace("  ", " "));
  }
  return `${parts.join("; ")}.`;
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
  private stored(connection: string, chat: string, id: string) {
    return this.db.query<Stored, [string, string, string]>("SELECT text, sender, from_me, edited, deleted, deleted_by, versions, placeholder, raw, kind FROM whatsapp_messages WHERE connection=? AND chat=? AND id=?").get(connection, chat, id);
  }
  /**
   * New messages, and messages seen again (a history sync, a redelivery). One seen again never loses what Household
   * knows: a text it did not have yet becomes the latest version (an edit Household missed), never a silent overwrite;
   * an earlier version arriving again changes nothing. A placeholder (an edit or deletion heard of first) gets its
   * message: the original text, its time and file, and edits only if their sender was the message's author.
   */
  addMessages(connection: string, messages: WhatsAppMessage[]): { chat: string; id: string; fetch: string }[] {
    const fetches: { chat: string; id: string; fetch: string }[] = [];
    const insert = this.db.query(`INSERT INTO whatsapp_messages(connection,chat,id,sender,from_me,at,kind,text,quoted,media,raw) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    this.db.transaction(() => {
      for (const m of messages) {
        const row = this.stored(connection, m.chat, m.id), media = m.media ? JSON.stringify(m.media) : null;
        if (!row) insert.run(connection, m.chat, m.id, m.sender ?? null, m.fromMe ? 1 : 0, m.at, m.kind, m.text, m.quoted ?? null, media, m.raw ?? null);
        else if (row.placeholder) {
          const author = !!row.from_me === m.fromMe && (m.fromMe || row.sender === (m.sender ?? null));
          let versions = versionsOf(row.versions), text = m.text, edited = row.edited;
          if (versions.length && author) { versions = versions.map((v, i) => i === 0 && v.text === null ? { ...v, text: m.text } : v); text = row.text; }
          else { versions = []; edited = null; }
          // A deletion by the author needs no «by»; one by someone else stays marked (outside groups, it is dropped).
          const deleter = row.deleted_by, isAuthor = deleter === (m.fromMe ? "me" : m.sender);
          const deleted = row.deleted && (isAuthor || m.chat.endsWith("@g.us")) ? row.deleted : null;
          const by = deleted && !isAuthor ? deleter : null;
          if (deleted && m.raw) fetches.push({ chat: m.chat, id: m.id, fetch: m.raw });
          this.db.run(`UPDATE whatsapp_messages SET sender=?, from_me=?, at=?, kind=?, text=?, quoted=?, media=?, raw=?, edited=?, versions=?, deleted=?, deleted_by=?, placeholder=NULL WHERE connection=? AND chat=? AND id=?`,
            [m.sender ?? null, m.fromMe ? 1 : 0, m.at, m.kind, text, m.quoted ?? null, media, m.raw ?? null, edited, versions.length ? JSON.stringify(versions) : null, deleted, by, connection, m.chat, m.id]);
        } else {
          const versions = versionsOf(row.versions);
          if (m.text && m.text !== row.text && !versions.some(v => v.text === m.text)) {
            const now = Math.max(m.at, Math.floor(Date.now() / 1000));
            this.db.run("UPDATE whatsapp_messages SET text=?, edited=?, versions=? WHERE connection=? AND chat=? AND id=?", [m.text, now, JSON.stringify([...versions, { text: row.text, until: now }]), connection, m.chat, m.id]);
          }
          if (media || m.raw) this.db.run("UPDATE whatsapp_messages SET media=coalesce(?,media), raw=coalesce(?,raw) WHERE connection=? AND chat=? AND id=?", [media, m.raw ?? null, connection, m.chat, m.id]);
        }
        this.upsertChat(connection, m.chat, { last: m.at });
      }
    })();
    return fetches;
  }
  /**
   * An edit keeps every text it replaces (\`versions\`), and only the message's author can edit it. A deletion for
   * everyone only marks the message, keeping text, versions and file; in a group an admin may delete someone else's
   * message, which is marked with who did. A change heard of before its message is kept as a placeholder the message
   * fills in later. A change seen again (a replay) changes nothing. Returns the message's media (raw) when a deletion
   * just hit one whose file Household has not saved, so it can be fetched while WhatsApp still has it.
   */
  editMessage(connection: string, chat: string, id: string, change: WhatsAppChange, by: WhatsAppAuthor): { fetch?: string } {
    const who = by.fromMe ? "me" : by.sender;
    if (!who) return {};
    return this.db.transaction(() => {
      const row = this.stored(connection, chat, id);
      if ("deleted" in change) {
        if (!row) {
          // Its author is not known yet: the deleter is kept, and compared when the message comes.
          this.db.run(`INSERT INTO whatsapp_messages(connection,chat,id,sender,from_me,at,kind,text,deleted,deleted_by,placeholder) VALUES(?,?,?,NULL,0,?,'other','',?,?,1)`,
            [connection, chat, id, change.deleted, change.deleted, who]);
          this.upsertChat(connection, chat, { last: change.deleted });
          return {};
        }
        if (row.deleted) return {};
        const author = by.fromMe ? !!row.from_me : !row.from_me && row.sender === by.sender;
        if (!author && !chat.endsWith("@g.us")) return {};
        this.db.run("UPDATE whatsapp_messages SET deleted=?, deleted_by=? WHERE connection=? AND chat=? AND id=?", [change.deleted, author ? null : who, connection, chat, id]);
        const saved = this.db.query<{ n: number }, [string, string, string]>("SELECT count(*) AS n FROM whatsapp_files WHERE connection=? AND chat=? AND id=?").get(connection, chat, id)!.n;
        return row.raw && !saved ? { fetch: row.raw } : {};
      }
      if (!row) {
        this.db.run(`INSERT INTO whatsapp_messages(connection,chat,id,sender,from_me,at,kind,text,edited,versions,placeholder) VALUES(?,?,?,?,?,?,'text',?,?,?,1)`,
          [connection, chat, id, by.sender ?? null, by.fromMe ? 1 : 0, change.at, change.text, change.at, JSON.stringify([{ text: null, until: change.at }])]);
        this.upsertChat(connection, chat, { last: change.at });
        return {};
      }
      const author = by.fromMe ? !!row.from_me : !row.from_me && row.sender === by.sender;
      // WhatsApp edits nothing after a deletion; an edit made before it may still arrive late.
      if (!author || (row.deleted && change.at >= row.deleted)) return {};
      const versions = versionsOf(row.versions);
      if (change.text === row.text || versions.some(v => v.text === change.text)) return {};
      if (row.edited && change.at < row.edited) {
        // An edit arriving after a later one: it goes where it happened. The version it replaced lasted until
        // this edit; its own text lasted until the next one.
        const i = versions.findIndex(v => v.until > change.at);
        if (i < 0) return {};
        const next = [...versions.slice(0, i), { text: versions[i]!.text, until: change.at }, { text: change.text, until: versions[i]!.until }, ...versions.slice(i + 1)];
        this.db.run("UPDATE whatsapp_messages SET versions=? WHERE connection=? AND chat=? AND id=?", [JSON.stringify(next), connection, chat, id]);
        return {};
      }
      this.db.run("UPDATE whatsapp_messages SET text=?, edited=?, versions=? WHERE connection=? AND chat=? AND id=?", [change.text, change.at, JSON.stringify([...versions, { text: row.text, until: change.at }]), connection, chat, id]);
      return {};
    })();
  }
  /** A file kept in Household itself: a deleted message's, saved before WhatsApp lets it go. */
  saveFile(connection: string, chat: string, id: string, bytes: Uint8Array) {
    this.db.run("INSERT OR REPLACE INTO whatsapp_files(connection,chat,id,bytes) VALUES(?,?,?,?)", [connection, chat, id, bytes]);
  }
  fileBytes(connection: string) {
    return this.db.query<{ n: number | null }, [string]>("SELECT sum(length(bytes)) AS n FROM whatsapp_files WHERE connection=?").get(connection)?.n ?? 0;
  }
  file(connection: string, chat: string, id: string): Uint8Array | undefined {
    const row = this.db.query<{ bytes: Uint8Array }, [string, string, string]>("SELECT bytes FROM whatsapp_files WHERE connection=? AND chat=? AND id=?").get(connection, chat, id);
    return row ? new Uint8Array(row.bytes) : undefined;
  }
  /** WhatsApp told which number a LID is: what was kept under the LID moves to the number. */
  mergeJid(connection: string, from: string, to: string) {
    if (from === to) return;
    this.db.transaction(() => {
      this.db.run("UPDATE OR IGNORE whatsapp_messages SET chat=? WHERE connection=? AND chat=?", [to, connection, from]);
      this.db.run("DELETE FROM whatsapp_messages WHERE connection=? AND chat=?", [connection, from]);
      this.db.run("UPDATE whatsapp_messages SET sender=? WHERE connection=? AND sender=?", [to, connection, from]);
      this.db.run("UPDATE whatsapp_messages SET deleted_by=? WHERE connection=? AND deleted_by=?", [to, connection, from]);
      this.db.run("UPDATE OR IGNORE whatsapp_files SET chat=? WHERE connection=? AND chat=?", [to, connection, from]);
      this.db.run("DELETE FROM whatsapp_files WHERE connection=? AND chat=?", [connection, from]);
      const chat = this.db.query<{ name: string | null; last: number | null }, [string, string]>("SELECT name, last FROM whatsapp_chats WHERE connection=? AND jid=?").get(connection, from);
      if (chat) { this.upsertChat(connection, to, { ...(chat.name ? { name: chat.name } : {}), ...(chat.last ? { last: chat.last } : {}) }); this.db.run("DELETE FROM whatsapp_chats WHERE connection=? AND jid=?", [connection, from]); }
      const person = this.db.query<{ name: string | null; notify: string | null }, [string, string]>("SELECT name, notify FROM whatsapp_contacts WHERE connection=? AND jid=?").get(connection, from);
      if (person) { this.upsertContact(connection, { jid: to, phone: to, ...(person.name ? { name: person.name } : {}), ...(person.notify ? { notify: person.notify } : {}) }); this.db.run("DELETE FROM whatsapp_contacts WHERE connection=? AND jid=?", [connection, from]); }
    })();
  }
  /** A pairing found to be an account already connected: what it saw joins that account's history. */
  moveConnection(from: string, to: string) {
    this.db.transaction(() => {
      for (const table of ["whatsapp_messages", "whatsapp_chats", "whatsapp_contacts", "whatsapp_files"]) {
        this.db.run(`UPDATE OR IGNORE ${table} SET connection=? WHERE connection=?`, [to, from]);
        this.db.run(`DELETE FROM ${table} WHERE connection=?`, [from]);
      }
    })();
  }
  clear(connection: string) {
    this.db.transaction(() => {
      for (const table of ["whatsapp_messages", "whatsapp_chats", "whatsapp_contacts", "whatsapp_files"]) this.db.run(`DELETE FROM ${table} WHERE connection=?`, [connection]);
    })();
  }

  chats(connection: string, input: { query?: string; limit: number; before?: number }): WhatsAppChatSummary[] {
    const rows = this.db.query<{ jid: string; name: string | null; last: number | null; text: string | null; from_me: number | null; sender_name: string | null; sender: string | null; kind: WhatsAppKind | null; edited: number | null; deleted: number | null }, any[]>(`
      SELECT c.jid, ${NAME("c.jid", "c")} AS name, c.last,
        m.text, m.from_me, m.sender, m.kind, m.edited, m.deleted, ${NAME("m.sender", "m")} AS sender_name
      FROM whatsapp_chats c
      LEFT JOIN whatsapp_messages m ON m.rowid = (SELECT rowid FROM whatsapp_messages WHERE connection=c.connection AND chat=c.jid ORDER BY at DESC LIMIT 1)
      WHERE c.connection=? AND c.jid NOT LIKE '%@broadcast' AND c.jid NOT LIKE '%@newsletter' AND (? IS NULL OR coalesce(c.last,0) < ?)
      ORDER BY coalesce(c.last,0) DESC LIMIT ?`).all(connection, input.before ?? null, input.before ?? null, input.query ? 5000 : input.limit);
    const query = input.query?.toLocaleLowerCase();
    return rows.filter(r => !query || (r.name ?? "").toLocaleLowerCase().includes(query) || r.jid.includes(query.replace(/\D/g, "") || query))
      .slice(0, input.limit).map(r => ({
        jid: r.jid, name: r.name ?? r.jid.split("@")[0]!, group: r.jid.endsWith("@g.us"),
        ...(r.last ? { last: iso(r.last) } : {}),
        ...(r.text !== null && r.text !== undefined ? {
          lastText: r.text.slice(0, 160), lastFrom: r.from_me ? "me" : r.sender_name ?? r.sender?.split("@")[0], ...(r.kind && r.kind !== "text" ? { lastKind: r.kind } : {}),
          ...(r.edited ? { lastEdited: true as const } : {}), ...(r.deleted ? { lastDeleted: true as const } : {}),
        } : {}),
      }));
  }
  private view(r: MessageRow): WhatsAppMessageView {
    return {
      chat: r.chat, chatName: r.chat_name ?? r.chat.split("@")[0]!, id: r.id, fromMe: !!r.from_me,
      from: r.from_me ? "me" : r.sender_name ?? (r.sender ?? r.chat).split("@")[0]!,
      at: iso(r.at), kind: r.kind, text: r.text, ...(r.quoted ? { quoted: r.quoted } : {}), ...(r.media ? { media: JSON.parse(r.media) } : {}),
      ...(r.edited ? { edited: iso(r.edited) } : {}),
      ...(r.versions ? { previous: versionsOf(r.versions).map(v => ({ text: v.text, until: iso(v.until) })) } : {}),
      ...(r.deleted ? { deleted: iso(r.deleted) } : {}),
      ...(r.deleted_by ? { deletedBy: r.deleted_by === "me" ? "me" : r.deleted_by_name ?? r.deleted_by.split("@")[0]! } : {}),
      ...(r.placeholder ? { unseen: true as const } : {}),
      ...(r.versions || r.deleted || r.placeholder ? { note: note(r) } : {}),
    };
  }
  private select(where: string) {
    return `SELECT m.chat, m.id, m.sender, m.from_me, m.at, m.kind, m.text, m.quoted, m.media, m.edited, m.deleted, m.deleted_by, m.versions, m.placeholder,
      ${NAME("m.chat", "m")} AS chat_name, ${NAME("coalesce(m.sender, m.chat)", "m")} AS sender_name, ${NAME("m.deleted_by", "m")} AS deleted_by_name,
      EXISTS(SELECT 1 FROM whatsapp_files f WHERE f.connection=m.connection AND f.chat=m.chat AND f.id=m.id) AS kept_file
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
