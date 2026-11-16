import makeWASocket, {
  Browsers, BufferJSON, DisconnectReason, downloadContentFromMessage, getContentType, initAuthCreds, isJidGroup, isLidUser, isPnUser,
  jidNormalizedUser, makeCacheableSignalKeyStore, normalizeMessageContent, proto, toNumber,
  type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap, type WAMessage, type WASocket,
} from "baileys";
import type { WhatsAppAuthor, WhatsAppChange, WhatsAppContact, WhatsAppKind, WhatsAppMessage, WhatsAppStore } from "./store";
export type { WhatsAppAuthor, WhatsAppChange };

/** A quoted or reacted-to message: what WhatsApp needs to point at one. */
export interface WhatsAppMessageRef { chat: string; id: string; fromMe: boolean; sender?: string; text?: string }
export interface WhatsAppIdentity { jid: string; phone: string; name?: string }
export type WhatsAppStatus = "connecting" | "online" | "offline";
export interface WhatsAppClientEvents {
  qr(qr: string): void;
  open(me: WhatsAppIdentity): void;
  status(status: WhatsAppStatus): void;
  /** WhatsApp ended this linked device (unlinked on the phone): its keys are dead. */
  loggedOut(): void;
  /** The pairing code asked for is void (the socket closed before the phone used it): ask again on the next QR. */
  codeExpired?(): void;
}
export interface WhatsAppClientOptions { auth: string; /** The connection what it sees belongs to: known once pairing ends. */ connection: () => string; store: WhatsAppStore; events: WhatsAppClientEvents; log?: (text: string) => void }
/** One linked device of one WhatsApp account, kept connected until `end`. */
export interface WhatsAppClient {
  requestPairingCode(phone: string): Promise<string>;
  sendText(chat: string, text: string, quoted?: WhatsAppMessageRef): Promise<{ id: string }>;
  sendFile(chat: string, file: { bytes: Uint8Array; name: string; mimetype: string }, caption?: string): Promise<{ id: string }>;
  react(chat: string, target: WhatsAppMessageRef, emoji: string): Promise<void>;
  /** The JID WhatsApp knows this number by, if it is on WhatsApp. */
  resolve(phone: string): Promise<string | undefined>;
  download(raw: string): Promise<Uint8Array>;
  logout(): Promise<void>;
  end(): void;
}
export type WhatsAppClientFactory = (options: WhatsAppClientOptions) => WhatsAppClient;

/** Baileys' key store over the Household database: the keys never touch a file. */
function authState(store: WhatsAppStore, auth: string): { state: AuthenticationState; saveCreds: () => void } {
  const read = (key: string) => { const value = store.authGet(auth, key); return value === undefined ? undefined : JSON.parse(value, BufferJSON.reviver); };
  const creds: AuthenticationCreds = read("creds") ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = read(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            if (value !== undefined) data[id] = value;
          }
          return data;
        },
        set: async (data: any) => {
          const entries: [string, string | null][] = [];
          for (const category in data) for (const id in data[category]) {
            const value = data[category][id];
            entries.push([`${category}-${id}`, value ? JSON.stringify(value, BufferJSON.replacer) : null]);
          }
          store.authSet(auth, entries);
        },
      },
    },
    saveCreds: () => store.authSet(auth, [["creds", JSON.stringify(creds, BufferJSON.replacer)]]),
  };
}

const silent = (log?: (text: string) => void): any => {
  const logger: any = { level: "error", child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error: (obj: unknown, msg?: string) => log?.(`whatsapp: ${msg ?? (obj instanceof Error ? obj.message : typeof obj === "object" && obj && "err" in obj ? String((obj as any).err?.message ?? "") : String(obj))}`) };
  return logger;
};

/** The phone-number JID when WhatsApp gave one: chats and people are one entry each, whichever way a message named them. */
const pn = (jid: string | null | undefined, alt?: string | null) => {
  if (!jid) return undefined;
  if (isLidUser(jid) && alt && isPnUser(alt)) return jidNormalizedUser(alt);
  return jidNormalizedUser(jid);
};
const KINDS: Record<string, WhatsAppKind> = {
  conversation: "text", extendedTextMessage: "text", imageMessage: "image", videoMessage: "video", ptvMessage: "video", audioMessage: "audio",
  documentMessage: "document", stickerMessage: "sticker", locationMessage: "location", liveLocationMessage: "location",
  contactMessage: "contact", contactsArrayMessage: "contact", pollCreationMessage: "poll", pollCreationMessageV2: "poll", pollCreationMessageV3: "poll",
};
/** WhatsApp's media host: files come only from there. */
const MEDIA_HOST = "mmg.whatsapp.net";
const FILE_MAX = 64 * 1024 * 1024;
/** Room for the files of deleted messages Household keeps, per connection. */
const KEPT_FILES_MAX = 2 * 1024 * 1024 * 1024;
const MEDIA = new Set<WhatsAppKind>(["image", "video", "audio", "document", "sticker"]);

/** A message as Household keeps it, or what it changes: an edit, a deletion. Reactions and protocol noise are skipped. */
/** Who an edit or deletion comes from: it may change only that author's own message. */
export function convert(m: WAMessage): { message: WhatsAppMessage } | { edit: { chat: string; id: string; change: WhatsAppChange; by: WhatsAppAuthor } } | undefined {
  const key = m.key as WAMessage["key"] & { remoteJidAlt?: string; participantAlt?: string };
  const chat = pn(key.remoteJid, key.remoteJidAlt);
  if (!chat || !key.id || chat === "status@broadcast" || chat.endsWith("@newsletter")) return;
  const content = normalizeMessageContent(m.message);
  if (!content) return;
  const type = getContentType(content);
  if (!type) return;
  const protocol = content.protocolMessage;
  const fromMe = !!key.fromMe;
  const sender = fromMe ? undefined : isJidGroup(chat) ? pn(key.participant, key.participantAlt) : chat;
  if (type === "protocolMessage" && protocol?.key?.id) {
    const by = { fromMe, ...(sender ? { sender } : {}) };
    if (!fromMe && !sender) return;
    if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) return { edit: { chat, id: protocol.key.id, change: { deleted: toNumber(m.messageTimestamp) || Math.floor(Date.now() / 1000) }, by } };
    if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      const edited = normalizeMessageContent(protocol.editedMessage);
      // A caption may be edited to nothing: an empty text is an edit too.
      const text = edited?.conversation ?? edited?.extendedTextMessage?.text ?? edited?.imageMessage?.caption ?? edited?.videoMessage?.caption ?? edited?.documentMessage?.caption;
      if (typeof text === "string") return { edit: { chat, id: protocol.key.id, change: { text, at: toNumber(m.messageTimestamp) || Math.floor(Date.now() / 1000) }, by } };
    }
    return;
  }
  const kind = KINDS[type];
  if (!kind) return;
  const inner: any = (content as any)[type];
  let text = "";
  if (type === "conversation") text = content.conversation ?? "";
  else if (kind === "location") text = [inner?.name, inner?.address, inner?.degreesLatitude !== undefined ? `${inner.degreesLatitude},${inner.degreesLongitude}` : undefined].filter(Boolean).join(" · ");
  else if (kind === "contact") text = inner?.displayName ?? (inner?.contacts ?? []).map((c: any) => c.displayName).join(", ");
  else if (kind === "poll") text = [inner?.name, ...(inner?.options ?? []).map((o: any) => `• ${o.optionName}`)].filter(Boolean).join("\n");
  else text = inner?.text ?? inner?.caption ?? "";
  const media = MEDIA.has(kind) ? {
    ...(inner?.mimetype ? { mimetype: inner.mimetype } : {}), ...(inner?.fileName ? { fileName: inner.fileName } : {}),
    ...(inner?.fileLength ? { size: toNumber(inner.fileLength) } : {}), ...(inner?.seconds ? { seconds: inner.seconds } : {}),
  } : undefined;
  return { message: {
    chat, id: key.id, fromMe, at: toNumber(m.messageTimestamp) || Math.floor(Date.now() / 1000), kind, text,
    ...(sender ? { sender } : {}), ...(inner?.contextInfo?.stanzaId ? { quoted: inner.contextInfo.stanzaId } : {}),
    ...(media ? { media, raw: JSON.stringify(m, BufferJSON.replacer) } : {}),
  } };
}
/**
 * Where a message's file is: its key and its path on WhatsApp's media host. The sender writes the message, so its
 * \`url\` is never used, and a path that could leave the host is refused.
 */
export function mediaSource(message: WAMessage) {
  const content = normalizeMessageContent(message.message), kind = getContentType(content);
  const media = kind ? (content as any)[kind] : undefined;
  if (!media?.mediaKey || typeof media.directPath !== "string" || !/^\/[\w\-./%?=&]+$/.test(media.directPath) || media.directPath.startsWith("//")) throw new Error("This message has no file WhatsApp can serve");
  if (toNumber(media.fileLength) > FILE_MAX) throw new Error("This file is too large");
  return { media: media as { mediaKey: Uint8Array; directPath: string }, type: kind!.replace("Message", "") as any };
}
const contact = (c: { id: string; lid?: string; phoneNumber?: string; name?: string; notify?: string; verifiedName?: string }): WhatsAppContact | undefined => {
  const jid = pn(c.id, c.phoneNumber);
  if (!jid || isJidGroup(jid)) return;
  return { jid, ...(c.name ? { name: c.name } : c.verifiedName ? { name: c.verifiedName } : {}), ...(c.notify ? { notify: c.notify } : {}), ...(c.phoneNumber ? { phone: jidNormalizedUser(c.phoneNumber) } : isPnUser(jid) ? { phone: jid } : {}) };
};

/**
 * Baileys, as one linked device: the keys and what it sees go to the store; it reconnects on its own (backing off)
 * until WhatsApp logs the device out or `end` is called. It never marks the account online, so the phone keeps
 * its notifications.
 */
export const baileysClient: WhatsAppClientFactory = ({ auth, connection, store, events, log }) => {
  const { state, saveCreds } = authState(store, auth);
  const logger = silent(log);
  let sock: WASocket, ended = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined, codeAsked = false, opened = false;
  /** LIDs already folded into their numbers in the store. */
  const folded = new Map<string, string>();
  /** A LID's number, if WhatsApp mapped it; what was kept under the LID moves to the number once. */
  const number = async (jid: string | undefined) => {
    if (!jid || !isLidUser(jid)) return jid;
    if (folded.has(jid)) return folded.get(jid)!;
    const found = await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
    if (!found) return jid;
    const pnJid = jidNormalizedUser(found);
    folded.set(jid, pnJid);
    store.mergeJid(connection(), jid, pnJid);
    return pnJid;
  };
  let queue = Promise.resolve();
  const later = (work: () => Promise<void> | void) => {
    queue = queue.then(async () => { if (!ended) await work(); }).catch(error => log?.(`whatsapp: ${(error as Error).message}`));
    return queue;
  };
  let fetching = 0;
  /**
   * A deleted message's file, fetched while WhatsApp may still have it: outside the save queue (a slow download
   * never holds messages back), two at a time, within the store's room for kept files.
   */
  const keepFile = (chat: string, id: string, raw: string) => {
    if (ended || fetching >= 2 || store.fileBytes(connection()) > KEPT_FILES_MAX) { log?.("whatsapp: a deleted message's file was not kept (busy or out of room)"); return; }
    fetching++;
    const owner = connection();
    void download(raw).then(bytes => { if (!ended && owner === connection()) store.saveFile(owner, chat, id, bytes); })
      .catch(error => log?.(`whatsapp: a deleted message's file could not be kept: ${(error as Error).message}`))
      .finally(() => { fetching--; });
  };
  /**
   * A message's file, only from WhatsApp's own media host (never a URL the sender put in the message), within a
   * size cap and a time limit; WhatsApp is asked once to upload it again when its copy expired.
   */
  const download = async (raw: string, reuploaded = false): Promise<Uint8Array> => {
    const message = JSON.parse(raw, BufferJSON.reviver) as WAMessage;
    const { media, type } = mediaSource(message);
    try {
      const stream = await downloadContentFromMessage({ mediaKey: media.mediaKey, directPath: media.directPath, url: undefined as unknown as string }, type,
        { host: MEDIA_HOST, options: { signal: AbortSignal.timeout(120_000) } as RequestInit });
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > FILE_MAX) { (stream as any).destroy?.(); throw new Error("This file is too large"); }
        chunks.push(chunk);
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) {
      const status = (error as any)?.status ?? (error as any)?.output?.statusCode;
      if (reuploaded || ![404, 410].includes(status)) throw error;
      const fresh = await sock.updateMediaMessage(message);
      return download(JSON.stringify(fresh, BufferJSON.replacer), true);
    }
  };
  /**
   * Messages as WhatsApp delivered them, converted at once (before Baileys' event buffer can fold an edit or a
   * deletion into its original), then saved strictly in order: an edit always finds the message before it.
   */
  const save = (messages: WAMessage[]) => {
    if (ended) return queue;
    const converted: ReturnType<typeof convert>[] = [];
    for (const m of messages) {
      try { converted.push(convert(m)); } catch (error) { log?.(`whatsapp: a message was skipped: ${(error as Error).message}`); }
    }
    return later(async () => {
      for (const item of converted) {
        if (!item) continue;
        if ("edit" in item) {
          const e = item.edit, chat = (await number(e.chat))!, sender = await number(e.by.sender);
          if (ended) return;
          const { fetch } = store.editMessage(connection(), chat, e.id, e.change, { fromMe: e.by.fromMe, ...(sender ? { sender } : {}) });
          if (fetch) keepFile(chat, e.id, fetch);
        } else {
          const m = item.message, chat = (await number(m.chat))!, sender = await number(m.sender);
          if (ended) return;
          for (const f of store.addMessages(connection(), [{ ...m, chat, ...(sender ? { sender } : {}) }])) keepFile(f.chat, f.id, f.fetch);
        }
      }
    });
  };
  const contacts = (list: any[]) => later(async () => {
    for (const c of list) { const v = c?.id ? contact(c) : undefined; if (v) store.upsertContact(connection(), { ...v, jid: (await number(v.jid))! }); }
  });
  const chats = (list: any[]) => later(async () => {
    for (const c of list) {
      const jid = await number(pn(c?.id, c?.pnJid));
      if (!jid || jid === "status@broadcast") continue;
      const last = toNumber(c.conversationTimestamp ?? c.lastMessageRecvTimestamp) || undefined;
      store.upsertChat(connection(), jid, { ...(c.name ? { name: c.name } : {}), ...(last ? { last } : {}) });
    }
  });
  const connect = () => {
    if (ended) return;
    events.status("connecting");
    sock = makeWASocket({
      // Desktop + full history advertises WEB/DARWIN, which WhatsApp closes with 428 before issuing a QR.
      // Chrome advertises WEB_BROWSER and keeps full-history sync without the rejected desktop identity.
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger, browser: Browsers.macOS("Chrome"),
      syncFullHistory: true, markOnlineOnConnect: false, printQRInTerminal: false, getMessage: async () => undefined,
    } as any);
    const current = sock;
    sock.ev.on("creds.update", saveCreds);
    // Messages and history are taken as they are emitted, not from the buffered events Baileys hands listeners
    // after a reconnect: those have edits and deletions already folded into their originals, losing the original.
    const emit = sock.ev.emit.bind(sock.ev);
    (sock.ev as any).emit = (event: string, data: any) => {
      if (current === sock && !ended) {
        if (event === "messages.upsert") void save(data?.messages ?? []);
        if (event === "messaging-history.set") { void contacts(data?.contacts ?? []); void chats(data?.chats ?? []); void save(data?.messages ?? []); }
      }
      return emit(event as any, data);
    };
    sock.ev.on("chats.upsert", c => void chats(c));
    sock.ev.on("chats.update", c => void chats(c as any[]));
    sock.ev.on("contacts.upsert", p => void contacts(p));
    sock.ev.on("contacts.update", p => void contacts(p as any[]));
    sock.ev.on("lid-mapping.update", ({ lid, pn: mapped }) => {
      if (lid && mapped) void later(() => { const from = jidNormalizedUser(lid), to = jidNormalizedUser(mapped); folded.set(from, to); store.mergeJid(connection(), from, to); });
    });
    sock.ev.on("connection.update", update => {
      if (current !== sock || ended) return;
      if (update.qr) events.qr(update.qr);
      if (update.connection === "open") {
        failures = 0; opened = true;
        const me = state.creds.me;
        if (me?.id) {
          const jid = jidNormalizedUser(me.id);
          events.open({ jid, phone: jid.split("@")[0]!, ...(me.name ? { name: me.name } : {}) });
        }
        events.status("online");
        void sock.groupFetchAllParticipating().then(groups => {
          for (const g of Object.values(groups)) if (g.subject) store.upsertChat(connection(), g.id, { name: g.subject });
        }).catch(() => {});
      }
      if (update.connection === "close") {
        const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
        // Only WhatsApp saying so ends the device; everything else (a conflict, a stream error) keeps the keys and retries.
        if (code === DisconnectReason.loggedOut) { ended = true; events.status("offline"); events.loggedOut(); return; }
        if (code === DisconnectReason.connectionReplaced) log?.("whatsapp: another session took over this linked device (a restored backup still running?); retrying later");
        events.status("offline");
        // A pairing code binds the socket it was asked on: once that closes, the next one has to register afresh.
        if (codeAsked && !opened && code !== DisconnectReason.restartRequired) {
          codeAsked = false;
          delete (state.creds as Partial<AuthenticationCreds>).me;
          events.codeExpired?.();
        }
        // A new pairing asks for one restart; anything else backs off up to five minutes.
        const delay = code === DisconnectReason.restartRequired ? 0 : code === DisconnectReason.connectionReplaced ? 300_000 : Math.min(300_000, 2_000 * 2 ** Math.min(failures++, 8));
        timer = setTimeout(connect, delay);
      }
    });
  };
  connect();
  const ready = () => { if (ended) throw new Error("This WhatsApp connection is closed"); return sock; };
  const quotedMessage = (q: WhatsAppMessageRef): WAMessage => ({ key: { remoteJid: q.chat, id: q.id, fromMe: q.fromMe, ...(q.sender && isJidGroup(q.chat) ? { participant: q.sender } : {}) }, message: { conversation: q.text ?? "" } });
  const sent = (m: WAMessage | undefined) => { if (!m?.key.id) throw new Error("WhatsApp did not confirm the message"); void save([m]); return { id: m.key.id }; };
  return {
    requestPairingCode: phone => { codeAsked = true; return ready().requestPairingCode(phone); },
    sendText: async (chat, text, quoted) => sent(await ready().sendMessage(chat, { text }, quoted ? { quoted: quotedMessage(quoted) } : undefined)),
    sendFile: async (chat, file, caption) => {
      const kind = file.mimetype.startsWith("image/") && !file.mimetype.includes("svg") ? "image" : file.mimetype.startsWith("video/") ? "video" : file.mimetype.startsWith("audio/") ? "audio" : "document";
      const buffer = Buffer.from(file.bytes);
      const content: any = kind === "image" ? { image: buffer, caption } : kind === "video" ? { video: buffer, caption } : kind === "audio" ? { audio: buffer, mimetype: file.mimetype }
        : { document: buffer, mimetype: file.mimetype, fileName: file.name, caption };
      return sent(await ready().sendMessage(chat, content));
    },
    react: async (chat, target, emoji) => { await ready().sendMessage(chat, { react: { text: emoji, key: quotedMessage(target).key } }); },
    resolve: async phone => {
      const [found] = (await ready().onWhatsApp(phone)) ?? [];
      return found?.exists ? jidNormalizedUser(found.jid) : undefined;
    },
    download: async raw => { ready(); return download(raw); },
    logout: async () => { const s = sock; ended = true; clearTimeout(timer); await s.logout().catch(() => {}); s.end(undefined); },
    end: () => { ended = true; clearTimeout(timer); sock?.end(undefined); },
  };
};
