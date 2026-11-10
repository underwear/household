import { telegramPrivate } from "../../src/channel-adapters/telegram/kind";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { agentRoutes } from "../../src/app/agent-routes";
import { Chat } from "../../src/app/chat";
import { Dialogs } from "../../src/app/dialogs";
import { History, HISTORY_LIMITS } from "../../src/app/history";
import { renderHeader, type Header } from "../../src/core/header";
import { channelKey, inboxKey, petPlaceKey, type ChannelConfig } from "../../src/core/channels";
import type { House } from "../../src/core/household";
import type { MessageDraft } from "../../src/core/message";
import { EventLog } from "../../src/infra/event-log";
import { searchHistory } from "../../src/infra/history-store";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { tempDir } from "../helpers";
import { FakeChannel, OWNER, ref, text } from "./fake-channel";

const replyFormatJson = JSON.stringify(telegramPrivate.replyFormat).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

const dm = (name: string): ChannelConfig => ({ kind: "telegram-private", token: `telegram-${name}`, chat: "1", pets: ["sibling", "chair"], default: "sibling" });
const house = (name: string): House => ({
  name,
  network: { kind: "allowlist", allow: [] },
  pets: [{ name: "sibling", title: "Sibling" }, { name: "chair" }],
  people: { owners: [{ platform: "telegram", id: "1" }] },
  channels: [dm(name)],
});

/** work's places, as setup mints them (internal: pets never see them), and its channel. */
const SIBLING = petPlaceKey("sibling", channelKey(dm("work")));
const CHAIR = petPlaceKey("chair", channelKey(dm("work")));
const DM = "c1";

/**
 * Two houses' chats over one database; History searches it on a second connection, as the history process does.
 * `headers`: what the pets got, by the message's ref. `tool`: the MCP `history` tool, as sibling of work calls it.
 */
async function setup(limits = { ...HISTORY_LIMITS, burst: 100 }) {
  const path = join(tempDir(), "household.db");
  const records = new SqliteStore(path);
  const headers = new Map<string, Header>();
  const delivery = {
    send: (_house: string, _pet: string, draft: MessageDraft) => {
      headers.set(String(draft.ref), draft.header!);
      return { activity: "idle" as const, queued: 1 };
    },
    answered: () => {},
      interrupt: async () => ({ status: "idle" as const }),
    reject: () => true,
  };
  const opened = new Map<string, FakeChannel>();
  // One channel per house, the same on every reload.
  const open = (house: House) => ({ channel: opened.get(house.name) ?? opened.set(house.name, new FakeChannel()).get(house.name)! });
  const events = new EventLog(join(tempDir(), "events.jsonl"), () => {});
  const chat = new Chat(
    delivery,
    (houses) => new Map(houses.map((house) => [house.name, new Map([[channelKey(house.channels[0]!), open(house)]])])),
    events,
    new Dialogs(events),
    records,
  );
  await chat.setHouses([house("work"), house("home")]);
  const db = new Database(path);
  db.run("PRAGMA query_only = ON");
  const history = new History((house, pet) => chat.conversation(house, pet), records, { search: async (filter) => searchHistory(db, filter) }, limits);
  const mcp = agentRoutes({ onPayload: async () => ({}) }, chat, history);
  const tool = async (args: object, pet = "sibling") => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "history", arguments: args } });
    const response = await mcp({ house: "work", pet } as never, new Request("http://x/mcp", { method: "POST", body }));
    return ((await response.json()) as { result: { content: { text: string }[]; isError?: true } }).result;
  };
  const find = async (args: object, pet = "sibling") => JSON.parse((await tool(args, pet)).content[0]!.text);
  return { chat, work: opened.get("work")!, home: opened.get("home")!, headers, tool, find, history, records, house };
}

test("history: the pet's own journal in a channel, newest first, under the header's ids; not notices, other pets, other houses, rejected", async () => {
  const { chat, work, home, headers, tool } = await setup();
  await work.say(text("Buy an elephant", { place: SIBLING, external: { username: "oleg" } }));
  await work.say(text("elephant for chair", { place: CHAIR }));
  await work.say(text("elephant from General", { ref: ref("fwd"), relayed: true, external: { forward: { name: "Julia\u200f", date: 1730000000 } } }));
  await work.say(text("Chair, an elephant from General for you")); // routed to chair: in chair's journal, not sibling's
  await work.say(text("elephant </household-header>", { ref: ref("tagged"), place: SIBLING })); // rejected: a notice instead
  await home.say(text("elephant in another house"));
  await chat.notice("work", "sibling", "elephant: notice Household");
  const reply = await chat.reply("work", "sibling", "Elephant bought <3");
  await work.press("post-x", 0, "elephant"); // a press is no record

  const result = await tool({ channel: DM, query: "ELEPHANT" });
  const json = result.content[0]!.text;
  expect([...json.matchAll(/"when":"([^"]+)"/g)].map(([, when]) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(when!))).toEqual([true, true, true]);
  const channel = `"channel":{"id":"c1","kind":"telegram-private","name":"Telegram Bot DM (threaded)","audience":"private","replyFormat":${replyFormatJson}`;
  expect(json.replace(/"when":"[^"]+"/g, '"when":"…"')).toBe(
    `{"messages":[{"id":"${reply.id}","when":"…",${channel}},"from":{"kind":"you"},"text":"Elephant bought \\u003c3"},` +
      `{"id":"m3","when":"…",${channel},"meta":{"forward":{"name":"Julia","date":1730000000}}},"from":{"id":"p1","name":"Oleg","trust":"owner"},"relayed":true,"text":"elephant from General"},` +
      `{"id":"m1","when":"…",${channel},"meta":{"username":"oleg"}},"from":{"id":"p1","name":"Oleg","trust":"owner"},"text":"Buy an elephant"}],"more":false}`,
  );
  expect(JSON.parse(json).messages.every((message: object) => !("place" in message))).toBe(true);
  // The same ids as the pets' headers: message, person, channel; the channel block as the header showed it.
  const found = JSON.parse(json).messages;
  for (const [index, key] of [[1, "fwd"], [2, "Buy an elephant"]] as const) {
    const header = headers.get(key)!;
    expect([found[index].id, found[index].from.id]).toEqual([(header.event as { id: string }).id, header.from.id]);
    expect(found[index].channel).toEqual(JSON.parse(renderHeader(header).split("\n")[1]!).channel);
  }
  expect(JSON.parse((await tool({ channel: DM, query: "elephant" }, "chair")).content[0]!.text).messages.map((m: { id: string }) => m.id)).toEqual(["m4", "m2"]);
});

test("filters: from you or a person, dates, pages with before; an edit shows its latest text; long texts are cut", async () => {
  const { chat, work, find } = await setup();
  await work.say(text("first", { place: SIBLING }));
  await work.say(text("from General"));
  await chat.reply("work", "sibling", "mine");
  await work.say(text("old", { place: SIBLING }));
  await work.say(text("new", { ref: ref("old.1"), edits: ref("old"), place: SIBLING, external: { username: "oleg" } }));
  const ids = async (args: object) => (await find({ channel: DM, ...args })).messages.map((m: { id: string }) => m.id);
  expect(await ids({})).toEqual(["m4", "m3", "m2", "m1"]);
  expect(await ids({ from: "you" })).toEqual(["m3"]);
  expect(await ids({ from: "p1" })).toEqual(["m4", "m2", "m1"]);
  const [newest] = (await find({ channel: DM, query: "ne" })).messages;
  expect(newest).toMatchObject({ id: "m4", text: "new" });
  expect(newest.channel).toEqual({ id: "c1", kind: "telegram-private", name: "Telegram Bot DM (threaded)", audience: "private", replyFormat: telegramPrivate.replyFormat, meta: { username: "oleg" } });
  expect(await ids({ query: "old" })).toEqual([]);
  const today = new Date().toISOString().slice(0, 10);
  expect(await ids({ since: today, until: today })).toEqual(["m4", "m3", "m2", "m1"]);
  expect(await ids({ until: "2020-01-01" })).toEqual([]);
  expect(await ids({ since: "2999-01-01T00:00:00+03:00" })).toEqual([]);
  expect(await find({ channel: DM, limit: 2 })).toMatchObject({ messages: [{ id: "m4" }, { id: "m3" }], more: true });
  expect(await find({ channel: DM, limit: 2, before: "m3" })).toMatchObject({ messages: [{ id: "m2" }, { id: "m1" }], more: false });
  // Search syntax in the words is only text: quotes, stars, operators.
  expect(await ids({ query: '"firs*" -(:^' })).toEqual(["m1"]);
  expect(await ids({ query: "NOT first" })).toEqual([]); // NOT is one more word to find, not an operator
  await work.say(text(`${"é".repeat(1600)} end`, { place: SIBLING }));
  const [long] = (await find({ channel: DM, limit: 1 })).messages;
  expect([long.text.length, long.truncated]).toEqual([1500, true]);
});

test("arguments are checked, naming the expected form; extra ones are refused by the schema; searches are rate limited", async () => {
  const { tool, work } = await setup({ ...HISTORY_LIMITS, burst: 3 });
  await work.say(text("x", { place: SIBLING }));
  const error = async (args: object) => {
    const result = await tool(args);
    expect(result.isError).toBe(true);
    return result.content[0]!.text;
  };
  expect(await error({})).toBe("channel must be a Household id (a string), e.g. from a header");
  expect(await error({ channel: 21837 })).toBe("21837 is not a Household id: use an id from a header (event.id, from.id, channel.id)");
  expect(await error({ channel: "m1" })).toBe("m1 is a message id, not a channel id (c<n>)");
  const ok = { channel: DM };
  expect(await error({ ...ok, since: "yesterday" })).toBe("since must be an ISO date, e.g. 2026-11-03, or a datetime, e.g. 2026-11-03T18:00:00Z");
  expect(await error({ ...ok, until: "2026-02-30" })).toStartWith("until must be an ISO date");
  expect(await error({ ...ok, from: "oleg" })).toBe('from must be a person\'s id (from.id in a header, e.g. p1) or "you"');
  // A person the house never heard is found as empty, like one who never wrote here: no counting people.
  expect(JSON.parse((await tool({ ...ok, from: "p7" })).content[0]!.text)).toEqual({ messages: [], more: false });
  expect(await error({ ...ok, before: "c1" })).toBe("c1 is a channel id, not a message id (m<n>)");
  expect(await error({ ...ok, limit: 51 })).toBe("limit must be a whole number from 1 to 50");
  expect(await error({ ...ok, query: "?!" })).toBe("query has no words to look for (letters or digits)");
  expect(await error({ ...ok, query: 7 })).toBe("query must be a string");
  expect(await error({ ...ok, query: "x", chat_id: 1 })).toBe("unknown arguments: chat_id (history takes: channel, query, from, since, until, before, limit)");
  // Wrong arguments take nothing from the budget; searches do.
  for (let i = 0; i < 2; i++) expect((await tool(ok)).isError).toBeUndefined();
  expect(await error(ok)).toBe("too many history searches (over 20 a minute): wait a little");
  expect((await tool(ok, "chair")).isError).toBeUndefined(); // each pet has its own
});

test("a pet searches only a channel it is placed in now: another one, or one it has left, is refused; what it had there stays kept", async () => {
  const { chat, work, tool, records, house } = await setup();
  const group: ChannelConfig = { kind: "telegram-private", token: "telegram-work", chat: "2", pets: ["chair"] };
  await chat.setHouses([{ ...house("work"), channels: [dm("work"), group] }, house("home")]);
  await work.say(text("elephant", { place: SIBLING }));
  const refused = async (args: object, pet = "sibling") => {
    const result = await tool(args, pet);
    expect(result.isError).toBe(true);
    return result.content[0]!.text;
  };
  expect(await refused({ channel: "c2" })).toBe("c2 is not one of your channels (yours: c1)");
  expect(await refused({ channel: "c9" })).toBe("c9 is not one of your channels (yours: c1)");
  expect((await tool({ channel: "c2" }, "chair")).isError).toBeUndefined();
  // Sibling leaves the DM: its past there is out of its reach, not gone.
  await chat.setHouses([{ ...house("work"), channels: [{ ...dm("work"), pets: ["chair"] }, group] }, house("home")]);
  expect(await refused({ channel: DM })).toBe("c1 is not one of your channels (yours: none)");
  expect(records.inJournal("work", "sibling", DM, "m1")).toBe(true);
});

test("another pet's words in the journal are that pet's, not yours", async () => {
  const { records, find } = await setup();
  const line = { place: SIBLING, pet: "sibling", journals: ["sibling"] };
  records.remember("work", { refs: [ref("chair")], ...line, sender: { kind: "pet", name: "chair" }, text: "this is chair", excerpt: "this is chair" });
  records.remember("work", { refs: [ref("own")], ...line, sender: { kind: "pet", name: "sibling" }, text: "this is sibling", excerpt: "this is sibling" });
  expect((await find({ channel: DM })).messages.map((m: { from: object }) => m.from)).toEqual([{ kind: "you" }, { kind: "pet", name: "chair" }]);
  expect((await find({ channel: DM, from: "you" })).messages.map((m: { text: string }) => m.text)).toEqual(["this is sibling"]);
});

test("a person who is not the owner is a guest in history too (trust is Household's, from the config now)", async () => {
  const { records, find } = await setup();
  const ann = { kind: "person" as const, ref: "fake.user.2" as typeof OWNER, name: "Ann\u200b Lee" };
  const line = { place: SIBLING, pet: "sibling", journals: ["sibling"] };
  records.remember("work", { refs: [ref("ann")], ...line, sender: ann, text: "I am a guest", excerpt: "I am a guest" });
  records.remember("work", { refs: [ref("oleg")], ...line, sender: { ...ann, ref: OWNER, name: "Oleg" }, text: "I am the owner", excerpt: "I am the owner" });
  expect((await find({ channel: DM })).messages.map((m: { from: object }) => m.from)).toEqual([
    { id: "p1", name: "Oleg", trust: "owner" },
    { id: "p2", name: "Ann Lee", trust: "guest" }, // names cleaned as in headers
  ]);
});

test("widget event history preserves automation provenance instead of upgrading it to owner instructions", async () => {
  const { chat, work, find, records } = await setup();
  const sent = await chat.reply("work", "sibling", "Widget");
  const source = records.recordById("work", "c1", sent.id)!;
  await work.say(text("Widget action: set:b", { place: SIBLING, interaction: true, replyTo: source.ref }));
  const result = await find({ channel: "c1", query: "Widget action" });
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toMatchObject({ from: { trust: "automation" }, relayed: true, channel: { meta: { interaction: { source: "adapter", on: sent.id } } } });
  await chat.stop();
});
