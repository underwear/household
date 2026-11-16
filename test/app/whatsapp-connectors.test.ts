import { expect, test } from "bun:test";
import { proto } from "baileys";
import { ConnectorWrites, connectorWriteCard, type ConnectorWriteApproval, type ConnectorWriteView } from "../../src/app/connector-writes";
import { WhatsAppConnectors } from "../../src/app/whatsapp-connectors";
import { whatsappConnectorTools } from "../../src/app/whatsapp-connector-tools";
import { whatsappConnectorRoutes } from "../../src/app/whatsapp-connector-routes";
import { convert, type WhatsAppClient, type WhatsAppClientOptions } from "../../src/infra/whatsapp/client";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";

const caller = { house: "home", pet: "alice" };
const ME = { jid: "34600111222@s.whatsapp.net", phone: "34600111222", name: "Igor" };
interface Fake { options: WhatsAppClientOptions; sent: { chat: string; text?: string; file?: string; emoji?: string; quoted?: string; sender?: string }[]; ended: boolean; loggedOut: boolean; codes: string[] }
function setup(approval?: ConnectorWriteApproval) {
  const house: House = { name: "home", pets: [{ name: "alice" }, { name: "bob" }, { name: "worker", sideworker: { parent: "alice", cwd: "/" } }, { name: "scout", scout: {} as any }], network: { kind: "allowlist", allow: [] }, people: { owners: [] }, channels: [] };
  const store = new SqliteStore(":memory:");
  const writes = new ConnectorWrites(store, approval);
  const clients: Fake[] = [];
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const factory = (options: WhatsAppClientOptions): WhatsAppClient => {
    const fake: Fake = { options, sent: [], ended: false, loggedOut: false, codes: [] };
    clients.push(fake);
    return {
      requestPairingCode: async phone => { fake.codes.push(phone); return "ABCD1234"; },
      sendText: async (chat, text, quoted) => { fake.sent.push({ chat, text, ...(quoted ? { quoted: quoted.id } : {}) }); return { id: `sent-${fake.sent.length}` }; },
      sendFile: async (chat, file) => { fake.sent.push({ chat, file: `${file.name}:${file.mimetype}` }); return { id: "file-1" }; },
      react: async (chat, target, emoji) => { fake.sent.push({ chat, emoji, quoted: target.id, ...(target.sender ? { sender: target.sender } : {}) }); },
      resolve: async phone => phone.startsWith("0") ? undefined : `${phone}@s.whatsapp.net`,
      download: async () => new Uint8Array([1, 2, 3]),
      logout: async () => { fake.loggedOut = true; },
      end: () => { fake.ended = true; },
    };
  };
  const files = { read: async () => new Uint8Array([9]), save: async (_c: unknown, name: string, bytes: Uint8Array) => { saved.push({ name, bytes }); return `inbox/${name}`; } };
  const service = new WhatsAppConnectors(store, store.whatsapp, files, writes, factory);
  service.setHouses([house, { ...house, name: "other" }]);
  /** Pairs a phone: the pairing's client shows a QR, then the phone approves it. */
  const connect = async (input: Record<string, unknown> = {}, me = ME) => {
    const p = service.begin("home", { pets: ["alice"], ...input }, "session");
    const client = clients.at(-1)!;
    client.options.events.qr("2@qr-payload");
    client.options.events.open(me);
    client.options.events.status("online");
    const result = await service.poll("home", p.id, "session");
    if (result.status !== "connected") throw new Error(`not connected: ${JSON.stringify(result)}`);
    return { id: result.connection, client };
  };
  return { store, service, writes, clients, saved, house, connect };
}

test("pairing shows a QR as an image, then becomes a connection that keeps its client", async () => {
  const s = setup();
  const p = s.service.begin("home", { name: "Personal", pets: ["alice"], writePolicy: "approval" }, "session");
  expect(await s.service.poll("home", p.id, "session")).toMatchObject({ status: "pending" });
  s.clients[0]!.options.events.qr("2@payload");
  const pending = await s.service.poll("home", p.id, "session");
  expect(pending.status === "pending" && pending.qr?.startsWith("data:image/png;base64,")).toBe(true);
  await expect(s.service.poll("home", p.id, "other-session")).rejects.toThrow("expired or belongs to another dashboard");
  s.clients[0]!.options.events.open(ME);
  const done = await s.service.poll("home", p.id, "session");
  expect(done.status).toBe("connected");
  const [c] = s.service.list("home").connections;
  expect(c).toMatchObject({ name: "Personal", phone: "+34600111222", account: "Igor", writePolicy: "approval", pets: ["alice"], link: "online", needsReconnect: false });
  expect(s.clients).toHaveLength(1);
  expect(s.clients[0]!.ended).toBe(false);
  // Keys of the pairing survive; a restart starts the same pairing again.
  s.store.whatsapp.authSet(s.clients[0]!.options.auth, [["creds", "{}"]]);
  const again = new WhatsAppConnectors(s.store, s.store.whatsapp, undefined, undefined, (o) => { s.clients.push({ options: o } as Fake); return { end() {} } as any; });
  again.setHouses([s.house]);
  expect(s.clients.at(-1)!.options.auth).toBe(s.clients[0]!.options.auth);
  expect(s.store.whatsapp.authGet(s.clients[0]!.options.auth, "creds")).toBe("{}");
});

test("a phone number asks WhatsApp for a pairing code instead of a QR", async () => {
  const s = setup();
  const p = s.service.begin("home", { pets: [], phone: "+34 600 111 222" }, "session");
  s.clients[0]!.options.events.qr("2@payload");
  await Promise.resolve();
  const view = await s.service.poll("home", p.id, "session");
  expect(view).toMatchObject({ status: "pending", code: "ABCD1234" });
  expect(view.status === "pending" && view.qr).toBeFalsy();
  expect(s.clients[0]!.codes).toEqual(["34600111222"]);
  expect(() => s.service.begin("home", { pets: [], phone: "call me" }, "session")).toThrow("international format");
});

test("a cancelled pairing ends its device and forgets what it saw", async () => {
  const s = setup();
  const p = s.service.begin("home", { pets: ["alice"] }, "session");
  const client = s.clients[0]!;
  s.store.whatsapp.authSet(client.options.auth, [["creds", "{}"]]);
  s.store.whatsapp.addMessages(client.options.connection(), [{ chat: "1@s.whatsapp.net", id: "a", fromMe: false, at: 1, kind: "text", text: "hi" }]);
  s.service.cancel("home", p.id, "session");
  await new Promise(r => setTimeout(r, 0));
  expect(client.loggedOut && client.ended).toBe(true);
  expect(s.store.whatsapp.authGet(client.options.auth, "creds")).toBeUndefined();
  expect(s.store.whatsapp.counts(client.options.connection()).messages).toBe(0);
  expect(s.service.list("home").connections).toHaveLength(0);
});

test("pairing the same number again keeps the connection and its history", async () => {
  const s = setup();
  const first = await s.connect({ name: "Mine" });
  s.store.whatsapp.addMessages(first.id, [{ chat: "1@s.whatsapp.net", id: "a", fromMe: false, at: 1, kind: "text", text: "old" }]);
  const second = await s.connect({ pets: ["bob"] });
  expect(second.id).toBe(first.id);
  expect(first.client.ended).toBe(true);
  expect(s.service.list("home").connections).toEqual([expect.objectContaining({ id: first.id, name: "Mine", pets: ["bob"], messages: 1 })]);
  // Pairing a named connection with another phone is refused.
  const p = s.service.begin("home", { pets: ["alice"], connection: first.id }, "session");
  s.clients.at(-1)!.options.events.open({ jid: "1@s.whatsapp.net", phone: "1" });
  expect(await s.service.poll("home", p.id, "session")).toMatchObject({ status: "failed", error: expect.stringContaining("+1") });
  expect(s.clients.at(-1)!.loggedOut).toBe(true);
  expect(s.service.list("home").connections[0]).toMatchObject({ phone: "+34600111222", messages: 1 });
});

test("WhatsApp unlinking the device marks it for pairing again and cuts bots off", async () => {
  const s = setup();
  const { id, client } = await s.connect({ writePolicy: "auto" });
  client.options.events.loggedOut();
  expect(s.service.list("home").connections[0]).toMatchObject({ needsReconnect: true, link: "offline" });
  await expect(s.service.request(caller, id, "messages.send", { to: "+34600999888", text: "hi" })).rejects.toThrow("pair it again");
  // Reads of what was kept still work.
  expect(await s.service.request(caller, id, "chats.list", {})).toMatchObject({ trust: "external" });
});

test("bots read chats, messages and contacts; names come from contacts and groups", async () => {
  const s = setup();
  const { id } = await s.connect();
  const w = s.store.whatsapp;
  w.upsertContact(id, { jid: "34611222333@s.whatsapp.net", name: "Мама", notify: "mom" });
  w.upsertChat(id, "123-456@g.us", { name: "Family" });
  w.addMessages(id, [
    { chat: "34611222333@s.whatsapp.net", id: "m1", fromMe: false, sender: "34611222333@s.whatsapp.net", at: 100, kind: "text", text: "Привет, купи молоко" },
    { chat: "34611222333@s.whatsapp.net", id: "m2", fromMe: true, at: 200, kind: "text", text: "ok" },
    { chat: "123-456@g.us", id: "g1", fromMe: false, sender: "34611222333@s.whatsapp.net", at: 150, kind: "image", text: "", media: { mimetype: "image/jpeg" }, raw: "{}" },
  ]);
  const chats = (await s.service.request(caller, id, "chats.list", {}) as any).data.chats;
  expect(chats.map((c: any) => [c.name, c.lastText, c.lastFrom])).toEqual([["Мама", "ok", "me"], ["Family", "", "Мама"]]);
  expect((await s.service.request(caller, id, "chats.list", { query: "fam" }) as any).data.chats).toHaveLength(1);
  const messages = (await s.service.request(caller, id, "messages.list", { chat: "+34611222333" }) as any).data.messages;
  expect(messages.map((m: any) => [m.id, m.from])).toEqual([["m1", "Мама"], ["m2", "me"]]);
  expect((await s.service.request(caller, id, "messages.list", { limit: 1 }) as any).data).toMatchObject({ messages: [{ id: "m2" }], nextBefore: new Date(200_000).toISOString() });
  expect((await s.service.request(caller, id, "messages.search", { query: "молок" }) as any).data.messages.map((m: any) => m.id)).toEqual(["m1"]);
  expect((await s.service.request(caller, id, "contacts.search", { query: "МАМ" }) as any).data.contacts).toEqual([{ jid: "34611222333@s.whatsapp.net", name: "Мама", pushName: "mom" }]);
  const download = (await s.service.request(caller, id, "media.download", { chat: "123-456@g.us", messageId: "g1" }) as any).data;
  expect(download).toMatchObject({ kind: "image", size: 3, mimetype: "image/jpeg" });
  expect(s.saved[0]!.name).toEndWith(".jpg");
  await expect(s.service.request(caller, id, "media.download", { chat: "34611222333@s.whatsapp.net", messageId: "m1" })).rejects.toThrow("no file");
  // Sideworkers inherit; other bots, scouts and other workspaces don't.
  expect(s.service.accounts({ house: "home", pet: "worker" })).toHaveLength(1);
  for (const other of [{ house: "home", pet: "bob" }, { house: "home", pet: "scout" }, { house: "other", pet: "alice" }]) {
    expect(s.service.accounts(other)).toEqual([]);
    await expect(s.service.request(other, id, "chats.list", {})).rejects.toThrow("unavailable");
  }
});

test("read only refuses sends; Ask me first shows who it goes to and sends only when approved", async () => {
  const cards: ConnectorWriteView[] = [];
  let answer: "approved" | "denied" = "approved";
  const s = setup({ ask: async (_c, write) => { cards.push(write); return answer; } });
  const { id, client } = await s.connect();
  s.store.whatsapp.upsertContact(id, { jid: "34611222333@s.whatsapp.net", name: "Мама" });
  s.store.whatsapp.addMessages(id, [{ chat: "34611222333@s.whatsapp.net", id: "m1", fromMe: false, sender: "34611222333@s.whatsapp.net", at: 100, kind: "text", text: "Купи молоко" }]);
  expect(s.service.catalog(caller).some(o => o.write)).toBe(false);
  await expect(s.service.request(caller, id, "messages.send", { to: "34611222333@s.whatsapp.net", text: "hi" })).rejects.toThrow("read only");
  s.service.setAccess("home", id, { pets: ["alice"], writePolicy: "approval" });
  await expect(s.service.request(caller, id, "messages.send", { to: "34611222333@s.whatsapp.net", text: "hi" })).rejects.toThrow("clientRequestId");
  const result = await s.service.request(caller, id, "messages.send", { to: "34611222333@s.whatsapp.net", text: "Куплю", replyTo: "m1" }, undefined, "r1");
  expect(result).toMatchObject({ data: { sent: true, id: "sent-1" } });
  expect(client.sent).toEqual([{ chat: "34611222333@s.whatsapp.net", text: "Куплю", quoted: "m1" }]);
  expect(cards[0]!.params).toEqual({ to: "Мама (+34611222333)", text: "Куплю", replyTo: "Купи молоко" });
  await expect(s.service.request(caller, id, "messages.send", { to: "34611222333@s.whatsapp.net", text: "x", replyTo: "nope" }, undefined, "r0")).rejects.toThrow("Nothing was sent");
  expect(cards).toHaveLength(1);
  const card = connectorWriteCard(cards[0]!);
  expect(card.text).toContain("Approve WhatsApp change");
  expect(card.text).toContain("Send a text message as the owner");
  answer = "denied";
  await expect(s.service.request(caller, id, "messages.react", { chat: "34611222333@s.whatsapp.net", messageId: "m1", emoji: "👍" }, undefined, "r2")).rejects.toThrow("denied");
  expect(client.sent).toHaveLength(1);
  // Full access sends at once; a number is resolved with WhatsApp first.
  s.service.setAccess("home", id, { pets: ["alice"], writePolicy: "auto", name: "Renamed" });
  await s.service.request(caller, id, "files.send", { to: "+34 699 000 111", path: "outbox/plan.pdf" });
  s.service.setAccess("home", id, { pets: ["alice"], writePolicy: "approval" });
  answer = "approved";
  await s.service.request(caller, id, "files.send", { to: "123-456@g.us", path: "outbox/photo.jpg" }, undefined, "f1");
  expect(cards.at(-1)!.params).toEqual({ to: "group 123-456@g.us", file: expect.stringMatching(/^photo\.jpg \(image\/jpeg, 1 bytes, sha256 [0-9a-f]{16}…\)$/) });
  s.service.setAccess("home", id, { pets: ["alice"], writePolicy: "auto" });
  expect(client.sent.slice(-2)).toEqual([{ chat: "34699000111@s.whatsapp.net", file: "plan.pdf:application/pdf" }, { chat: "123-456@g.us", file: "photo.jpg:image/jpeg" }]);
  await expect(s.service.request(caller, id, "messages.send", { to: "+0123456", text: "x" })).rejects.toThrow("not on WhatsApp");
  expect(s.service.list("home").connections[0]!.name).toBe("Renamed");
});

test("disconnect unlinks the device and forgets keys and history", async () => {
  const s = setup();
  const { id, client } = await s.connect();
  s.store.whatsapp.authSet(client.options.auth, [["creds", "{}"]]);
  s.store.whatsapp.addMessages(id, [{ chat: "1@s.whatsapp.net", id: "a", fromMe: false, at: 1, kind: "text", text: "hi" }]);
  await s.service.disconnect("home", id);
  expect(client.loggedOut).toBe(true);
  expect(s.store.whatsapp.authGet(client.options.auth, "creds")).toBeUndefined();
  expect(s.store.whatsapp.counts(id)).toEqual({ chats: 0, messages: 0 });
  expect(s.service.list("home").connections).toEqual([]);
});

test("routes pair, poll, rename and disconnect, bound to the browser session", async () => {
  const s = setup();
  const routes = whatsappConnectorRoutes(s.service);
  const call = (method: string, path: string, body?: unknown) => routes(new Request(`http://localhost:8080/api/houses/home/connectors/whatsapp${path}`, { method, headers: { cookie: "x=y" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const begun = await (await call("POST", "/pair", { pets: ["alice"], name: "Work" }))!.json();
  s.clients[0]!.options.events.open(ME);
  expect(await (await call("POST", "/poll", { id: begun.id }))!.json()).toMatchObject({ status: "connected" });
  const [c] = (await (await call("GET", ""))!.json()).connections;
  expect(c.name).toBe("Work");
  expect(await (await call("PATCH", `/${c.id}`, { pets: [], name: "Home" }))!.json()).toMatchObject({ name: "Home", pets: [] });
  expect((await call("DELETE", `/${c.id}`))!.status).toBe(200);
  expect(await routes(new Request("http://localhost/api/houses/home/connectors/slack"))).toBeUndefined();
  expect(whatsappConnectorTools(s.service).map(t => t.name)).toEqual(["household_connectors_whatsapp_accounts", "household_connectors_whatsapp_operations", "household_connectors_whatsapp_request"]);
});

test("convert keeps text, media, replies and edits, and skips what bots can't use", () => {
  const key = (k: Record<string, unknown>) => ({ remoteJid: "34611222333@s.whatsapp.net", id: "X1", fromMe: false, ...k });
  expect(convert({ key: key({}), messageTimestamp: 100, message: { conversation: "hi" } } as any)).toEqual({ message: { chat: "34611222333@s.whatsapp.net", id: "X1", fromMe: false, sender: "34611222333@s.whatsapp.net", at: 100, kind: "text", text: "hi" } });
  const reply = convert({ key: key({ remoteJid: "1-2@g.us", participant: "99@lid", participantAlt: "34622@s.whatsapp.net" }), messageTimestamp: 5, message: { extendedTextMessage: { text: "yes", contextInfo: { stanzaId: "Q" } } } } as any);
  expect(reply).toMatchObject({ message: { chat: "1-2@g.us", sender: "34622@s.whatsapp.net", quoted: "Q", text: "yes" } });
  const image = convert({ key: key({ remoteJid: "77@lid", remoteJidAlt: "34633@s.whatsapp.net" }), messageTimestamp: 5, message: { ephemeralMessage: { message: { imageMessage: { caption: "look", mimetype: "image/jpeg", fileLength: 2048 } } } } } as any);
  expect(image).toMatchObject({ message: { chat: "34633@s.whatsapp.net", kind: "image", text: "look", media: { mimetype: "image/jpeg", size: 2048 } } });
  expect((image as any).message.raw).toContain("imageMessage");
  const edit = convert({ key: key({}), message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: "OLD" }, editedMessage: { conversation: "fixed" } } } } as any);
  expect(edit).toEqual({ edit: { chat: "34611222333@s.whatsapp.net", id: "OLD", change: { text: "fixed", at: expect.any(Number) }, by: { fromMe: false, sender: "34611222333@s.whatsapp.net" } } });
  expect(convert({ key: key({}), messageTimestamp: 7, message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: "OLD" } } } } as any)).toMatchObject({ edit: { id: "OLD", change: { deleted: 7 } } });
  expect(convert({ key: key({}), message: { reactionMessage: { text: "👍" } } } as any)).toBeUndefined();
  expect(convert({ key: key({ remoteJid: "status@broadcast" }), message: { conversation: "story" } } as any)).toBeUndefined();
});

test("only a message's own author can edit or delete it, and LIDs fold into numbers", () => {
  const s = setup(), w = s.store.whatsapp, chat = "1-2@g.us";
  w.addMessages("c", [{ chat, id: "a", fromMe: false, sender: "34611222333@s.whatsapp.net", at: 1, kind: "text", text: "mine" }, { chat, id: "b", fromMe: true, at: 2, kind: "text", text: "owner's" }]);
  w.editMessage("c", chat, "a", { text: "forged", at: 5 }, { fromMe: false, sender: "34699000111@s.whatsapp.net" });
  w.editMessage("c", chat, "b", { text: "forged", at: 5 }, { fromMe: false, sender: "34611222333@s.whatsapp.net" });
  w.editMessage("c", chat, "a", { text: "edited", at: 10 }, { fromMe: false, sender: "34611222333@s.whatsapp.net" });
  w.editMessage("c", chat, "a", { text: "edited twice", at: 20 }, { fromMe: false, sender: "34611222333@s.whatsapp.net" });
  w.editMessage("c", chat, "b", { deleted: 30 }, { fromMe: true });
  // The original arriving again (history sync) changes nothing.
  w.addMessages("c", [{ chat, id: "a", fromMe: false, sender: "34611222333@s.whatsapp.net", at: 1, kind: "text", text: "mine" }]);
  const [a, b] = w.messages("c", chat, { limit: 10 });
  expect(a).toMatchObject({ text: "edited twice", edited: new Date(20_000).toISOString(), previous: [{ text: "mine", until: new Date(10_000).toISOString() }, { text: "edited", until: new Date(20_000).toISOString() }] });
  expect(b).toMatchObject({ text: "owner's", deleted: new Date(30_000).toISOString() });
  expect(w.search("c", { query: "owner", limit: 5 }).map(m => m.id)).toEqual(["b"]);
  // Edited several times, then deleted: everything stays, and a reader is told so.
  w.editMessage("c", chat, "a", { deleted: 40 }, { fromMe: false, sender: "34611222333@s.whatsapp.net" });
  w.editMessage("c", chat, "a", { text: "too late", at: 50 }, { fromMe: false, sender: "34611222333@s.whatsapp.net" });
  const [gone] = w.messages("c", chat, { limit: 10 });
  expect(gone).toMatchObject({ text: "edited twice", deleted: new Date(40_000).toISOString(), previous: [{ text: "mine" }, { text: "edited" }] });
  expect(gone!.note).toBe(`Edited 2 times by its author: text is the last version, previous the earlier ones, oldest first; then deleted for everyone by its author at ${new Date(40_000).toISOString()}: the other side no longer sees it; Household kept it.`);
  expect(b!.note).toStartWith("Deleted for everyone");
  expect(w.search("c", { query: "mine", limit: 5 }).map(m => m.id)).toEqual(["a"]);
  expect(w.search("c", { query: "twice", limit: 5 }).map(m => m.id)).toEqual(["a"]);
  w.addMessages("c", [{ chat: "77@lid", id: "x", fromMe: false, sender: "77@lid", at: 3, kind: "text", text: "via lid" }]);
  w.upsertContact("c", { jid: "77@lid", notify: "Anna" });
  w.mergeJid("c", "77@lid", "34622000000@s.whatsapp.net");
  expect(w.messages("c", "34622000000@s.whatsapp.net", { limit: 10 })).toEqual([expect.objectContaining({ id: "x", from: "Anna", chatName: "Anna" })]);
  expect(w.chats("c", { limit: 10 }).map(c => c.jid)).not.toContain("77@lid");
});

test("group replies quote the right sender; a removed workspace unlinks and forgets its accounts", async () => {
  const s = setup();
  const { id, client } = await s.connect({ writePolicy: "auto" });
  s.store.whatsapp.addMessages(id, [{ chat: "1-2@g.us", id: "g", fromMe: false, sender: "34611222333@s.whatsapp.net", at: 1, kind: "text", text: "who?" }]);
  await s.service.request(caller, id, "messages.react", { chat: "1-2@g.us", messageId: "g", emoji: "👍" });
  expect(client.sent).toEqual([{ chat: "1-2@g.us", emoji: "👍", quoted: "g", sender: "34611222333@s.whatsapp.net" }]);
  s.service.setHouses([{ ...s.house, name: "other" }]);
  await new Promise(r => setTimeout(r, 0));
  expect(client.loggedOut).toBe(true);
  expect(s.store.whatsapp.counts(id).messages).toBe(0);
});
