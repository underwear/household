import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openChannels } from "../../src/app/channels";
import { Chat } from "../../src/app/chat";
import { Dialogs } from "../../src/app/dialogs";
import type { SenderRef } from "../../src/core/channel";
import type { ChannelConfig } from "../../src/core/channels";
import type { House } from "../../src/core/household";
import type { MessageDraft } from "../../src/core/message";
import { EventLog } from "../../src/infra/event-log";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { fakeTelegram } from "../fake-telegram";
import { tempDir, waitFor } from "../helpers";

const TOKEN = "123456:secret-part-of-the-token-0000000";
const OLEG = 100200300;
/** How the bot names Oleg. */
const oleg = `telegram.user.${OLEG}` as SenderRef;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

test("a second channel on the same bot is dispatched by chat: one poller, each chat's people, notes and threads its own", async () => {
  const dir = tempDir();
  const records = new SqliteStore(":memory:");
  stops.push(() => records.close());
  const api = fakeTelegram(TOKEN);
  stops.push(api.stop);
  const lines: string[] = [];
  const events = new EventLog(join(dir, "events.jsonl"), (line) => lines.push(line));
  const sent: string[] = [];
  const drafts: MessageDraft[] = [];
  const delivery = {
    send: (house: string, pet: string, draft: MessageDraft) => {
      drafts.push(draft);
      sent.push(`${house}/${pet} ${draft.header?.channel.name} ${draft.place?.split("@")[0]} ${draft.text}`);
      return { activity: "idle" as const, queued: 1 };
    },
    answered: () => {},
      interrupt: async () => ({ status: "idle" as const }),
    reject: () => true,
  };
  const dm: ChannelConfig = { kind: "telegram-private", token: TOKEN, chat: String(OLEG), pets: ["sibling"] };
  const anya: ChannelConfig = { kind: "telegram-private", name: "Vera", token: TOKEN, chat: "777", pets: ["sibling"] };
  const chat = new Chat(delivery, openChannels({ state: records, events, telegramApi: api.url }), events, new Dialogs(events), records);
  stops.push(() => chat.stop());
  const work: House = { name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ name: "sibling", title: "Sibling" }], people: { owners: [{ platform: "telegram", id: String(OLEG) }] }, channels: [dm, anya] };
  await chat.setHouses([work]);

  // Oleg in his chat, Vera in hers with the same bot (a guest of channel Vera), someone else in a chat that is no channel.
  api.push({ message: { message_id: 1, chat: { id: OLEG }, from: { id: OLEG, is_bot: false, first_name: "Oleg" }, text: "how is it?" } });
  api.push({ message: { message_id: 1, chat: { id: 777 }, from: { id: 777, is_bot: false, first_name: "Vera" }, text: "hi" } });
  api.push({ message: { message_id: 1, chat: { id: 999 }, from: { id: 999, is_bot: false, first_name: "Someone" }, text: "let me in" } });
  await waitFor(() => sent.length === 2 && lines.some((line) => line.includes("chat 999 is no channel of this house")));
  expect(sent).toEqual(["work/sibling Telegram Bot DM (threaded) inbox how is it?", "work/sibling Vera inbox hi"]);
  expect(chat.conversation("work", "sibling")!.trust(oleg)).toBe("owner");
  expect(chat.conversation("work", "sibling")!.trust("telegram.user.777" as SenderRef)).toBe("guest");
  // Delivered, Vera's General gets its note, sibling's thread in her chat (made there) what came from it.
  chat.onDelivery({ kind: "delivered", house: "work", pet: "sibling", messages: [{ ...drafts[1]!, id: 2, status: "delivered" }] });
  await waitFor(() => api.sent("sendMessage").some((params) => params.chat_id === 777 && String(params.text).includes("From General")));
  expect(api.sent("createForumTopic")).toHaveLength(2);
  expect(api.sent("createForumTopic")).toEqual(expect.arrayContaining([{ chat_id: OLEG, name: "🤖 Sibling" }, { chat_id: 777, name: "🤖 Sibling" }]));
  expect(api.sent("sendMessage").every((params) => params.chat_id === 777)).toBe(true);
});

test("hot reload with a real bot: a channel added hears at once, one removed stops, another bot reopens it, a token that is no bot's waits for a reload", async () => {
  const dir = tempDir();
  const records = new SqliteStore(":memory:");
  stops.push(() => records.close());
  const OTHER = "654321:the-other-bots-token-000000000";
  const api = fakeTelegram(TOKEN, OTHER);
  stops.push(api.stop);
  const lines: string[] = [];
  const events = new EventLog(join(dir, "events.jsonl"), (line) => lines.push(line));
  const sent: string[] = [];
  const delivery = { send: (_: string, pet: string, draft: MessageDraft) => (sent.push(`${pet} ${draft.text}`), { activity: "idle" as const, queued: 1 }), answered: () => {},
      interrupt: async () => ({ status: "idle" as const }), reject: () => true };
  const chat = new Chat(delivery, openChannels({ state: records, events, telegramApi: api.url }), events, new Dialogs(events), records);
  stops.push(() => chat.stop());
  const house = (channels: ChannelConfig[]): House => ({ name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ name: "sibling" }], people: { owners: [{ platform: "telegram", id: String(OLEG) }] }, channels });
  const dm: ChannelConfig = { kind: "telegram-private", token: TOKEN, chat: String(OLEG), pets: ["sibling"] };
  const from = (chatId: number, text: string, id: number) => ({ message: { message_id: id, chat: { id: chatId }, from: { id: chatId, is_bot: false, first_name: "X" }, text } });
  const polls = (bot: string) => api.calls.filter((call) => call.method === "getUpdates" && call.bot === bot).length;

  await chat.setHouses([house([])]);
  await Bun.sleep(30);
  expect(polls("123456")).toBe(0); // no channel, no poller
  await chat.setHouses([house([dm])]); // added: it hears without a restart
  api.push(from(OLEG, "one", 1));
  await waitFor(() => sent.length === 1);
  await chat.setHouses([house([])]); // removed: its poller stops
  const before = polls("123456");
  api.push(from(OLEG, "two", 2));
  await Bun.sleep(80);
  expect(polls("123456")).toBe(before);
  expect(sent).toEqual(["sibling one"]);

  // Another bot (a token pasted wrong first): not open, says why, and opens on the reload after it is fixed.
  await chat.setHouses([house([{ ...dm, token: "sk-ant-oat01-pasted-wrong" }])]);
  expect(chat.problem("work", "telegram-private:" + OLEG)).toBe("its token is not a bot token (one looks like 123456789:AAH4x…, from @BotFather)");
  const moved = { ...dm, token: OTHER };
  await chat.setHouses([house([moved])]);
  expect(chat.problem("work", "telegram-private:" + OLEG)).toBeUndefined();
  api.push(from(OLEG, "three", 3), OTHER);
  await waitFor(() => sent.length === 2);
  expect(sent.at(-1)).toBe("sibling three");
  expect(polls("123456")).toBe(before); // the first bot stays quiet
  // Back to the first bot: its poller picks up from its own offset (what came meanwhile is heard now).
  await chat.setHouses([house([dm])]);
  await waitFor(() => sent.length === 3);
  expect(sent.at(-1)).toBe("sibling two");
});

test("a bot stays with the house that holds it, whatever the file order says; a second token of a bot is refused", async () => {
  const dir = tempDir();
  const records = new SqliteStore(":memory:");
  stops.push(() => records.close());
  const ROTATED = "123456:a-newer-token-of-the-same-bot0";
  const events = new EventLog(join(dir, "events.jsonl"), () => {});
  const open = openChannels({ state: records, events, telegramApi: "http://127.0.0.1:1" });
  const house = (name: string, ...channels: ChannelConfig[]): House => ({ name, network: { kind: "allowlist", allow: [] }, pets: [], people: { owners: [{ platform: "telegram", id: "1" }] }, channels });
  const channel = (token: string, chat: string): ChannelConfig => ({ kind: "telegram-private", token, chat, pets: [] });
  const first = open([house("work", channel(TOKEN, "1"))]).get("work")!.get("telegram-private:1")!;
  expect(first.channel).toBeDefined();
  // home comes first in the file now, with another token of the same bot: work keeps it, and its very channel.
  const second = open([house("home", channel(ROTATED, "2")), house("work", channel(TOKEN, "1"), channel(ROTATED, "3"))]);
  expect(second.get("home")!.get("telegram-private:2")).toEqual({ problem: "its bot is house work's, and a bot serves one house" });
  expect(second.get("work")!.get("telegram-private:1")!.channel).toBe(first.channel!);
  expect(second.get("work")!.get("telegram-private:3")).toEqual({ problem: "its token is another token of a bot this house already runs: one token per bot" });
  // Once work lets go of it, the bot goes to the first house that names it.
  const third = open([house("home", channel(ROTATED, "2")), house("work")]);
  expect(third.get("home")!.get("telegram-private:2")!.channel).toBeDefined();
});

test("a token that is no bot token (a key pasted by mistake) is never sent to Telegram: the channel says so", () => {
  const dir = tempDir();
  const open = openChannels({ state: new SqliteStore(":memory:"), events: new EventLog(join(dir, "events.jsonl"), () => {}), telegramApi: "http://127.0.0.1:1" });
  const work: House = { name: "work", network: { kind: "allowlist", allow: [] }, pets: [], people: { owners: [{ platform: "telegram", id: "1" }] }, channels: [{ kind: "telegram-private", token: "sk-ant-oat01-not-a-bot-token", chat: "1", pets: [] }] };
  expect(open([work]).get("work")!.get("telegram-private:1")).toEqual({ problem: "its token is not a bot token (one looks like 123456789:AAH4x…, from @BotFather)" });
});

test("Slack opener reuses connections and refuses competing sockets for one app", async () => {
  const records = new SqliteStore(":memory:");
  stops.push(() => records.close());
  const events = new EventLog(join(tempDir(), "slack-events.log"), () => {});
  const open = openChannels({ state: records, events });
  const token = "xoxb-synthetic-00000000000000000";
  const appToken = "xapp-1-ATEST-synthetic-00000000";
  const dm: ChannelConfig = { kind: "slack-private", chat: "TTEST:DONE", token, appToken, pets: [] };
  const make = (channels: ChannelConfig[]): House => ({ name: "lab", network: { kind: "allowlist", allow: [] }, pets: [], people: { owners: [{ platform: "slack", id: "TTEST:UOWNER" }] }, channels });
  const first = open([make([dm])]).get("lab")!.get("slack-private:TTEST:DONE")!;
  const again = open([make([dm])]).get("lab")!.get("slack-private:TTEST:DONE")!;
  expect(first.channel).toBe(again.channel);
  const competing = { ...dm, chat: "TOTHER:DTWO", token: "xoxb-other-synthetic-0000000000", appToken: "xapp-1-ATEST-rotated-0000000000" };
  const result = open([make([dm, competing])]);
  expect(result.get("lab")!.get("slack-private:TOTHER:DTWO")!.problem).toContain("one workspace installation");
  const bad = open([make([{ ...dm, appToken: undefined }])]);
  expect(bad.get("lab")!.get("slack-private:TTEST:DONE")!.problem).toContain("app token");
});
