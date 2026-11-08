import { afterEach, expect, test } from "bun:test";
import { TelegramBot, TelegramChannel, type TelegramBotOptions } from "../../src/channel-adapters/telegram";
import { splitText } from "../../src/channel-adapters/telegram/split";
import { renderStatus } from "../../src/channel-adapters/telegram/status";
import type { Update } from "../../src/channel-adapters/telegram/updates";
import type { FileRef } from "../../src/core/attachment";
import { DownloadRefused, RateLimited, StatusGone, type External, type InboundMessage, type MessageRef, type PostRef, type SenderRef } from "../../src/core/channel";
import { fakeTelegram } from "../fake-telegram";
import { waitFor } from "../helpers";

const TOKEN = "123456:secret-part-of-the-token";
const OWNER = 100200300;
const sibling = { id: "c1", kind: "pet-thread" as const, title: "🐾 Sibling" };
const inbox = { id: "c2", kind: "house-inbox" as const, title: "General" };
/** How the channel refers to message `id` of its chat (and to one version of an edited one). */
const ref = (id: number, editDate?: number) => `telegram.123456.${OWNER}.${id}${editDate ? `.${editDate}` : ""}` as MessageRef;
const OLEG = { id: OWNER, is_bot: false, first_name: "Oleg", username: "oleg" };
const fromOwner = (fields: object, id = 1) => ({ message_id: id, chat: { id: OWNER }, from: OLEG, ...fields });
/** The sender and external facts every owner message in the General carries. */
const owner = { from: { ref: `telegram.user.${OWNER}` as SenderRef, name: "Oleg" } };
// A private chat's id is its user's, so no `chat`.
const facts = (id: number, more: { forward?: Record<string, unknown>; edited?: number } = {}) => {
  const { name, username, date } = more.forward ?? {};
  const forward = more.forward && Object.fromEntries(Object.entries({ name, username, date }).filter(([, value]) => value !== undefined));
  // What is context is shown (the username, who a forward is from); every fact is kept.
  return { external: { username: "oleg", ...(forward ? { forward } : {}) } as External, kept: { message: id, user: OWNER, username: "oleg", ...more } as External };
};

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

function setup(options: Partial<TelegramBotOptions> = {}) {
  const api = fakeTelegram(TOKEN);
  const state = new Map<string, string>();
  const lines: string[] = [];
  const log = { info: (line: string) => lines.push(line), error: (line: string) => lines.push(`ERROR ${line}`) };
  const received: InboundMessage[] = [];
  /** A bot as the daemon makes one (one poller), for the chats given (the owner's private chat unless said). */
  const bot = () =>
    new TelegramBot({
      name: "house work", token: TOKEN, log, apiBase: api.url, retryMs: 10, pollSeconds: 1,
      state: { get: (key) => state.get(key), set: (key, value) => void state.set(key, value) },
      ...options,
    });
  /** The owner's private chat with a bot of its own. */
  const open = (chat = OWNER, on = bot()) => {
    const channel = new TelegramChannel(on, chat, "house work");
    stops.push(() => channel.stop());
    return channel;
  };
  stops.push(api.stop);
  const listen = (channel: TelegramChannel, handler = async (message: InboundMessage) => void received.push(message)) => {
    channel.start(handler);
    return channel;
  };
  return { api, state, lines, received, open, listen, bot };
}

test("the channel's chat arrives; any other chat is ignored, one log line for each; the offset survives a restart", async () => {
  const { api, lines, received, open, listen } = setup();
  api.push({ message: fromOwner({ text: "hello" }, 7) });
  api.push({ message: { message_id: 8, chat: { id: 666 }, from: { id: 666, is_bot: false }, text: "let me in" } });
  api.push({ message: { message_id: 9, chat: { id: 666 }, from: { id: 666, is_bot: false }, text: "please" } });
  api.push({ callback_query: { id: "q", from: { id: 666, first_name: "Eve" }, message: { message_id: 1, chat: { id: 666 } }, data: "0" } });
  const first = listen(open());
  await waitFor(() => received.length === 1);
  await waitFor(() => api.sent("answerCallbackQuery").length === 1); // a press elsewhere is still answered
  expect(lines.filter((line) => line.includes("chat 666 is no channel of this house: its updates are ignored"))).toHaveLength(1);
  await first.stop();
  expect(received).toEqual([{ kind: "text", ref: ref(7), ...owner, ...facts(7), text: "hello" }]);

  api.push({ message: fromOwner({ text: "more" }, 9) });
  listen(open());
  await waitFor(() => received.length === 2);
  await Bun.sleep(50);
  expect(received.map((message) => message.ref)).toEqual([ref(7), ref(9)]);
  expect(api.sent("getUpdates").at(-1)).toMatchObject({ offset: 6, allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"] });
});

test("two channels on one bot: one poller, each chat's updates to its channel, each chat's refs and threads its own", async () => {
  const { api, state, open, bot } = setup();
  const shared = bot();
  const [mine, hers] = [open(OWNER, shared), open(777, shared)];
  const got: Record<string, string[]> = { mine: [], hers: [] };
  mine.start(async (message) => void got.mine!.push(message.ref));
  hers.start(async (message) => void got.hers!.push(message.ref));
  api.push({ message: fromOwner({ text: "me" }, 1) });
  api.push({ message: { message_id: 1, chat: { id: 777 }, from: { id: 777, is_bot: false, first_name: "Vera" }, text: "me too" } });
  await waitFor(() => got.mine!.length === 1 && got.hers!.length === 1);
  expect(got).toEqual({ mine: [ref(1)], hers: ["telegram.123456.777.1"] });
  await Promise.all([mine.post(sibling, "a"), hers.post(sibling, "b")]); // one place id, two chats: a thread in each
  expect(api.sent("createForumTopic").map((params) => params.chat_id as number).sort((a, b) => a - b)).toEqual([777, OWNER]);
  expect(state.get("telegram.123456.777.thread.c1")).toBeDefined();
  // One channel stops: the other still hears its chat; the last one stops the poller.
  await mine.stop();
  api.push({ message: { message_id: 2, chat: { id: 777 }, from: { id: 777, is_bot: false }, text: "more" } });
  await waitFor(() => got.hers!.length === 2);
  await hers.stop();
  const polls = api.sent("getUpdates").length;
  await Bun.sleep(50);
  expect(api.sent("getUpdates").length).toBe(polls);
  // A reload reopens a chat: the new channel, made while the old one runs, takes nothing from it until started.
  const reopened: string[] = [];
  const old = open(777, shared);
  old.start(async (message) => void reopened.push(`old ${message.ref}`));
  const fresh = open(777, shared);
  api.push({ message: { message_id: 3, chat: { id: 777 }, from: { id: 777, is_bot: false }, text: "more for the old one" } });
  await waitFor(() => reopened.length === 1);
  expect(() => fresh.start(async () => {})).toThrow("chat 777 is a channel of this bot already"); // one chat, one channel
  await old.stop();
  fresh.start(async (message) => void reopened.push(`fresh ${message.ref}`));
  api.push({ message: { message_id: 4, chat: { id: 777 }, from: { id: 777, is_bot: false }, text: "for the new one" } });
  await waitFor(() => reopened.length === 2);
  expect(reopened).toEqual(["old telegram.123456.777.3", "fresh telegram.123456.777.4"]);
  await fresh.stop();
  expect(mine.isSender("telegram.user.777" as SenderRef, "777")).toBe(true); // a Telegram user id is the same in every chat
  expect(mine.isSender("telegram.user.777" as SenderRef, "+777")).toBe(false);
});

test("a reply names the message it quotes; the thread's own first message, which every message in it seems to answer, is no quote", async () => {
  const { api, received, open, listen } = setup();
  listen(open());
  api.push({ message: fromOwner({ text: "yes", reply_to_message: { message_id: 40, chat: { id: OWNER } } }, 1) });
  api.push({ message: fromOwner({ text: "in the thread", message_thread_id: 100, is_topic_message: true, reply_to_message: { message_id: 100, chat: { id: OWNER }, forum_topic_created: {} } }, 2) });
  await waitFor(() => received.length === 2);
  expect(received.map((message) => (message.kind === "text" ? message.replyTo : "?"))).toEqual([`telegram.123456.${OWNER}.40` as PostRef, undefined]);
});

test("a press is answered once Household has taken it, with what Household says to the one who pressed", async () => {
  const { api, open } = setup();
  const channel = open();
  channel.start(async (message) => (message.kind === "choice" ? "Only the owner can answer" : undefined));
  const keyboard = { inline_keyboard: [[{ text: "Yes", callback_data: "0" }]] };
  api.push({ callback_query: { id: "g1", from: { id: 777, first_name: "Vera" }, message: { message_id: 7, chat: { id: OWNER }, text: "?", reply_markup: keyboard }, data: "0" } });
  await waitFor(() => api.sent("answerCallbackQuery").length === 1);
  expect(api.sent("answerCallbackQuery")).toEqual([{ callback_query_id: "g1", text: "Only the owner can answer" }]);
});

test("polling outlives 409 and other failures, with one log line per kind; a failing handler does not stop it", async () => {
  const { api, lines, open, listen } = setup();
  api.fail("getUpdates", 409, "Conflict: terminated by other getUpdates request", 3);
  api.fail("getUpdates", 502, "Bad Gateway");
  api.push({ message: fromOwner({ text: "one" }, 1) });
  api.push({ message: fromOwner({ text: "two" }, 2) });
  const taken: string[] = [];
  listen(open(), async (message) => {
    if (message.ref === ref(1)) throw new Error("disk full");
    taken.push(message.ref);
  });
  await waitFor(() => taken.length === 1);
  expect(lines.filter((line) => line.includes("409"))).toEqual([
    "ERROR telegram house work: polling failed (getUpdates: 409 Conflict: terminated by other getUpdates request), another client polls this bot; retrying",
  ]);
  expect(lines.filter((line) => line.includes("502"))).toHaveLength(1);
  expect(lines).toContain("telegram house work: polling again");
  expect(lines).toContain("ERROR telegram house work: update 1 was not taken: disk full");
  const offsets = api.sent("getUpdates").map((params) => params.offset);
  expect(offsets.slice(0, 4)).toEqual([0, 0, 0, 0]); // failed polls confirm nothing
});

test("polling survives its own store and log failing: it waits, and the update comes again", async () => {
  let failSaves = 2;
  let failLogs = 1;
  const state = new Map<string, string>();
  const { api, received, listen, open } = setup({
    state: {
      get: (key) => state.get(key),
      set: (key, value) => {
        if (failSaves-- > 0) throw new Error("database is locked");
        state.set(key, value);
      },
    },
    log: {
      info: () => {},
      error: () => {
        if (failLogs-- > 0) throw new Error("disk full");
      },
    },
  });
  api.push({ message: fromOwner({ text: "x" }, 1) });
  listen(open());
  await waitFor(() => [...state.values()].includes("2"));
  expect(received.map((message) => message.ref)).toEqual([ref(1), ref(1), ref(1)]); // the receiver drops repeats
});

test("a channel stopped while handling takes no further update", async () => {
  const { api, state, open } = setup();
  api.push({ message: fromOwner({ text: "one" }, 1) });
  api.push({ message: fromOwner({ text: "two" }, 2) });
  const channel = open();
  const taken: string[] = [];
  channel.start(async (message) => {
    taken.push(message.ref);
    void channel.stop();
  });
  await waitFor(() => taken.length > 0);
  await channel.stop();
  expect(taken).toEqual([ref(1)]);
  expect(state.get("telegram.123456.offset")).toBe("2"); // the one it took is confirmed, the next is not
});

test("429 waits as long as Telegram asks", async () => {
  const { api, received, open, listen } = setup();
  api.fail("getUpdates", 429, "Too Many Requests: retry after 1", 1, 1);
  api.push({ message: fromOwner({ text: "x" }) });
  const started = Date.now();
  listen(open());
  await waitFor(() => received.length === 1, 3000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
});

test("a place's thread is made once, on first need, named with its title; a message in it is for that place", async () => {
  const { api, state, received, open, listen } = setup();
  const channel = listen(open());
  await Promise.all([channel.post(sibling, "one"), channel.post(sibling, "two")]);
  expect(api.sent("createForumTopic")).toEqual([{ chat_id: OWNER, name: "🐾 Sibling" }]);
  expect(api.sent("sendMessage").map((params) => [params.message_thread_id, params.text])).toEqual([[100, "one"], [100, "two"]]);

  api.push({ message: fromOwner({ text: "in the thread", message_thread_id: 100, is_topic_message: true }) });
  api.push({ message: fromOwner({ text: "in someone else's thread", message_thread_id: 55, is_topic_message: true }, 2) });
  await waitFor(() => received.length === 2);
  expect(received.map((message) => [message.place, message.kept?.thread])).toEqual([["c1", 100], [undefined, 55]]);

  await channel.stop();
  await open().post(sibling, "after a restart");
  expect(api.sent("createForumTopic")).toHaveLength(1); // the thread id is in the state
  expect([...state.keys()].some((key) => key.includes(TOKEN.split(":")[1]!))).toBe(false); // keys use the bot id only
  expect(state.get(`telegram.123456.${OWNER}.thread.c1`)).toBe("100"); // kept by the place's id
});

test("a new title renames the place's thread (once); nothing is renamed before there is a thread; a new thread gets the new title", async () => {
  const { api, state, lines, open } = setup();
  const channel = open();
  const owl = { ...sibling, title: "🦉 Sibling" };
  await channel.retitle({ ...sibling, id: "c9", title: "🦉 Nobody" }); // no thread yet: nothing to rename, none made
  expect(api.calls.map((call) => call.method)).toEqual([]);
  await channel.retitle(sibling);
  await channel.post(sibling, "one");
  await channel.retitle(sibling); // the title it has
  expect(api.sent("editForumTopic")).toEqual([]);
  await channel.retitle(owl);
  await channel.retitle(owl);
  expect(api.sent("editForumTopic")).toEqual([{ chat_id: OWNER, message_thread_id: 100, name: "🦉 Sibling" }]);
  expect(api.topics.get(`${OWNER}/100`)).toBe("🦉 Sibling");
  expect(lines).toContain("telegram house work: thread for c1 renamed");
  await channel.post(owl, "two");
  expect(api.sent("createForumTopic")).toHaveLength(1); // the same thread, never a new one
  await channel.post({ id: "c3", kind: "pet-thread", title: "👩‍💻 Chair" }, "three");
  expect(api.sent("createForumTopic").at(-1)).toEqual({ chat_id: OWNER, name: "👩‍💻 Chair" });

  // A thread made before titles were kept: renamed to what it is is no change, and no error.
  state.delete(`telegram.123456.${OWNER}.title.c1`);
  await channel.retitle(owl);
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([]);
  await channel.retitle(owl);
  expect(api.sent("editForumTopic")).toHaveLength(2);
});

test("renames go one at a time, each to the title wanted when its turn comes: A → B → A ends at A; one asked for while the thread is made follows it", async () => {
  const { api, open } = setup();
  const channel = open();
  await channel.post(sibling, "one");
  await Promise.all([channel.retitle({ ...sibling, title: "🦉 Sibling" }), channel.retitle(sibling)]);
  expect(api.sent("editForumTopic")).toEqual([]); // back where it was before its turn came
  const fox = { id: "c3", kind: "pet-thread" as const, title: "🦊 Chair" };
  const posting = channel.post({ ...fox, title: "🐾 Chair" }, "two"); // the thread is being made under the old title
  await channel.retitle(fox);
  await posting;
  expect(api.sent("createForumTopic").at(-1)).toEqual({ chat_id: OWNER, name: "🐾 Chair" });
  expect(api.topics.get(`${OWNER}/101`)).toBe("🦊 Chair");
});

test("a refused rename is logged once and the thread keeps its name; 429 is waited out; 403 and the like are tried again on the next reload", async () => {
  const { api, lines, open } = setup();
  const channel = open();
  await channel.post(sibling, "one");
  api.fail("editForumTopic", 400, "Bad Request: not enough rights to manage topics");
  await channel.retitle({ ...sibling, title: "🦉 Sibling" });
  await channel.retitle({ ...sibling, title: "🦉 Sibling" });
  expect(api.sent("editForumTopic")).toHaveLength(1);
  expect(lines.filter((line) => line.startsWith("ERROR"))).toEqual([
    "ERROR telegram house work: thread for c1 not renamed (editForumTopic: 400 Bad Request: not enough rights to manage topics); it keeps its name",
  ]);
  await channel.post({ ...sibling, title: "🦉 Sibling" }, "two");
  expect(api.sent("createForumTopic")).toHaveLength(1); // never a new thread for it
  expect(api.topics.get(`${OWNER}/100`)).toBe("🐾 Sibling");

  api.fail("editForumTopic", 429, "Too Many Requests: retry after 1", 1, 1);
  const started = Date.now();
  await channel.retitle({ ...sibling, title: "🦊 Sibling" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(api.topics.get(`${OWNER}/100`)).toBe("🦊 Sibling");

  for (const [code, description] of [[403, "Forbidden: bot was blocked by the user"], [502, "Bad Gateway"], [400, "Bad Request: message thread not found"]] as const) {
    const before = api.sent("editForumTopic").length;
    api.fail("editForumTopic", code, description);
    await channel.retitle({ ...sibling, title: `🦭 Sibling ${code}` });
    expect(lines.at(-1)).toEndWith("tried again later");
    await channel.post(sibling, "three"); // a use soon after does not try it again at once
    expect(api.sent("editForumTopic")).toHaveLength(before + 1);
    await channel.retitle({ ...sibling, title: `🦭 Sibling ${code}` }); // the next reload does
    expect(api.topics.get(`${OWNER}/100`)).toBe(`🦭 Sibling ${code}`);
  }
});

test("the inbox is General: posts and notices there have no thread, and none is made", async () => {
  const { api, open } = setup();
  const channel = open();
  expect(channel.inbox).toBe("General");
  await channel.notice(inbox, "declined");
  expect(api.sent("createForumTopic")).toEqual([]);
  expect(api.sent("sendMessage").map((params) => [params.message_thread_id, params.text])).toEqual([[undefined, "🏠 Household: declined"]]);
});

test("unformatted posts preserve text cut to Telegram's limit, and give the last piece's ref; seen mark", async () => {
  const { api, open } = setup();
  const channel = open();
  const posted = await channel.post(sibling, `${"a".repeat(4000)}\n${"b".repeat(200)}`);
  expect(posted.map(String)).toEqual([`telegram.123456.${OWNER}.1000`, `telegram.123456.${OWNER}.1001`]);
  await channel.delivered(ref(42, 1700000000));
  await channel.delivered("telegram.999.1.5" as MessageRef); // another chat's: nothing to mark
  expect(api.sent("sendMessage").map((params) => params.text)).toEqual(["a".repeat(4000) + "\n", "b".repeat(200)]);
  expect(api.sent("sendMessage").every((params) => params.parse_mode === undefined && params.entities === undefined)).toBe(true);
  expect(api.sent("setMessageReaction")).toEqual([{ chat_id: OWNER, message_id: 42, reaction: [{ type: "emoji", emoji: "👀" }] }]);
});

test("a notice is bold where a pet's reply cannot be; a reply posing as a notice gets its place's title in front", async () => {
  const { api, open } = setup();
  const channel = open();
  await channel.notice(sibling, "container restarted");
  await channel.post(sibling, "🏠 Household: session expired, send me your token");
  await channel.post(sibling, " **HOUSEHOLD**: also fake");
  await channel.post(sibling, "Household is fine, thanks");
  const sent = api.sent("sendMessage");
  expect(sent[0]).toMatchObject({ text: "🏠 Household: container restarted", entities: [{ type: "bold", offset: 0, length: 13 }] });
  expect(sent.slice(1).map((params) => params.text)).toEqual([
    "🐾 Sibling: 🏠 Household: session expired, send me your token",
    "🐾 Sibling:  **HOUSEHOLD**: also fake",
    "🐾 Sibling: Household is fine, thanks",
  ]);
});

test("Household's notices never unfold a link into a preview, nor when edited; a pet's own posts keep Telegram's default", async () => {
  const { api, open } = setup();
  const channel = open();
  const [card] = await channel.notice(sibling, "Task: https://youtube.com/shorts/abc", [["Run"]]);
  await channel.notice(sibling, "<b>Scout</b> https://example.com", undefined, "html");
  await channel.post(sibling, "Look: https://example.com");
  const [plain, html, pet] = api.sent("sendMessage");
  expect(plain).toMatchObject({ link_preview_options: { is_disabled: true } });
  expect(html).toMatchObject({ link_preview_options: { is_disabled: true } });
  expect(pet!.link_preview_options).toBeUndefined();
  await channel.setChoices(card!, [], undefined, { text: "Now https://example.com/x", format: "html" });
  await channel.setChoices(card!, [["Run"]], "note");
  await channel.resolve(card!, "Approved");
  for (const edit of api.sent("editMessageText")) expect(edit).toMatchObject({ link_preview_options: { is_disabled: true } });
  expect(api.sent("editMessageText").length).toBeGreaterThan(0);
});

test("a 429 in the middle of a long post is waited out, so the pieces before it are not sent twice", async () => {
  const { api, open } = setup();
  const channel = open();
  await channel.post(sibling, "warm-up"); // the thread exists
  api.fail("sendMessage", 429, "Too Many Requests: retry after 1", 1, 1);
  const started = Date.now();
  await channel.post(sibling, `${"a".repeat(4000)}\n${"b".repeat(200)}`);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(api.sent("sendMessage").map((params) => String(params.text).slice(0, 3))).toEqual(["war", "aaa", "aaa", "bbb"]);
  api.fail("sendMessage", 400, "Bad Request: chat not found");
  await expect(channel.post(sibling, "x")).rejects.toThrow("sendMessage: 400 Bad Request: chat not found");
});

test("edits (each version its own ref), forwards, non-text content, the bot's own service messages and /start", async () => {
  const { api, received, open, listen } = setup();
  api.push({ message: fromOwner({ text: "/start" }, 1) });
  api.push({ message: { message_id: 2, chat: { id: OWNER }, from: { id: 1, is_bot: true }, forum_topic_created: { name: "🐾 Sibling" } } });
  api.push({ message: fromOwner({ poll: { question: "?" } }, 3) });
  api.push({ message: fromOwner({ dice: { emoji: "🎲", value: 3 } }, 4) });
  api.push({ message: fromOwner({ pinned_message: {} }, 5) });
  api.push({ edited_message: fromOwner({ text: "corrected", edit_date: 1700000000 }, 6) });
  const user = { type: "user", date: 5, sender_user: { id: 66, first_name: "Ann", last_name: "Lee", username: "ann" } } as const;
  api.push({ message: fromOwner({ text: "buy this", forward_origin: user }, 7) });
  const channel = { type: "channel", date: 6, chat: { id: -100, title: "News" }, message_id: 77 } as const;
  api.push({ message: fromOwner({ text: "news item", forward_origin: channel }, 8) });
  api.push({ message: fromOwner({ text: "secret", forward_origin: { type: "hidden_user", date: 7, sender_user_name: "Someone" } }, 9) });
  listen(open());
  await waitFor(() => received.length === 6);
  await Bun.sleep(50);
  expect(received).toEqual([
    { kind: "unsupported", ref: ref(3), ...owner, ...facts(3), what: "poll" },
    { kind: "unsupported", ref: ref(4), ...owner, ...facts(4), what: "dice" },
    { kind: "text", ref: ref(6, 1700000000), ...owner, ...facts(6, { edited: 1700000000 }), text: "corrected", edits: ref(6) },
    { kind: "text", ref: ref(7), ...owner, ...facts(7, { forward: { name: "Ann Lee", user: 66, username: "ann", date: 5 } }), text: "buy this", relayed: true },
    { kind: "text", ref: ref(8), ...owner, ...facts(8, { forward: { name: "News", chat: -100, message: 77, date: 6 } }), text: "news item", relayed: true },
    { kind: "text", ref: ref(9), ...owner, ...facts(9, { forward: { name: "Someone", date: 7 } }), text: "secret", relayed: true },
  ]);
});

test("every kind of file comes as text (its caption) with its attachment; a place and a contact as text; an album as messages of its own", async () => {
  const { api, received, open, listen } = setup();
  const sizes = [{ file_id: "small", width: 90, height: 60, file_size: 1_000 }, { file_id: "large", width: 1280, height: 853, file_size: 90_000 }, { file_id: "mid", width: 320, height: 213 }];
  api.push({ message: fromOwner({ photo: sizes, caption: "look" }, 1) });
  api.push({ message: fromOwner({ document: { file_id: "doc", file_name: "reçu.pdf", mime_type: "application/pdf", file_size: 2_048 } }, 2) });
  api.push({ message: fromOwner({ voice: { file_id: "voice", duration: 4, mime_type: "audio/ogg", file_size: 9_000 } }, 3) });
  api.push({ message: fromOwner({ audio: { file_id: "audio", duration: 200, performer: "Kino", title: "Blood Type", mime_type: "audio/mpeg" } }, 4) });
  api.push({ message: fromOwner({ video: { file_id: "video", width: 1, height: 1, duration: 12, file_name: "clip.mov", mime_type: "video/quicktime" }, caption: "here" }, 5) });
  api.push({ message: fromOwner({ video_note: { file_id: "round", length: 240, duration: 7, file_size: 300_000 } }, 6) });
  const gif = { file_id: "gif", width: 1, height: 1, duration: 2, file_name: "cat.mp4", mime_type: "video/mp4" };
  api.push({ message: fromOwner({ animation: gif, document: { file_id: "gif", file_name: "cat.mp4", mime_type: "video/mp4" } }, 7) });
  api.push({ message: fromOwner({ sticker: { file_id: "sticker", emoji: "🐱", is_animated: true, is_video: false } }, 8) });
  api.push({ message: fromOwner({ location: { latitude: 41.3851, longitude: 2.1734 } }, 9) });
  api.push({ message: fromOwner({ venue: { location: { latitude: 41.4036, longitude: 2.1744 }, title: "Sagrada Família", address: "C/ de Mallorca, 401" }, location: { latitude: 41.4036, longitude: 2.1744 } }, 10) });
  api.push({ message: fromOwner({ contact: { phone_number: "+34600000000", first_name: "Vera", last_name: "K" } }, 11) });
  api.push({ message: fromOwner({ media_group_id: "album", photo: [{ file_id: "a1", width: 10, height: 10 }], caption: "vacation" }, 12) });
  api.push({ message: fromOwner({ media_group_id: "album", photo: [{ file_id: "a2", width: 10, height: 10 }] }, 13) });
  api.push({ message: fromOwner({ photo: [{ file_id: "fwd", width: 10, height: 10 }], forward_origin: { type: "hidden_user", date: 7, sender_user_name: "Someone" } }, 14) });
  listen(open());
  await waitFor(() => received.length === 14);
  const text = (id: number, body: string, attachments?: object[], more: object = {}): InboundMessage =>
    ({ kind: "text", ref: ref(id), ...owner, ...facts(id, more), text: body, ...(attachments ? { attachments } : {}) }) as InboundMessage;
  expect(received).toEqual([
    text(1, "look", [{ kind: "photo", file: "large", mime: "image/jpeg", size: 90_000 }]),
    text(2, "", [{ kind: "document", file: "doc", name: "reçu.pdf", mime: "application/pdf", size: 2_048 }]),
    text(3, "", [{ kind: "voice", file: "voice", mime: "audio/ogg", size: 9_000, duration: 4 }]),
    text(4, "", [{ kind: "audio", file: "audio", name: "Kino — Blood Type", mime: "audio/mpeg", duration: 200 }]),
    text(5, "here", [{ kind: "video", file: "video", name: "clip.mov", mime: "video/quicktime", duration: 12 }]),
    text(6, "", [{ kind: "video-note", file: "round", mime: "video/mp4", size: 300_000, duration: 7 }]),
    text(7, "", [{ kind: "animation", file: "gif", name: "cat.mp4", mime: "video/mp4", duration: 2 }]),
    text(8, "", [{ kind: "sticker", file: "sticker", mime: "application/x-tgsticker", emoji: "🐱" }]),
    text(9, "location: 41.3851, 2.1734"),
    text(10, "venue: Sagrada Família, C/ de Mallorca, 401 (41.4036, 2.1744)"),
    text(11, "contact: Vera K, +34600000000"),
    // Album: each file a message of its own (they go to the pet as one batch); its id kept for debugging only.
    text(12, "vacation", [{ kind: "photo", file: "a1", mime: "image/jpeg" }], { album: "album" }),
    text(13, "", [{ kind: "photo", file: "a2", mime: "image/jpeg" }], { album: "album" }),
    { ...text(14, "", [{ kind: "photo", file: "fwd", mime: "image/jpeg" }], { forward: { name: "Someone", date: 7 } }), relayed: true } as InboundMessage,
  ]);
});

test("a file is downloaded with the bot's token, which no failure shows; one over Telegram's 20 MB, or refused, is refused for good", async () => {
  const { api, open } = setup();
  const channel = open();
  const signal = new AbortController().signal;
  const photo = { kind: "photo" as const, file: "large" as FileRef };
  api.file("large", new Uint8Array([1, 2, 3]), "photos/file_7.jpg");
  expect([...(await channel.download(photo, signal))]).toEqual([1, 2, 3]);
  expect(api.calls.filter(({ method }) => method === "getFile" || method === "file").map(({ method, params }) => [method, params])).toEqual([
    ["getFile", { file_id: "large" }],
    ["file", { path: "photos/file_7.jpg" }],
  ]);
  // Over 20 MB by what the update said: refused before anything is asked.
  const calls = api.calls.length;
  await expect(channel.download({ ...photo, size: 21 * 1024 * 1024 }, signal)).rejects.toThrow(new DownloadRefused("over 20 MB, and Telegram does not give bots larger files"));
  expect(api.calls.length).toBe(calls);
  api.fail("getFile", 400, "Bad Request: file is too big");
  await expect(channel.download(photo, signal)).rejects.toBeInstanceOf(DownloadRefused);
  await expect(channel.download({ ...photo, file: "unknown" as FileRef }, signal)).rejects.toThrow(new DownloadRefused("Telegram refused (getFile: 400 Bad Request: invalid file_id)"));
  // Telegram's own trouble passes: tried again by Household, not refused here.
  api.fail("file", 502, "Bad Gateway");
  const passing = await channel.download(photo, signal).catch((error) => error);
  expect(passing).not.toBeInstanceOf(DownloadRefused);
  expect(passing.message).toBe("file: 502 refused");
  api.fail("getFile", 429, "Too Many Requests", 1, 1);
  expect(await channel.download(photo, signal).catch((error) => error)).not.toBeInstanceOf(DownloadRefused);
  const unreachable = setup({ apiBase: "http://127.0.0.1:1" }).open();
  const error = await unreachable.download(photo, signal).catch((failure) => failure);
  expect(error.message).toBe("getFile: unreachable");
  expect(error.message.includes(TOKEN)).toBe(false);
});

test("a failed call says which method and why, and never shows the token", async () => {
  const { lines, open, listen } = setup({ apiBase: "http://127.0.0.1:1" });
  const channel = listen(open());
  await expect(channel.post(sibling, "x")).rejects.toThrow("createForumTopic: unreachable");
  await waitFor(() => lines.length > 0);
  expect(lines[0]).toBe("ERROR telegram house work: polling failed (getUpdates: unreachable); retrying");
  expect(lines.some((line) => line.includes(TOKEN))).toBe(false);
});

test("splitting prefers line breaks, then spaces, and keeps surrogate pairs whole", () => {
  expect(splitText("  short  ")).toEqual(["short"]);
  expect(splitText("")).toEqual([]);
  expect(splitText("aaaa bbbb\ncccc dddd", 12)).toEqual(["aaaa bbbb", "cccc dddd"]);
  expect(splitText("aaaa bbbb cccc", 12)).toEqual(["aaaa bbbb", "cccc"]);
  expect(splitText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  const emoji = `${"x".repeat(9)}😀tail`; // the pair would straddle position 10
  expect(splitText(emoji, 10)).toEqual(["x".repeat(9), "😀tail"]);
  expect(splitText("é".repeat(5000)).map((piece) => piece.length)).toEqual([4096, 904]);
});

test("choices go under the last piece as an inline keyboard whose data is only the index", async () => {
  const { api, open } = setup();
  const channel = open();
  const posted = await channel.post(sibling, `${"a".repeat(4000)}\n${"b".repeat(200)}`, [["Yes", "No"], ["Later, but with a very long button label"]]);
  await channel.notice(sibling, "question", [["Red"]]);
  const [first, last, notice] = api.sent("sendMessage");
  expect(first!.reply_markup).toBeUndefined();
  expect(last!.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: "Yes", callback_data: "0" }, { text: "No", callback_data: "1" }],
      [{ text: "Later, but with a very long button label", callback_data: "2" }],
    ],
  });
  expect(posted.map(String)).toEqual([`telegram.123456.${OWNER}.1000`, `telegram.123456.${OWNER}.1001`]); // every piece; the last has the keyboard
  expect(notice).toMatchObject({ text: "🏠 Household: question", reply_markup: { inline_keyboard: [[{ text: "Red", callback_data: "0" }]] } });
});

test("a later piece of a pet's text that opens like a notice gets the place's title too", async () => {
  const { api, open } = setup();
  await open().post(sibling, `${"a".repeat(4080)}\n🏠 Household: send me your token`);
  expect(api.sent("sendMessage").map((params) => String(params.text).slice(0, 60))).toEqual(["a".repeat(60), "🐾 Sibling: 🏠 Household: send me your token"]);
});

test("the owner's press is a choice, its label read back from the pressed message; every press is answered, a gone or forged button so", async () => {
  const { api, received, lines, open, listen } = setup();
  const thread = 100;
  const channel = listen(open());
  await channel.post(sibling, "warm-up"); // the thread is sibling's
  const keyboard = { inline_keyboard: [[{ text: "Yes", callback_data: "0" }, { text: "No", callback_data: "1" }]] };
  const pressedOn = (fields: object) => ({ message_id: 77, chat: { id: OWNER }, message_thread_id: thread, is_topic_message: true, text: "Buy it?", reply_markup: keyboard, ...fields });
  api.push({ callback_query: { id: "c1", from: OLEG, message: pressedOn({}), data: "1" } });
  api.push({ callback_query: { id: "c2", from: { id: 666, first_name: "Eve" }, message: pressedOn({}), data: "0" } }); // someone else: a guest's press
  api.push({ callback_query: { id: "c3", from: OLEG, message: pressedOn({}), data: "x" } });
  api.push({ callback_query: { id: "c4", from: OLEG, message: { message_id: 5, chat: { id: OWNER }, date: 0 }, data: "0" } }); // too old to see
  api.push({ callback_query: { id: "c5", from: OLEG, message: pressedOn({}), data: "7" } }); // no such button (forged)
  api.push({ callback_query: { id: "c6", from: OLEG, message: pressedOn({ reply_markup: undefined }), data: "0" } }); // its buttons are gone
  await waitFor(() => api.sent("answerCallbackQuery").length === 6);
  await waitFor(() => received.length === 2);
  expect(received[1]).toMatchObject({ kind: "choice", from: { ref: "telegram.user.666", name: "Eve" }, index: 0, label: "Yes" });
  expect(received.slice(0, 1)).toEqual([
    {
      kind: "choice",
      ref: `telegram.123456.${OWNER}.press.c1` as MessageRef,
      place: "c1",
      ...owner,
      external: { username: "oleg" },
      kept: { thread, user: OWNER, username: "oleg" },
      answersTo: `telegram.123456.${OWNER}.77` as PostRef,
      index: 1,
      label: "No",
    },
  ]);
  const inactive = "This button is no longer active";
  expect(api.sent("answerCallbackQuery")).toEqual([
    { callback_query_id: "c1" },
    { callback_query_id: "c2" },
    { callback_query_id: "c3", text: inactive },
    { callback_query_id: "c4", text: inactive },
    { callback_query_id: "c5", text: inactive },
    { callback_query_id: "c6", text: inactive },
  ]);
  expect(api.sent("editMessageText")).toEqual([]); // nothing passed over is touched
  for (const why of ["a press on a button Household did not make", "a press on a button the message does not have (any more)"]) {
    expect(lines.some((line) => line.includes(`skipped (${why})`))).toBe(true);
  }
  await channel.delivered(received[0]!.ref); // a press is no message to mark
  expect(api.sent("setMessageReaction")).toEqual([]);
  // Resolving it writes the outcome under the text Telegram sent with the press (here, after a restart of sorts).
  await channel.resolve((received[0] as Extract<InboundMessage, { kind: "choice" }>).answersTo, "No");
  expect(api.sent("editMessageText")).toEqual([{ chat_id: OWNER, message_id: 77, text: "Buy it?\n\n→ No" }]);
});

test("a notice's choices can change; resolving removes them and writes the outcome under its text, bold prefix kept", async () => {
  const { api, open } = setup();
  const channel = open();
  const card = (await channel.notice(sibling, "which ones?", [["A"], ["B"], ["Done"]]))[0]!;
  await channel.setChoices(card, [["✓ A"], ["B"], ["Done"]]);
  await channel.resolve(card, "A");
  const message_id = Number(String(card).split(".").at(-1));
  expect(api.sent("editMessageReplyMarkup")).toEqual([
    { chat_id: OWNER, message_id, reply_markup: { inline_keyboard: [[{ text: "✓ A", callback_data: "0" }], [{ text: "B", callback_data: "1" }], [{ text: "Done", callback_data: "2" }]] } },
  ]);
  expect(api.sent("editMessageText")).toEqual([
    { chat_id: OWNER, message_id, text: "🏠 Household: which ones?\n\n→ A", entities: [{ type: "bold", offset: 0, length: 13 }], link_preview_options: { is_disabled: true } },
  ]);
  // Its text no longer known (resolved once), or too long for the outcome: the buttons only go.
  api.fail("editMessageReplyMarkup", 400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same");
  await channel.resolve(card, "A"); // taken twice: fine
  const long = (await channel.post(sibling, "x".repeat(4084), [["ok"]]))[0]!; // one piece, with room for the title
  await channel.resolve(long, "y".repeat(20));
  expect(api.sent("editMessageReplyMarkup").slice(1).map((params) => params.reply_markup)).toEqual([{ inline_keyboard: [] }, { inline_keyboard: [] }]);
  api.fail("editMessageReplyMarkup", 400, "Bad Request: message to edit not found");
  await expect(channel.resolve(card, "A")).rejects.toThrow("message to edit not found");
});

test("a card's next step writes its note under the notice's own text; back without it, the text is as posted; the outcome goes under that", async () => {
  const { api, open, listen, received } = setup();
  const channel = listen(open());
  const card = (await channel.notice(sibling, "access?", [["15 min"], ["forever"]]))[0]!;
  const message_id = Number(String(card).split(".").at(-1));
  const bold = [{ type: "bold", offset: 0, length: 13 }];
  const markup = (...labels: string[]) => ({ inline_keyboard: labels.map((text, index) => [{ text, callback_data: String(index) }]) });
  await channel.setChoices(card, [["Yes"], ["Cancel"]], "Sure?");
  await channel.setChoices(card, [["Yes!"], ["Cancel"]], "Sure?"); // the same note: the buttons only
  // A press sends the text as shown, the note under it: the text as posted is kept.
  api.push({ callback_query: { id: "c1", from: OLEG, message: { message_id, chat: { id: OWNER }, message_thread_id: 100, is_topic_message: true, text: "🏠 Household: access?\n\nSure?", reply_markup: markup("Yes!", "Cancel") }, data: "1" } });
  await waitFor(() => received.length === 1);
  await channel.setChoices(card, [["15 min"], ["forever"]]);
  await channel.resolve(card, "15 min");
  expect(api.sent("editMessageText")).toEqual([
    { chat_id: OWNER, message_id, text: "🏠 Household: access?\n\nSure?", entities: bold, reply_markup: markup("Yes", "Cancel"), link_preview_options: { is_disabled: true } },
    { chat_id: OWNER, message_id, text: "🏠 Household: access?", entities: bold, reply_markup: markup("15 min", "forever"), link_preview_options: { is_disabled: true } },
    { chat_id: OWNER, message_id, text: "🏠 Household: access?\n\n→ 15 min", entities: bold, link_preview_options: { is_disabled: true } },
  ]);
  expect(api.sent("editMessageReplyMarkup")).toEqual([{ chat_id: OWNER, message_id, reply_markup: markup("Yes!", "Cancel") }]);
  // Its text unknown (resolved), or too long with the note: the buttons only change.
  await channel.setChoices(card, [["Yes"]], "Sure?");
  const long = (await channel.notice(sibling, "x".repeat(4070), [["ok"]]))[0]!;
  await channel.setChoices(long, [["Yes"]], "Really allow this?");
  expect(api.sent("editMessageText")).toHaveLength(3);
  expect(api.sent("editMessageReplyMarkup")).toHaveLength(3);
});

test("a person's reaction changes arrive as reactions on the message they are on: added, removed, other kinds by name", async () => {
  const { api, received, lines, open, listen } = setup();
  type Reactions = NonNullable<Update["message_reaction"]>["new_reaction"];
  const reacted = (old_reaction: Reactions, new_reaction: Reactions, user: { id: number; first_name: string } = OLEG) =>
    api.push({ message_reaction: { chat: { id: OWNER }, message_id: 77, user, date: 1, old_reaction, new_reaction } });
  const thumbs = { type: "emoji", emoji: "👍" };
  reacted([], [thumbs]);
  reacted([thumbs], [{ type: "emoji", emoji: "🔥" }, { type: "custom_emoji" }, { type: "paid" }]);
  reacted([], [thumbs], { id: 666, first_name: "Eve" }); // someone else: a guest's reaction
  reacted([], [thumbs], { id: OWNER, first_name: "Bot", is_bot: true } as never);
  api.push({ message_reaction: { chat: { id: OWNER }, message_id: 77, date: 1, old_reaction: [], new_reaction: [thumbs] } }); // actor_chat, no user
  api.push({ message_reaction: { chat: { id: -100 }, message_id: 77, user: OLEG, date: 1, old_reaction: [], new_reaction: [thumbs] } });
  reacted([thumbs], [thumbs]);
  listen(open());
  await waitFor(() => received.length === 3);
  await waitFor(() => lines.some((line) => line.includes("skipped (a reaction that changed nothing)")));
  const on = `telegram.123456.${OWNER}.77`;
  expect(received).toEqual([
    { kind: "reaction", ref: `telegram.123456.${OWNER}.reaction.77.1.1` as MessageRef, ...owner, ...facts(77), on: on as PostRef, added: ["👍"], removed: [] },
    expect.objectContaining({ kind: "reaction", on, added: ["🔥", "custom emoji", "paid"], removed: ["👍"] }),
    expect.objectContaining({ kind: "reaction", from: { ref: "telegram.user.666", name: "Eve" }, on, added: ["👍"] }),
  ]);
  for (const who of ["a bot", "a chat"]) expect(lines.some((line) => line.includes(`skipped (a reaction from ${who}, not a person)`))).toBe(true);
  expect(lines.filter((line) => line.includes("chat -100 is no channel of this house"))).toHaveLength(1);
  await open().delivered(received[0]!.ref); // a reaction is no message to mark as seen
  expect(api.sent("setMessageReaction")).toEqual([]);
});

test("Household reacts with a standard emoji, or takes its reaction away; Telegram's refusal of another says what works", async () => {
  const { api, open } = setup();
  const channel = open();
  const message = `telegram.123456.${OWNER}.77` as PostRef;
  await channel.react(message, "👍");
  await channel.react(`telegram.123456.${OWNER}.78.1700000000` as MessageRef, undefined); // an edited message of the person's
  expect(api.sent("setMessageReaction")).toEqual([
    { chat_id: OWNER, message_id: 77, reaction: [{ type: "emoji", emoji: "👍" }] },
    { chat_id: OWNER, message_id: 78, reaction: [] },
  ]);
  api.fail("setMessageReaction", 400, "Bad Request: REACTION_INVALID");
  await expect(channel.react(message, "🐾")).rejects.toThrow("Telegram does not take 🐾 as a reaction: use one of its standard reaction emoji");
  await expect(channel.react("telegram.999.1.5" as PostRef, "👍")).rejects.toThrow("not a message of this chat");
});

test("a working status post is one silent line with the stop button, which every edit keeps; an unfinished turn's one line has none; a finished one is deleted", async () => {
  const { api, open } = setup();
  const channel = open();
  const posted = await channel.postStatus(sibling, { state: "working", line: "Extracting all files from the archive…", stop: "Stop" });
  const stop = { inline_keyboard: [[{ text: "Stop", callback_data: "0" }]] };
  expect(api.sent("sendMessage")).toEqual([
    { chat_id: OWNER, message_thread_id: 100, text: "⏳ Extracting all files from the archive…", reply_markup: stop, disable_notification: true, link_preview_options: { is_disabled: true } },
  ]);
  await channel.editStatus(posted, { state: "working", line: "Reading src/JWT.php…", stop: "Stop" });
  expect(api.sent("editMessageText")[0]).toMatchObject({ message_id: 1000, text: "⏳ Reading src/JWT.php…", reply_markup: stop });
  await channel.editStatus(posted, { state: "over", title: "Stopped at action 3" });
  expect(api.sent("editMessageText")[1]).toMatchObject({ text: "Stopped at action 3", reply_markup: { inline_keyboard: [] } });
  await channel.dropStatus(posted);
  expect(api.sent("deleteMessage")).toEqual([{ chat_id: OWNER, message_id: 1000 }]);
  api.fail("deleteMessage", 400, "Bad Request: message can't be deleted for everyone");
  expect(await channel.dropStatus(posted).catch((caught) => caught)).toBeInstanceOf(StatusGone);
});

test("status calls are never waited out: a 429 says how long to wait; a message gone or the bot shut out can never work; the rest passes", async () => {
  const { api, open } = setup();
  const channel = open();
  const view = { state: "working" as const, line: "Reading a.txt…", stop: "Stop" };
  api.fail("sendMessage", 429, "Too Many Requests: retry after 9", 1, 9);
  const started = Date.now();
  expect(await channel.postStatus(sibling, view).catch((caught) => caught)).toMatchObject({ retryAfterMs: 9000 });
  const posted = await channel.postStatus(sibling, view);
  api.fail("editMessageText", 429, "Too Many Requests: retry after 7", 1, 7);
  const error = await channel.editStatus(posted, view).catch((caught) => caught);
  expect(error).toBeInstanceOf(RateLimited);
  expect(error.retryAfterMs).toBe(7000);
  expect(Date.now() - started).toBeLessThan(2000);
  api.fail("editMessageText", 400, "Bad Request: message is not modified");
  await channel.editStatus(posted, view);
  // A refusal never works later (gone, not editable, the bot shut out, its text not taken): given up.
  for (const [code, description] of [[400, "Bad Request: message to edit not found"], [400, "Bad Request: message can't be edited"], [403, "Forbidden: bot was blocked by the user"], [400, "Bad Request: can't parse entities"]] as const) {
    api.fail("editMessageText", code, description);
    expect(await channel.editStatus(posted, view).catch((caught) => caught)).toBeInstanceOf(StatusGone);
  }
  for (const [code, description] of [[500, "Internal Server Error"], [502, "Bad Gateway"]] as const) {
    api.fail("editMessageText", code, description);
    const passing = await channel.editStatus(posted, view).catch((caught) => caught);
    expect(passing).not.toBeInstanceOf(StatusGone);
    expect(passing).not.toBeInstanceOf(RateLimited);
  }
});

test("a status line never carries a cut emoji, a control or a bidi character, and fits Telegram", () => {
  expect(renderStatus({ state: "working", line: "a\nb\u202e\uD800 c…" })).toBe("⏳ a\nb \uFFFD c…");
  expect(renderStatus({ state: "working", line: `${"x".repeat(5000)}🇺🇦` }).length).toBeLessThanOrEqual(4096);
  expect(renderStatus({ state: "working", line: "🇺🇦🇺🇦🇺🇦" }, 4)).toBe("⏳ 🇺🇦…"); // a flag is never halved
  expect(renderStatus({ state: "over", title: "Interrupted · error" })).toBe("Interrupted · error");
});

test("a command for this bot by name is the command; one for another bot keeps its name", async () => {
  const { api, received, open, listen } = setup();
  listen(open());
  api.push({ message: fromOwner({ text: "/stop@fake_bot" }, 7) });
  api.push({ message: fromOwner({ text: "/stop@other_bot" }, 8) });
  await waitFor(() => received.length === 2);
  expect(received.map((message) => (message as { text: string }).text)).toEqual(["/stop", "/stop@other_bot"]);
});

test("typing targets the pet thread and respects cancellation", async () => {
  const { api, open } = setup();
  const channel = open();
  const controller = new AbortController();
  await channel.typing(sibling, controller.signal);
  expect(api.sent("sendChatAction")).toEqual([{ chat_id: OWNER, message_thread_id: 100, action: "typing" }]);
  controller.abort();
  await channel.typing(sibling, controller.signal);
  expect(api.sent("sendChatAction")).toHaveLength(1);
});

 test("Telegram keeps the review paragraph through send and edit rendering", () => {
  for (const status of ["approved ✅", "denied ⛔", "reviewing ⏳", "timed out ⚠️", "aborted ⚠️"]) {
    const line = `Running docker info…\n\nAuto reviewer: ${status}`;
    expect(renderStatus({state: "working", line})).toBe(`⏳ ${line}`);
  }
});

test("Telegram sendMessage and editMessageText retain the blank line before auto review", async () => {
  const { api, open } = setup();
  const channel = open();
  const line = "Running docker info…\n\nAuto reviewer: reviewing ⏳";
  const ref = await channel.postStatus(sibling, {state: "working", line});
  expect(api.sent("sendMessage")[0]).toMatchObject({text: `⏳ ${line}`});
  const approved = "Running docker info…\n\nAuto reviewer: approved ✅";
  await channel.editStatus(ref, {state: "working", line: approved});
  expect(api.sent("editMessageText")[0]).toMatchObject({text: `⏳ ${approved}`});
});

test("configured places appear without messages; concurrent creation and reload reuse the persisted topic", async () => {
  const { api, open } = setup();
  const channel = open();
  await Promise.all([channel.ensurePlace(sibling), channel.ensurePlace(sibling)]);
  expect(api.sent("createForumTopic")).toEqual([{ chat_id: OWNER, name: sibling.title }]);
  expect(api.sent("sendMessage")).toHaveLength(0);
  await open().ensurePlace(sibling);
  expect(api.sent("createForumTopic")).toHaveLength(1);
  await channel.post(sibling, "hello");
  expect(api.sent("sendMessage")[0]?.message_thread_id).toBe(100);
  await channel.ensurePlace({ id: "inbox", kind: "house-inbox", title: "General" });
  expect(api.sent("createForumTopic")).toHaveLength(1);
});

test("native peer quotes preserve multiline prose and use UTF-16 offsets after emoji headings", async () => {
  const { api, open } = setup();
  const heading = "💬 🦉 Owl → 🐾 Sibling:";
  const body = "First line\nSecond line with <tags> & *literal markup* 🧪";
  const refs = await open().quote(sibling, heading, body);
  expect(refs).toHaveLength(1);
  const sent = api.sent("sendMessage")[0]!;
  const offset = heading.length + 2;
  expect(sent.text).toBe(`${heading}\n\n${body}`);
  expect(sent.entities).toEqual([{ type: "blockquote", offset, length: body.length }]);
  expect(offset).toBeGreaterThan([...heading].length + 2);
  expect((sent.text as string).slice(offset)).toBe(body);
  expect(sent.parse_mode).toBeUndefined();
  expect(sent.message_thread_id).toBeDefined();
});

test("long peer quotes repeat their heading and quote every split part without splitting emoji", async () => {
  const { api, open } = setup();
  const heading = "💬 🧪 One → Two:";
  const body = "🐾".repeat(4200) + "\nThe final line";
  const refs = await open().quote(sibling, heading, body);
  const sent = api.sent("sendMessage");
  expect(refs).toHaveLength(sent.length);
  expect(sent.length).toBeGreaterThan(2);
  const bodies: string[] = [];
  for (const item of sent) {
    const text = item.text as string, offset = heading.length + 2;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.startsWith(`${heading}\n\n`)).toBe(true);
    expect(item.entities).toEqual([{ type: "blockquote", offset, length: text.length - offset }]);
    const quoted = text.slice(offset);
    expect(quoted.isWellFormed()).toBe(true);
    bodies.push(quoted);
  }
  expect(bodies.join("")).toBe(body);
});

test("outgoing documents, photos, voice messages and videos upload bytes to the pet's topic", async () => {
  const { api, open } = setup();
  const channel = open();
  const bytes = new Uint8Array([0, 127, 255, 13, 10]);
  for (const [kind, method, name, mime] of [
    ["document", "sendDocument", "report.pdf", "application/pdf"],
    ["photo", "sendPhoto", "picture.png", "image/png"],
    ["voice", "sendVoice", "voice.ogg", "audio/ogg"],
    ["video", "sendVideo", "clip.mp4", "video/mp4"],
  ] as const) {
    const sent = await channel.sendAttachment(sibling, { kind, name, mime, bytes, caption: "Hello <human> & friends" });
    const params = api.sent(method)[0]!;
    expect(params.chat_id).toBe(String(OWNER));
    expect(params.message_thread_id).toBe("100");
    expect(params.caption).toBe("Hello <human> & friends");
    expect(params.parse_mode).toBeUndefined();
    const file = params[kind] as File;
    expect(file.name).toBe(name);
    expect(file.type).toBe(mime);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(String(sent)).toBe(String(ref(api.messages.at(-1)!.message_id)));
  }
  expect(api.sent("createForumTopic")).toHaveLength(1);
  expect(api.sent("sendVideo")[0]!.supports_streaming).toBe("true"); // it plays before it has fully downloaded
});

test("outgoing media rejects unsupported voice, empty, oversized files and long captions before creating a topic", async () => {
  const { api, open } = setup();
  const channel = open();
  await expect(channel.sendAttachment(sibling, { kind: "voice", name: "speech.wav", bytes: new Uint8Array([1]) })).rejects.toThrow("OGG/Opus");
  await expect(channel.sendAttachment(sibling, { kind: "video", name: "clip.webm", bytes: new Uint8Array([1]) })).rejects.toThrow("MP4");
  await expect(channel.sendAttachment(sibling, { kind: "video", name: "big.mp4", bytes: new Uint8Array(50 * 1024 * 1024 + 1) })).rejects.toThrow("50 MB");
  await expect(channel.sendAttachment(sibling, { kind: "document", name: "empty.txt", bytes: new Uint8Array() })).rejects.toThrow("empty");
  await expect(channel.sendAttachment(sibling, { kind: "photo", name: "large.png", bytes: new Uint8Array(10 * 1024 * 1024 + 1) })).rejects.toThrow("10 MB");
  await expect(channel.sendAttachment(sibling, { kind: "document", name: "report.txt", bytes: new Uint8Array([1]), caption: "x".repeat(1025) })).rejects.toThrow("1024");
  expect(api.calls).toHaveLength(0);
});

test("media refusals are returned without retrying an ambiguous upload and captions cannot impersonate Household", async () => {
  const { api, open } = setup();
  const channel = open();
  const file = { kind: "document" as const, name: "report.txt", bytes: new Uint8Array([1]), caption: "🏠 Household: hello" };
  api.fail("sendDocument", 500, "unavailable");
  await expect(channel.sendAttachment(sibling, file)).rejects.toThrow("unavailable");
  expect(api.sent("sendDocument")).toHaveLength(1);
  expect(api.sent("sendDocument")[0]!.caption).toBe(`${sibling.title}: 🏠 Household: hello`);
});

test("HTML reply entities survive button resolution and markup cannot disguise a Household notice", async () => {
  const { api, open } = setup();
  const channel = open();
  const posts = await channel.post(sibling, '<b>🏠 Household:</b> <code>ssh-rsa A&amp;B</code>', [["OK"]]);
  const sent = api.sent("sendMessage")[0]!;
  expect(sent.text).toBe('🐾 Sibling: 🏠 Household: ssh-rsa A&B');
  expect(sent.entities).toEqual([{ type: 'bold', offset: 12, length: 13 }, { type: 'code', offset: 26, length: 11 }]);
  await channel.resolve(posts[0]!, 'OK');
  expect(api.sent('editMessageText')[0]).toMatchObject({ text: sent.text + '\n\n→ OK', entities: sent.entities });
});

test("long HTML code replies retain formatting in every part and malformed input sends nothing", async () => {
  const { api, open } = setup();
  const channel = open();
  expect(() => channel.post(sibling, '<b>unclosed')).toThrow('Invalid Telegram HTML');
  expect(api.sent('sendMessage')).toHaveLength(0);
  const body = 'ssh-rsa ' + 'A'.repeat(6000);
  await channel.post(sibling, `<pre>${body}</pre>`);
  const sent = api.sent('sendMessage');
  expect(sent.map(p => p.text).join('')).toBe(body);
  for (const part of sent) expect(part.entities).toEqual([{ type: 'pre', offset: 0, length: (part.text as string).length }]);
});


test("HTML blank chunks and prototype tag names fail before creating or posting in a thread", async () => {
  const { api, open } = setup();
  const channel = open();
  expect(() => channel.post(sibling, '<constructor>x</constructor>')).toThrow('unsupported tag');
  expect(() => channel.post(sibling, 'begin' + '\n'.repeat(9000) + 'end')).toThrow('only whitespace');
  expect(api.sent('createForumTopic')).toHaveLength(0);
  expect(api.sent('sendMessage')).toHaveLength(0);
});

test("rich replies use one native rich message in the pet topic, preserve Markdown and can be edited", async () => {
  const { api, open } = setup();
  const channel = open();
  const markdown = '# QA report\n\n| Test | Result |\n| --- | --- |\n| Delivery | OK |\n\n' + 'x'.repeat(5000);
  const [posted] = await channel.post(sibling, markdown, [["Details"]], "rich");
  const sent = api.sent('sendRichMessage')[0]!;
  expect(sent).toMatchObject({ chat_id: OWNER, message_thread_id: 100, rich_message: { markdown: `**${sibling.title}**\n\n${markdown}` }, reply_markup: { inline_keyboard: [[{ text: 'Details', callback_data: '0' }]] } });
  expect(api.sent('sendMessage')).toHaveLength(0);
  expect(posted).toBe(ref(api.messages[0]!.message_id) as unknown as PostRef);
  await channel.editPost(sibling, posted!, '# Updated report\n\n**PASS**', [["Details"]], "rich");
  expect(api.sent('editMessageText')[0]).toMatchObject({ message_id: api.messages[0]!.message_id, rich_message: { markdown: `**${sibling.title}**\n\n# Updated report\n\n**PASS**` } });
  await channel.resolve(posted!, 'Details');
  expect(api.sent('editMessageText')).toHaveLength(1);
  expect(api.sent('editMessageReplyMarkup').at(-1)).toMatchObject({ reply_markup: { inline_keyboard: [] } });
});

test("rich validation happens before topic creation; refusals do not silently fall back", async () => {
  const { api, open } = setup();
  const channel = open();
  await expect(channel.post(sibling, ' ', undefined, 'rich')).rejects.toThrow('empty');
  await expect(channel.post(sibling, 'a'.repeat(32768), undefined, 'rich')).rejects.toThrow('32768');
  expect(api.calls).toHaveLength(0);
  api.fail('sendRichMessage', 400, 'invalid rich markup');
  await expect(channel.post(sibling, '# report', undefined, 'rich')).rejects.toThrow('invalid rich markup');
  expect(api.sent('sendRichMessage')).toHaveLength(1);
  expect(api.sent('sendMessage')).toHaveLength(0);
});

test("rich callback after adapter restart never rewrites rich content as plain text", async () => {
  const { api, open, listen, received } = setup();
  const channel = listen(open());
  api.push({ callback_query: { id: 'rich-choice', from: OLEG, message: fromOwner({ rich_message: { blocks: [] }, text: 'Fallback report', reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: '0' }]] } }, 27), data: '0' } });
  await waitFor(() => received.length === 1);
  const choice = received[0] as Extract<InboundMessage, { kind: 'choice' }>;
  await channel.setChoices(choice.answersTo, [['Next']], 'note');
  await channel.resolve(choice.answersTo, 'OK');
  expect(api.sent('editMessageText')).toHaveLength(0);
  expect(api.sent('editMessageReplyMarkup')).toHaveLength(2);
});

test("ordinary edits keep entities and refresh cached button text; oversized edits do not split", async () => {
  const { api, open } = setup();
  const channel = open();
  const [posted] = await channel.post(sibling, 'Old', [['OK']]);
  await channel.editPost(sibling, posted!, '<b>New</b> <code>A&amp;B</code>', [['OK']]);
  expect(api.sent('editMessageText')[0]).toMatchObject({ text: 'New A&B', entities: [{ type: 'bold', offset: 0, length: 3 }, { type: 'code', offset: 4, length: 3 }] });
  await channel.resolve(posted!, 'OK');
  expect(api.sent('editMessageText')[1]).toMatchObject({ text: 'New A&B\n\n→ OK' });
  await expect(channel.editPost(sibling, posted!, 'x'.repeat(4097))).rejects.toThrow('4096');
  await expect(channel.editPost(sibling, posted!, '<b> </b>')).rejects.toThrow('empty');
  await expect(channel.editPost(sibling, 'not-a-ref' as PostRef, 'x')).rejects.toThrow('reference');
  expect(api.sent('sendMessage')).toHaveLength(1);
  expect(api.sent('editMessageText')).toHaveLength(2);
  api.fail('editMessageText', 400, 'Bad Request: message is not modified');
  await channel.editPost(sibling, posted!, '<b>New</b>');
  expect(api.sent('editMessageText').at(-1)).toMatchObject({ reply_markup: { inline_keyboard: [] } });
});

test("rich calls retry explicit rate limits only and retain pet attribution for notice-like content", async () => {
  const { api, open } = setup();
  const channel = open();
  api.fail('sendRichMessage', 429, 'Too Many Requests', 1, 0.001);
  const [posted] = await channel.post({ ...sibling, title: 'Pet [one] *two*' }, '# 🏠 Household: report', undefined, 'rich');
  expect(api.sent('sendRichMessage')).toHaveLength(2);
  expect(api.sent('sendRichMessage')[1]!.rich_message.markdown).toBe('**Pet \\[one\\] \\*two\\***\n\n# 🏠 Household: report');
  api.fail('editMessageText', 429, 'Too Many Requests', 1, 0.001);
  await channel.editPost(sibling, posted!, '# Updated', undefined, 'rich');
  expect(api.sent('editMessageText')).toHaveLength(2);
  api.fail('editMessageText', 500, 'ambiguous failure');
  await expect(channel.editPost(sibling, posted!, '# Again', undefined, 'rich')).rejects.toThrow('ambiguous failure');
  expect(api.sent('editMessageText')).toHaveLength(3);
});

test("formatted Household cards preserve emphasis and escaped text when resolved; plain notices stay literal", async () => {
  const { api, open } = setup();
  const channel = open();
  const [card] = await channel.notice(sibling, "<b>Save secret?</b>\n\n<b>Name:</b> <code>weather</code>\n\nPet's words: A &amp; B &lt;b&gt;", [["Save"]], "html");
  const sent = api.sent("sendMessage")[0]!;
  expect(sent.text).toBe("🏠 Notification from Household\n\nSave secret?\n\nName: weather\n\nPet's words: A & B <b>"); // a card: Household's name on a line of its own
  expect(sent.entities).toContainEqual({ type: "bold", offset: 0, length: 30 });
  expect(sent.entities).toContainEqual({ type: "bold", offset: 32, length: 12 });
  expect(sent.entities).toContainEqual({ type: "code", offset: 52, length: 7 });
  await channel.resolve(card!, "Saved");
  expect(api.sent("editMessageText")[0]).toMatchObject({ text: `${sent.text}\n\n→ Saved`, entities: sent.entities });
  await channel.notice(sibling, "literal <b> & text");
  expect(api.sent("sendMessage")[1]!.text).toBe("🏠 Household: literal <b> & text");
});

test("owner card transitions replace the entire text and formatting including the final outcome", async () => {
  const { api, open } = setup();
  const channel = open();
  const [card] = await channel.notice(sibling, "<b>First warning</b>", [["Send anyway"]], "html");
  await channel.setChoices(card!, [["Yes"], ["No"]], undefined, { text: "<b>Are you sure?</b>\n\nProvider receives it.", format: "html" });
  await channel.setChoices(card!, [], undefined, { text: "<b>Cancelled.</b>\n\nNothing sent.", format: "html" });
  const edits = api.sent("editMessageText");
  expect(edits[0]!.text).toBe("🏠 Notification from Household\n\nAre you sure?\n\nProvider receives it.");
  expect(edits[0]!.entities).toContainEqual({ type: "bold", offset: 32, length: 13 });
  expect(edits[1]!.text).toBe("🏠 Notification from Household\n\nCancelled.\n\nNothing sent.");
  expect(edits[1]!.reply_markup).toEqual({ inline_keyboard: [] });
});

test("a place's link is t.me/<bot>/<thread>, its thread made first; the inbox has none", async () => {
  const { api, open } = setup();
  const channel = open();
  expect(await channel.placeLink(sibling)).toBe("https://t.me/fake_bot/100");
  expect(api.sent("createForumTopic")).toEqual([{ chat_id: OWNER, name: "🐾 Sibling" }]);
  expect(await channel.placeLink(sibling)).toBe("https://t.me/fake_bot/100"); // the same thread, getMe asked once
  expect(api.sent("getMe")).toHaveLength(1);
  expect(await channel.placeLink(inbox)).toBeUndefined();
});

test("a notice rewritten with a link has that one URL button and no choices", async () => {
  const { api, open } = setup();
  const channel = open();
  const [card] = await channel.notice(sibling, "<b>Run?</b>", [["Run"], ["Cancel"]], "html");
  await channel.setChoices(card!, [], undefined, { text: "<b>✅ Spawned new scout</b>", format: "html", link: { label: "Open thread", url: "https://t.me/fake_bot/101" } });
  const edit = api.sent("editMessageText").at(-1)!;
  expect(edit.text).toBe("🏠 Notification from Household\n\n✅ Spawned new scout");
  expect(edit.reply_markup).toEqual({ inline_keyboard: [[{ text: "Open thread", url: "https://t.me/fake_bot/101" }]] });
  await channel.setChoices(card!, [], undefined, { text: "<b>⏹ Finished</b>", format: "html" });
  expect(api.sent("editMessageText").at(-1)!.reply_markup).toEqual({ inline_keyboard: [] });
});

test("a removed place's thread is deleted and forgotten: messages there are no one's, a new one is made if needed", async () => {
  const { api, state, received, open, listen, lines } = setup();
  const channel = listen(open());
  expect(await channel.removePlace(sibling)).toBe(false); // no thread yet: nothing made to delete it
  expect(api.sent("deleteForumTopic")).toEqual([]);
  await channel.post(sibling, "hello");
  expect(await channel.removePlace(sibling)).toBe(true);
  expect(api.sent("deleteForumTopic")).toEqual([{ chat_id: OWNER, message_thread_id: 100 }]);
  expect(api.topics.has(`${OWNER}/100`)).toBe(false);
  expect(state.get(`telegram.123456.${OWNER}.thread.c1`)).toBe("");
  expect(lines).toContain("telegram house work: thread for c1 deleted");
  api.push({ message: fromOwner({ text: "late", message_thread_id: 100, is_topic_message: true }) });
  await waitFor(() => received.length === 1);
  expect(received[0]!.place).toBeUndefined();
  expect(await channel.removePlace(sibling)).toBe(false);
  // A thread Telegram no longer has counts as deleted; any other refusal is the caller's to hear.
  await channel.post(sibling, "again");
  expect(api.sent("createForumTopic")).toHaveLength(2);
  api.topics.delete(`${OWNER}/101`);
  expect(await channel.removePlace(sibling)).toBe(true);
  await channel.post(sibling, "third");
  api.fail("deleteForumTopic", 403, "Forbidden: not enough rights");
  await expect(channel.removePlace(sibling)).rejects.toThrow("not enough rights");
  expect(state.get(`telegram.123456.${OWNER}.thread.c1`)).toBe("102");
});
