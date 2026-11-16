import makeWASocket, {
  Browsers, BufferJSON, DisconnectReason, downloadMediaMessage, getContentType, initAuthCreds, isJidGroup, isLidUser, isPnUser,
  jidNormalizedUser, makeCacheableSignalKeyStore, normalizeMessageContent, proto, toNumber,
  type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap, type WAMessage, type WASocket,
} from "baileys";
import type { WhatsAppContact, WhatsAppKind, WhatsAppMessage, WhatsAppStore } from "./store";

/** A quoted or reacted-to message: what WhatsApp needs to point at one. */
export interface WhatsAppMessageRef { chat: string; id: string; fromMe: boolean; sender?: string; text?: string }
export interface WhatsAppIdentity { jid: string; phone: string; name?: string }
export type WhatsAppStatus = "connecting" | "online" | "offline";
export interface WhatsAppClientEvents {
  qr(qr: string): void;
  open(me: WhatsAppIdentity): void;
  status(status: WhatsAppStatus): void;
  /** WhatsApp ended this linked device (unlinked on the phone, or replaced): its keys are dead. */
  loggedOut(): void;
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
  documentMessage: "document", documentWithCaptionMessage: "document", stickerMessage: "sticker", locationMessage: "location", liveLocationMessage: "location",
  contactMessage: "contact", contactsArrayMessage: "contact", pollCreationMessage: "poll", pollCreationMessageV2: "poll", pollCreationMessageV3: "poll",
};
const MEDIA = new Set<WhatsAppKind>(["image", "video", "audio", "document", "sticker"]);

/** A message as Household keeps it, or what it changes: an edit, a deletion. Reactions and protocol noise are skipped. */
export function convert(m: WAMessage): { message: WhatsAppMessage } | { edit: { chat: string; id: string; text: string } } | undefined {
  const key = m.key as WAMessage["key"] & { remoteJidAlt?: string; participantAlt?: string };
  const chat = pn(key.remoteJid, key.remoteJidAlt);
  if (!chat || !key.id || chat === "status@broadcast" || chat.endsWith("@newsletter")) return;
  const content = normalizeMessageContent(m.message);
  if (!content) return;
  const type = getContentType(content);
  if (!type) return;
  const protocol = content.protocolMessage;
  if (type === "protocolMessage" && protocol?.key?.id) {
    if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) return { edit: { chat, id: protocol.key.id, text: "[deleted]" } };
    if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      const edited = normalizeMessageContent(protocol.editedMessage);
      const text = edited?.conversation ?? edited?.extendedTextMessage?.text ?? edited?.imageMessage?.caption ?? edited?.videoMessage?.caption;
      if (text) return { edit: { chat, id: protocol.key.id, text } };
    }
    return;
  }
  const kind = KINDS[type];
  if (!kind) return;
  const inner: any = type === "documentWithCaptionMessage" ? content.documentWithCaptionMessage?.message?.documentMessage : (content as any)[type];
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
  const fromMe = !!key.fromMe;
  const sender = fromMe ? undefined : isJidGroup(chat) ? pn(key.participant, key.participantAlt) : chat;
  return { message: {
    chat, id: key.id, fromMe, at: toNumber(m.messageTimestamp) || Math.floor(Date.now() / 1000), kind, text,
    ...(sender ? { sender } : {}), ...(inner?.contextInfo?.stanzaId ? { quoted: inner.contextInfo.stanzaId } : {}),
    ...(media ? { media, raw: JSON.stringify(m, BufferJSON.replacer) } : {}),
  } };
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
  let sock: WASocket, ended = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const save = (messages: WAMessage[]) => {
    const fresh: WhatsAppMessage[] = [];
    for (const m of messages) {
      try {
        const result = convert(m);
        if (!result) continue;
        if ("edit" in result) store.editMessage(connection(), result.edit.chat, result.edit.id, result.edit.text);
        else fresh.push(result.message);
      } catch (error) { log?.(`whatsapp: a message was skipped: ${(error as Error).message}`); }
    }
    if (fresh.length) store.addMessages(connection(), fresh);
  };
  const contacts = (list: any[]) => { for (const c of list) { const v = c?.id ? contact(c) : undefined; if (v) store.upsertContact(connection(), v); } };
  const chats = (list: any[]) => {
    for (const c of list) {
      const jid = pn(c?.id, c?.pnJid);
      if (!jid || jid === "status@broadcast") continue;
      const last = toNumber(c.conversationTimestamp ?? c.lastMessageRecvTimestamp) || undefined;
      store.upsertChat(connection(), jid, { ...(c.name ? { name: c.name } : {}), ...(last ? { last } : {}) });
    }
  };
  const connect = () => {
    if (ended) return;
    events.status("connecting");
    sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, logger, browser: Browsers.macOS("Desktop"),
      syncFullHistory: true, markOnlineOnConnect: false, printQRInTerminal: false, getMessage: async () => undefined,
    } as any);
    const current = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messaging-history.set", ({ chats: c, contacts: p, messages }) => { contacts(p ?? []); chats(c ?? []); save(messages ?? []); });
    sock.ev.on("messages.upsert", ({ messages }) => save(messages));
    sock.ev.on("chats.upsert", c => chats(c));
    sock.ev.on("chats.update", c => chats(c as any[]));
    sock.ev.on("contacts.upsert", p => contacts(p));
    sock.ev.on("contacts.update", p => contacts(p as any[]));
    sock.ev.on("connection.update", update => {
      if (current !== sock || ended) return;
      if (update.qr) events.qr(update.qr);
      if (update.connection === "open") {
        failures = 0;
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
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced || code === DisconnectReason.badSession) {
          ended = true; events.status("offline"); events.loggedOut(); return;
        }
        events.status("offline");
        // A new pairing asks for one restart; anything else backs off up to five minutes.
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(300_000, 2_000 * 2 ** Math.min(failures++, 8));
        timer = setTimeout(connect, delay);
      }
    });
  };
  connect();
  const ready = () => { if (ended) throw new Error("This WhatsApp connection is closed"); return sock; };
  const quotedMessage = (q: WhatsAppMessageRef): WAMessage => ({ key: { remoteJid: q.chat, id: q.id, fromMe: q.fromMe, ...(q.sender && isJidGroup(q.chat) ? { participant: q.sender } : {}) }, message: { conversation: q.text ?? "" } });
  const sent = (m: WAMessage | undefined) => { if (!m?.key.id) throw new Error("WhatsApp did not confirm the message"); save([m]); return { id: m.key.id }; };
  return {
    requestPairingCode: phone => ready().requestPairingCode(phone),
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
    download: async raw => {
      const s = ready();
      const message = JSON.parse(raw, BufferJSON.reviver) as WAMessage;
      return new Uint8Array(await downloadMediaMessage(message, "buffer", {}, { logger, reuploadRequest: s.updateMediaMessage }));
    },
    logout: async () => { const s = sock; ended = true; clearTimeout(timer); await s.logout().catch(() => {}); s.end(undefined); },
    end: () => { ended = true; clearTimeout(timer); sock?.end(undefined); },
  };
};
