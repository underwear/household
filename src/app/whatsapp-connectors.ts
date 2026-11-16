import { createHash, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { connectorCallers, type ConnectorWritePolicy } from "../core/connector-write-policy";
import type { House } from "../core/household";
import { HouseholdError } from "../core/errors";
import { inboxFileName } from "../core/attachment";
import { whatsappAccessSchema, whatsappConnectSchema, type WhatsAppConnectionView, type WhatsAppLink, type WhatsAppPairingView, type WhatsAppPollView } from "../core/whatsapp-connectors";
import type { PetIdentity } from "../infra/agent-api";
import type { KeyValueStore } from "../infra/sqlite-store";
import { baileysClient, type WhatsAppClient, type WhatsAppClientFactory, type WhatsAppIdentity, type WhatsAppMessageRef } from "../infra/whatsapp/client";
import { phoneDigits, whatsappCatalog, whatsappOperation } from "../infra/whatsapp/operations";
import type { WhatsAppStore } from "../infra/whatsapp/store";
import type { ConnectorWrites } from "./connector-writes";
import { TokenBucket } from "./token-bucket";

export interface WhatsAppConnectorFiles {
  read(caller: PetIdentity, path: string, maxBytes: number): Promise<Uint8Array>;
  save(caller: PetIdentity, name: string, bytes: Uint8Array): Promise<string>;
}
const KEY = "house.connectors.whatsapp.v1";
/** WhatsApp's own cap for documents is 2 GB; a bot's file goes through memory, so less. */
const FILE_MAX = 64 * 1024 * 1024;
const PAIRING_MS = 300_000;
interface Connection {
  id: string; house: string; name?: string; phone: string; jid: string; account?: string;
  /** The pairing whose keys this connection runs on. */
  auth: string;
  writePolicy: ConnectorWritePolicy; pets: string[]; connectedAt: string; needsReconnect: boolean;
}
/** A linked device, running: a live connection's, or one being paired. */
interface Link { auth: string; connection: string; client: WhatsAppClient; status: WhatsAppLink }
interface Pairing {
  house: string; binding: string; name?: string; pets: string[]; writePolicy: ConnectorWritePolicy;
  /** The connection paired again, if any. */
  target?: string; phone?: string; link: Link; expires: number; timer: ReturnType<typeof setTimeout>;
  qr?: string; code?: string; codeAsked?: boolean; connected?: string; error?: string;
}

/**
 * The owner's WhatsApp accounts, each a linked device Household keeps connected on this host. Keys and history stay
 * in Household's database; bots reach them only through the fixed operations, as their grant and access allow.
 */
export class WhatsAppConnectors {
  private houses: House[] = [];
  private links = new Map<string, Link>();
  private pairings = new Map<string, Pairing>();
  private active = new Map<string, AbortController>();
  private budgets = new Map<string, TokenBucket>();
  private started = false;
  private stopped = false;
  constructor(private store: KeyValueStore, private data: WhatsAppStore, private files?: WhatsAppConnectorFiles, private writes?: ConnectorWrites, private factory: WhatsAppClientFactory = baileysClient, private now = Date.now, private log?: (text: string) => void) {}

  private read(): Connection[] { return JSON.parse(this.store.get(KEY) ?? "[]"); }
  private write(items: Connection[]) { this.store.set(KEY, JSON.stringify(items)); }
  private view(c: Connection): WhatsAppConnectionView {
    const link = this.links.get(c.id);
    return {
      id: c.id, name: c.name ?? c.account ?? `+${c.phone}`, phone: `+${c.phone}`, ...(c.account ? { account: c.account } : {}),
      writePolicy: c.writePolicy, pets: [...c.pets], connectedAt: c.connectedAt, needsReconnect: c.needsReconnect,
      link: c.needsReconnect ? "offline" : link?.status ?? "offline", ...this.data.counts(c.id),
    };
  }
  private house(name: string) { const h = this.houses.find(h => h.name === name); if (!h) throw new HouseholdError("Workspace not found"); return h; }
  private pets(house: string, names: string[]) {
    const configured = this.house(house).pets;
    if (names.some(name => !configured.some(p => p.name === name && !p.scout && !p.sideworker))) throw new HouseholdError("Select configured bots from this workspace");
    return [...new Set(names)];
  }

  /** Starts the saved connections on the first call; later, cuts off bots and workspaces that are gone. */
  setHouses(houses: House[]) {
    const beforeCallers = new Map(this.read().map(c => [c.id, connectorCallers(this.houses, c.house, c.pets)]));
    this.houses = structuredClone(houses);
    const saved = this.read(), kept = saved.filter(c => houses.some(h => h.name === c.house));
    // A workspace removed takes its accounts along: unlinked from the phone, keys and kept chats deleted.
    for (const c of saved) if (!kept.includes(c)) { this.abort(c.id); void this.forget(c); }
    for (const c of kept) {
      const pets = c.pets.filter(name => houses.find(h => h.name === c.house)?.pets.some(p => p.name === name && !p.scout && !p.sideworker));
      if (pets.length !== c.pets.length) this.abort(c.id);
      c.pets = pets;
      const after = connectorCallers(houses, c.house, c.pets);
      if (beforeCallers.get(c.id)?.some(name => !after.includes(name))) this.abort(c.id);
    }
    this.write(kept);
    for (const [id, p] of this.pairings) if (!houses.some(h => h.name === p.house)) this.drop(id);
    if (!this.started && !this.stopped) {
      this.started = true;
      for (const auth of this.data.authOrphans(kept.map(c => c.auth))) this.data.authClear(auth);
    }
    for (const c of kept) if (!c.needsReconnect && !this.links.has(c.id) && !this.stopped) this.startLink(c);
  }
  private startLink(c: Connection) {
    const link: Link = { auth: c.auth, connection: c.id, status: "connecting", client: undefined as unknown as WhatsAppClient };
    this.links.set(c.id, link);
    const events = this.liveEvents(link);
    link.client = this.factory({ auth: c.auth, connection: () => link.connection, store: this.data, log: this.log, events });
  }
  /** What a connected device's events do: a live device asking to be paired, or unlinked, has lost its keys. */
  private liveEvents(link: Link) {
    return {
      qr: () => { if (this.links.get(link.connection) === link) this.loggedOut(link.connection, link); },
      open: (me: WhatsAppIdentity) => this.update(link.connection, item => { if (item.auth === link.auth && me.name) item.account = me.name; }),
      status: (status: WhatsAppLink) => { link.status = status; },
      loggedOut: () => this.loggedOut(link.connection, link),
    };
  }
  private loggedOut(id: string, link: Link) {
    link.client.end();
    if (this.links.get(id) === link) this.links.delete(id);
    this.update(id, item => { if (item.auth === link.auth) { item.needsReconnect = true; this.data.authClear(item.auth); } });
    this.abort(id);
    this.log?.(`whatsapp: a connection was unlinked by WhatsApp and needs pairing again`);
  }
  private async forget(c: Connection) {
    const link = this.links.get(c.id);
    this.links.delete(c.id);
    if (link) await Promise.race([link.client.logout(), new Promise(resolve => setTimeout(resolve, 5_000))]).catch(() => {});
    link?.client.end();
    this.data.authClear(c.auth); this.data.clear(c.id);
  }
  private stopLink(id: string) { this.links.get(id)?.client.end(); this.links.delete(id); }
  private update(id: string, change: (c: Connection) => void) {
    const items = this.read(), c = items.find(c => c.id === id);
    if (c) { change(c); this.write(items); }
  }

  list(house: string) { this.house(house); return { connections: this.read().filter(c => c.house === house).map(c => this.view(c)) }; }

  begin(house: string, input: unknown, binding: string): WhatsAppPairingView {
    if (this.stopped) throw new HouseholdError("Household is stopping");
    const parsed = whatsappConnectSchema.safeParse(input);
    if (!parsed.success) throw new HouseholdError(parsed.error.issues[0]?.message.startsWith("a phone") ? "Enter the phone number in international format, like +34600111222" : "Select access and bots for this connection");
    const pets = this.pets(house, parsed.data.pets);
    if (parsed.data.connection && !this.read().some(c => c.house === house && c.id === parsed.data.connection)) throw new HouseholdError("Connection not found");
    for (const [id, p] of this.pairings) if (p.binding === binding && p.house === house) this.drop(id);
    if (this.pairings.size >= 5) throw new HouseholdError("Too many WhatsApp pairings in progress; retry in a few minutes");
    const id = randomUUID(), auth = randomUUID();
    // A pairing keeps what it sees apart until it is known to be the right account: it never writes into another's history.
    const link: Link = { auth, connection: randomUUID(), status: "connecting", client: undefined as unknown as WhatsAppClient };
    const p: Pairing = {
      house, binding, pets, writePolicy: parsed.data.writePolicy, link, expires: this.now() + PAIRING_MS, timer: setTimeout(() => this.drop(id), PAIRING_MS),
      ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(parsed.data.connection ? { target: parsed.data.connection } : {}),
      ...(parsed.data.phone ? { phone: phoneDigits(parsed.data.phone) } : {}),
    };
    this.pairings.set(id, p);
    // Once paired, the same device runs on as the connection.
    const live = this.liveEvents(link);
    link.client = this.factory({
      auth, connection: () => link.connection, store: this.data, log: this.log,
      events: {
        qr: qr => {
          if (p.connected) return live.qr();
          if (this.pairings.get(id) !== p) return;
          p.qr = qr;
          if (p.phone && !p.codeAsked) {
            p.codeAsked = true;
            link.client.requestPairingCode(p.phone).then(code => { p.code = code; }, () => { p.error = "WhatsApp did not give a pairing code for this number. Check it, or scan the QR code instead."; });
          }
        },
        open: me => { if (p.connected) live.open(me); else if (this.pairings.get(id) === p) this.paired(id, p, me); },
        status: status => { link.status = status; },
        loggedOut: () => { if (p.connected) live.loggedOut(); else if (this.pairings.get(id) === p) { p.error = "WhatsApp refused this pairing. Start again."; link.client.end(); } },
        codeExpired: () => { if (!p.connected) { p.codeAsked = false; delete p.code; } },
      },
    });
    return { id, expiresAt: new Date(p.expires).toISOString() };
  }
  /** The phone approved: the pairing becomes a connection (a new one, or the one it pairs again) and keeps running. */
  private paired(id: string, p: Pairing, me: WhatsAppIdentity) {
    const items = this.read();
    const target = items.find(c => c.house === p.house && (p.target ? c.id === p.target : c.phone === me.phone));
    if (p.target && (!target || target.phone !== me.phone)) {
      p.error = target ? `That phone is +${me.phone}, but this connection is +${target.phone}. Scan with the right phone.` : "This connection was removed.";
      // The connection paired again keeps everything; only this stray device and what it saw go.
      void p.link.client.logout().catch(() => {}); this.data.authClear(p.link.auth); this.data.clear(p.link.connection);
      return;
    }
    if (target) {
      // Its history stays; what this pairing already saw moves to it.
      if (p.link.connection !== target.id) { this.data.moveConnection(p.link.connection, target.id); p.link.connection = target.id; }
      this.abort(target.id);
      // The device it replaces is unlinked from the phone, not left behind as a ghost.
      const old = this.links.get(target.id);
      if (old) { this.links.delete(target.id); if (old.auth !== p.link.auth) void old.client.logout().catch(() => {}).finally(() => old.client.end()); else old.client.end(); }
      if (target.auth !== p.link.auth) this.data.authClear(target.auth);
    }
    const c: Connection = {
      id: p.link.connection, house: p.house, phone: me.phone, jid: me.jid, auth: p.link.auth, writePolicy: p.writePolicy, pets: p.pets,
      connectedAt: new Date(this.now()).toISOString(), needsReconnect: false,
      ...(p.name ? { name: p.name } : target?.name ? { name: target.name } : {}), ...(me.name ? { account: me.name } : target?.account ? { account: target.account } : {}),
    };
    this.write([...items.filter(i => i !== target), c]);
    p.link.status = "online";
    this.links.set(c.id, p.link);
    p.connected = c.id;
    clearTimeout(p.timer);
    // The finished pairing stays readable for a minute, so the dialog sees it.
    p.timer = setTimeout(() => this.pairings.delete(id), 60_000);
    p.expires = this.now() + 60_000;
  }
  private pairing(house: string, id: string, binding: string) {
    const p = this.pairings.get(id);
    if (!p || p.house !== house || p.binding !== binding) throw new HouseholdError("This WhatsApp pairing expired or belongs to another dashboard; start again");
    return p;
  }
  async poll(house: string, id: string, binding: string): Promise<WhatsAppPollView> {
    const p = this.pairing(house, id, binding);
    if (p.connected) return { status: "connected", connection: p.connected };
    if (p.error) { const error = p.error; this.drop(id); return { status: "failed", error }; }
    const qr = p.qr && !p.code ? await QRCode.toDataURL(p.qr, { margin: 1, width: 264, errorCorrectionLevel: "L" }) : undefined;
    return { status: "pending", expiresAt: new Date(p.expires).toISOString(), ...(qr ? { qr } : {}), ...(p.code ? { code: p.code } : {}) };
  }
  cancel(house: string, id: string, binding: string) { const p = this.pairing(house, id, binding); if (!p.connected) this.drop(id); }
  /** An unfinished pairing ends: its device, keys and what it saw go. */
  private drop(id: string) {
    const p = this.pairings.get(id);
    if (!p) return;
    this.pairings.delete(id); clearTimeout(p.timer);
    if (p.connected) return;
    this.data.clear(p.link.connection);
    // The phone may have just linked it: unlink, best effort, rather than leave a device behind.
    const client = p.link.client;
    void Promise.race([client.logout(), new Promise(resolve => setTimeout(resolve, 5_000))]).catch(() => {}).finally(() => client.end());
    this.data.authClear(p.link.auth);
  }

  setAccess(house: string, id: string, input: unknown) {
    const parsed = whatsappAccessSchema.safeParse(input);
    if (!parsed.success) throw new HouseholdError("bots must be a list of this workspace's bot names");
    const pets = this.pets(house, parsed.data.pets), items = this.read(), c = items.find(c => c.house === house && c.id === id);
    if (!c) throw new HouseholdError("Connection not found");
    c.pets = pets;
    if (parsed.data.writePolicy) c.writePolicy = parsed.data.writePolicy;
    if (parsed.data.name !== undefined) c.name = parsed.data.name;
    this.write(items); this.abort(id); return this.view(c);
  }
  /** Unlinks the device at WhatsApp (best effort) and forgets its keys and history. */
  async disconnect(house: string, id: string) {
    this.house(house);
    const items = this.read(), c = items.find(c => c.house === house && c.id === id);
    if (!c) throw new HouseholdError("Connection not found");
    this.abort(id);
    this.write(items.filter(i => i !== c));
    await this.forget(c);
  }

  private parent(caller: PetIdentity) {
    const house = this.houses.find(h => h.name === caller.house), pet = house?.pets.find(p => p.name === caller.pet);
    if (!pet || pet.scout || pet.enabled === false) return;
    return (pet.sideworker ? house?.pets.find(p => p.name === pet.sideworker!.parent && !p.sideworker && !p.scout && p.enabled !== false) : pet)?.name;
  }
  available(caller: PetIdentity) { return this.parent(caller) !== undefined; }
  accounts(caller: PetIdentity) {
    const parent = this.parent(caller);
    return parent ? this.read().filter(c => c.house === caller.house && c.pets.includes(parent)).map(c => {
      const v = this.view(c);
      return { id: v.id, name: v.name, phone: v.phone, writePolicy: v.writePolicy, link: v.link, needsReconnect: v.needsReconnect, chats: v.chats, messages: v.messages };
    }) : [];
  }
  catalog(caller: PetIdentity) { const accounts = this.accounts(caller); return accounts.length ? whatsappCatalog(accounts.some(c => c.writePolicy !== "disabled")) : []; }
  private allowed(caller: PetIdentity, id: string, write = false) {
    const parent = this.parent(caller), c = parent && this.read().find(c => c.id === id && c.house === caller.house && c.pets.includes(parent));
    if (!c) throw new HouseholdError("WhatsApp connection unavailable to this bot");
    if (write && c.writePolicy === "disabled") throw new HouseholdError("This WhatsApp account is read only; the owner can choose Ask me first or Full access in Connectors");
    return c;
  }
  private live(c: Connection) {
    if (c.needsReconnect) throw new HouseholdError("WhatsApp unlinked this device; the owner must pair it again in Connectors");
    const link = this.links.get(c.id);
    if (!link || link.status !== "online") throw new HouseholdError("WhatsApp is not connected right now; retry in a minute");
    return link.client;
  }
  private abort(id: string) { this.active.get(id)?.abort(); this.active.delete(id); }
  private seconds(value?: string) { return value ? Math.floor(Date.parse(value) / 1000) : undefined; }
  /** The message a reply or reaction points at, as WhatsApp needs it. */
  private ref(c: Connection, chat: string, id: string): WhatsAppMessageRef {
    const m = this.data.message(c.id, chat, id);
    if (!m) throw new HouseholdError("Message not found in this chat; read the chat first");
    return { chat, id, fromMe: m.fromMe, ...(!m.fromMe && m.senderJid ? { sender: m.senderJid } : {}), text: m.text };
  }

  async request(caller: PetIdentity, id: string, operation: string, input: unknown, signal?: AbortSignal, clientRequestId?: string) {
    const { name, spec, params } = whatsappOperation(operation, input), write = spec.write === true;
    const c = this.allowed(caller, id, write), budgetKey = `${caller.house}/${caller.pet}`;
    if (!this.budgets.has(budgetKey)) this.budgets.set(budgetKey, new TokenBucket(2, 20));
    if (!this.budgets.get(budgetKey)!.take()) throw new HouseholdError("Too many WhatsApp requests; retry shortly");
    const result = (data: unknown) => ({ trust: "external", data });
    switch (name) {
      case "chats.list": {
        const chats = this.data.chats(c.id, { limit: params.limit, ...(params.query ? { query: params.query } : {}), ...(params.before ? { before: this.seconds(params.before) } : {}) });
        return result({ chats, ...(chats.length === params.limit && chats.at(-1)?.last ? { nextBefore: chats.at(-1)!.last } : {}) });
      }
      case "messages.list": {
        const range = { limit: params.limit, before: this.seconds(params.before), after: this.seconds(params.after) };
        const chat = params.chat ? await this.chat(c, params.chat, false) : undefined;
        const messages = chat ? this.data.messages(c.id, chat, range) : this.data.recent(c.id, range);
        const oldest = chat ? messages[0] : messages.at(-1);
        return result({ messages, ...(messages.length === params.limit && oldest ? { nextBefore: oldest.at } : {}) });
      }
      case "messages.search": {
        const chat = params.chat ? await this.chat(c, params.chat, false) : undefined;
        return result({ messages: this.data.search(c.id, { query: params.query, limit: params.limit, ...(chat ? { chat } : {}) }) });
      }
      case "contacts.search": return result({ contacts: this.data.contacts(c.id, params) });
      case "media.download": {
        if (!this.files) throw new HouseholdError("File transfer is unavailable");
        const m = this.data.message(c.id, params.chat, params.messageId);
        if (!m) throw new HouseholdError("Message not found in this chat; read the chat first");
        const kept = this.data.file(c.id, params.chat, params.messageId);
        if (!m.raw && !kept) throw new HouseholdError("This message has no file");
        if (!kept && (m.media?.size ?? 0) > FILE_MAX) throw new HouseholdError(`This file is too large to save (over ${FILE_MAX / 1024 / 1024} MB)`);
        let bytes: Uint8Array;
        try { bytes = kept ?? await this.live(c).download(m.raw!); }
        catch (error) { if (error instanceof HouseholdError) throw error; throw new HouseholdError("WhatsApp could not deliver this file; it may have expired on the sender's phone"); }
        if (bytes.length > FILE_MAX) throw new HouseholdError("This file is too large to save");
        this.allowed(caller, id);
        const path = await this.files.save(caller, inboxFileName(`whatsapp-${m.id}`, { kind: "document", name: m.media?.fileName ?? m.kind, mime: m.media?.mimetype } as any), bytes);
        return result({ path, kind: m.kind, size: bytes.length, ...(m.media?.mimetype ? { mimetype: m.media.mimetype } : {}) });
      }
    }
    // A change: as the owner, to someone. The card names who it goes to, always with the number or JID beside a
    // name, since a name may be one the other side chose for themselves.
    const to = name === "messages.react" ? params.chat : params.to;
    const digits = phoneDigits(to), lookup = digits ? `${digits}@s.whatsapp.net` : to;
    const label = (jid: string) => {
      const known = this.data.name(c.id, jid);
      const address = jid.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]}` : jid.endsWith("@g.us") ? `group ${jid}` : jid;
      return known ? `${known} (${address})` : address;
    };
    if (name === "messages.send" && params.replyTo && !this.data.message(c.id, lookup, params.replyTo)) throw new HouseholdError("The message to reply to is not in this chat; read the chat first. Nothing was sent.");
    const review: Record<string, unknown> = {
      to: label(lookup),
      ...(name === "messages.send" ? { text: params.text, ...(params.replyTo ? { replyTo: this.data.message(c.id, lookup, params.replyTo)!.text.slice(0, 200) } : {}) } : {}),
      ...(name === "files.send" ? { file: params.path, ...(params.caption ? { caption: params.caption } : {}) } : {}),
      ...(name === "messages.react" ? { emoji: params.emoji || "(remove reaction)", message: this.data.message(c.id, lookup, params.messageId)?.text.slice(0, 200) ?? params.messageId } : {}),
    };
    if (!this.active.has(id)) this.active.set(id, new AbortController());
    const controller = this.active.get(id)!;
    /** A file is read once, before the owner sees the card: what is approved is exactly what is sent. */
    let file: { bytes: Uint8Array; name: string; mimetype: string } | undefined;
    const snapshot = async () => {
      if (!this.files) throw new HouseholdError("File transfer is unavailable");
      const bytes = await this.files.read(caller, params.path, FILE_MAX);
      const fileName = String(params.path).split(/[/\\]/).pop() || "file";
      file = { bytes, name: fileName, mimetype: Bun.file(fileName).type.split(";")[0] || "application/octet-stream" };
      return { ...review, file: `${fileName} (${file.mimetype}, ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…)` };
    };
    const execute = async (s?: AbortSignal) => {
      const current = this.allowed(caller, id, true), client = this.live(current);
      controller.signal.throwIfAborted(); s?.throwIfAborted();
      const chat = await this.chat(current, to, true);
      if (name === "files.send" && !file) await snapshot();
      controller.signal.throwIfAborted(); s?.throwIfAborted();
      try {
        if (name === "messages.send") return result({ sent: true, chat, ...(await client.sendText(chat, params.text, params.replyTo ? this.ref(current, chat, params.replyTo) : undefined)) });
        if (name === "files.send") return result({ sent: true, chat, ...(await client.sendFile(chat, file!, params.caption)) });
        await client.react(chat, this.data.message(current.id, chat, params.messageId) ? this.ref(current, chat, params.messageId) : { chat, id: params.messageId, fromMe: false }, params.emoji);
        return result({ reacted: true, chat });
      } catch (error) {
        if (error instanceof HouseholdError) throw error;
        throw new HouseholdError("WhatsApp request failed. The message may have been sent; read the chat before trying again");
      }
    };
    if (c.writePolicy === "approval" || (clientRequestId !== undefined && this.writes)) {
      if (!this.writes) throw new HouseholdError("Connector approval service is unavailable; nothing changed");
      return this.writes.run({ caller, provider: "whatsapp", connection: id, account: c.name ?? c.account ?? `+${c.phone}`, operation, requireApproval: c.writePolicy === "approval", params, review, ...(name === "files.send" ? { prepare: snapshot } : {}), clientRequestId, signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), validate: () => { this.allowed(caller, id, true); }, execute });
    }
    return execute(signal);
  }
  /** A chat's JID: as given, or the one WhatsApp knows a phone number by (asking it, for a send). */
  private async chat(c: Connection, value: string, resolve: boolean) {
    const digits = phoneDigits(value);
    if (digits === undefined) return value;
    if (digits.length < 6) throw new HouseholdError("Give the phone number in international format, like +34600111222");
    if (!resolve) return `${digits}@s.whatsapp.net`;
    const jid = await this.live(c).resolve(digits).catch(() => { throw new HouseholdError("Could not check this number with WhatsApp; retry shortly"); });
    if (!jid) throw new HouseholdError(`+${digits} is not on WhatsApp`);
    return jid;
  }
  stop() {
    this.stopped = true;
    for (const id of [...this.active.keys()]) this.abort(id);
    for (const id of [...this.pairings.keys()]) this.drop(id);
    for (const id of [...this.links.keys()]) this.stopLink(id);
  }
}
