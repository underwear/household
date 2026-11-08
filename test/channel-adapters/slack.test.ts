import { afterEach, expect, test } from "bun:test";
import { SlackBot, SlackChannel } from "../../src/channel-adapters/slack";
import { SlackError, SlackWebApi } from "../../src/channel-adapters/slack/api";
import { parseInbound, type SlackPayload } from "../../src/channel-adapters/slack/events";
import { blocks, pieces, choiceBlocks, quietMarkdown } from "../../src/channel-adapters/slack/render";
import type { SlackApi } from "../../src/channel-adapters/slack/api";
import type { InboundMessage, MessageRef, SenderRef } from "../../src/core/channel";
import { DownloadRefused, RateLimited, StatusGone } from "../../src/core/channel";
import { knownChannelKinds, knownPlatforms } from "../../src/app/kinds";
import { isSlackOwner, isSlackChat, slackTokenCheck } from "../../src/channel-adapters/slack/kind";

const pet = { id: "pet:sibling@slack-private:TTEST:DTEST", kind: "pet-thread" as const, title: "🐾 Sibling" };
const inbox = { id: "inbox", kind: "house-inbox" as const, title: "Inbox" };
const ref = (ts: string) => `slack.TTEST.DTEST.${ts}` as MessageRef;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
function setup(state = new Map<string, string>()) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let serial = 0;
  let fail: { method: string; error: Error } | undefined;
  const api: SlackApi = { async call<T>(method: string, params = {}): Promise<T> {
    calls.push({ method, params });
    if (fail?.method === method) { const error = fail.error; fail = undefined; throw error; }
    const results: Record<string, object> = {
      "auth.test": { team_id: "TTEST", user_id: "UBOT", bot_id: "BBOT", user: "household" },
      "conversations.info": { channel: { is_im: true } },
      "chat.postMessage": { ts: `1700000000.${String(++serial).padStart(6, "0")}` },
      "chat.getPermalink": { permalink: "https://example.slack.com/archives/DTEST/p1700000000000001" },
      "files.info": { file: { url_private: "https://evil.invalid/file", size: 10 } },
    };
    return (results[method] ?? { ok: true }) as T;
  } };
  const received: InboundMessage[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  let starts = 0, disconnects = 0;
  const bot = new SlackBot({ token: "xoxb-fake-local-test-only-000000", appToken: "xapp-fake-local-test-only-000000", state, log: { info() {}, error() {} }, api, socket: () => ({ on: (event, listener) => listeners.set(event, listener), start: async () => { starts++; }, disconnect: async () => { disconnects++; } }) });
  const channel = new SlackChannel(bot, "TTEST:DTEST");
  channel.start(async message => { received.push(message); });
  stops.push(() => channel.stop());
  const incoming = (id: string, event: object, extra: object = {}) => bot.take({ team_id: "TTEST", event_id: id, event: { type: "message", user: "UOWNER", channel: "DTEST", ts: "1700000001.000001", text: "Hello", ...event }, ...extra });
  return { bot, channel, state, calls, received, listeners, incoming, fail: (method: string, error: Error) => { fail = { method, error }; }, counts: () => ({ starts, disconnects }) };
}

test("Slack is a private registered channel; identities are workspace scoped", () => {
  expect(knownChannelKinds().get("slack-private")?.audience).toBe("private");
  expect(knownPlatforms().get("slack")?.valid("TTEST:UOWNER")).toBe(true);
  expect(isSlackOwner("UOWNER")).toBe(false);
  expect(isSlackChat("TTEST:CTEAM")).toBe(false);
  const { channel } = setup();
  expect(channel.isSender("slack.user.TTEST.UOWNER" as SenderRef, "TTEST:UOWNER")).toBe(true);
  expect(channel.isSender("slack.user.TOTHER.UOWNER" as SenderRef, "TTEST:UOWNER")).toBe(false);
});

test("one persistent root thread per pet, concurrent sends and reload reuse it", async () => {
  const s = setup();
  await Promise.all([s.channel.post(pet, "First"), s.channel.post(pet, "Second")]);
  const posts = s.calls.filter(call => call.method === "chat.postMessage");
  expect(posts).toHaveLength(3);
  const thread = posts[1]!.params.thread_ts;
  expect(posts[2]!.params.thread_ts).toBe(thread);
  expect(posts[0]!.params.thread_ts).toBeUndefined();
  const resumed = new SlackChannel(s.bot, "TTEST:DTEST");
  await resumed.post(pet, "Third");
  expect(s.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(4);
  expect(await resumed.placeLink(pet)).toContain("/archives/DTEST/");
  await resumed.retitle({ ...pet, title: "Renamed" });
  expect(s.calls.at(-1)?.method).toBe("chat.update");
});

test("inbox, pet thread, duplicate events, edits, and bot loops", async () => {
  const s = setup();
  await s.channel.ensurePlace(pet);
  const thread = s.state.get(`slack.TTEST.DTEST.thread.${pet.id}`)!;
  await s.incoming("Ev1", {});
  await s.incoming("Ev1", {});
  await s.incoming("Ev2", { thread_ts: thread });
  await s.incoming("Ev3", { thread_ts: "999.111" });
  await s.incoming("Ev4", { bot_id: "BOTHER" });
  await s.incoming("Ev5", { user: "UBOT" });
  await s.incoming("Ev6", { subtype: "message_changed", message: { user: "UOWNER", text: "edited", ts: "1700000001.000001", thread_ts: thread, edited: { ts: "1700000002.000002" } } });
  expect(s.received).toHaveLength(3);
  expect(s.received[0]?.place).toBeUndefined();
  expect(s.received[1]?.place).toBe(pet.id);
  expect(s.received[2]).toMatchObject({ kind: "text", edits: ref("1700000001.000001"), text: "edited" });
  expect(JSON.stringify(s.received)).not.toContain("xoxb");
  await s.channel.stop();
  const resumed = setup(s.state);
  await resumed.incoming("Ev1", {});
  expect(resumed.received).toHaveLength(0);
});

test("rejects unknown chats, groups and wrong workspaces before dispatch", async () => {
  const s = setup();
  await s.incoming("Ev1", { channel: "DOTHER" });
  await s.incoming("Ev2", { channel: "CTEAM" });
  await s.incoming("Ev3", {}, { team_id: "TOTHER" });
  expect(s.received).toHaveLength(0);
  const other = new SlackChannel(s.bot, "TOTHER:DTEST");
  await expect(other.post(inbox, "must not send")).rejects.toThrow("different workspaces");
  expect(s.calls.some(call => call.method === "chat.postMessage")).toBe(false);
});

test("Slack automatic domain links remain usable in secret commands; custom labels retain their target", async () => {
  const s = setup();
  await s.incoming("EvDomain", { text: "  !secret weather SYNTHETIC <http://example.com|example.com>" });
  expect(s.received[0]).toMatchObject({ text: "/secret weather SYNTHETIC example.com" });
  await s.incoming("EvLink", { text: "<https://evil.invalid|example.com> &lt;literal&gt;" });
  expect(s.received[1]).toMatchObject({ text: "example.com (https://evil.invalid) <literal>" });
});

test("button indexes, owner identity and resolution survive a channel restart", async () => {
  const s = setup();
  const [post] = await s.channel.notice(pet, "Approve network?", [["Allow once"], ["Deny"]]);
  const thread = s.state.get(`slack.TTEST.DTEST.thread.${pet.id}`)!;
  const ts = post!.slice("slack.TTEST.DTEST.".length);
  const body: SlackPayload = { type: "block_actions", team: { id: "TTEST" }, user: { id: "UOWNER", name: "Owner" }, channel: { id: "DTEST" }, container: { message_ts: ts }, message: { ts, thread_ts: thread }, actions: [{ action_id: "household_choice_1", value: "1", action_ts: "1700000003.000001", text: { text: "Deny" } }] };
  await s.bot.take(body);
  await s.bot.take(body);
  expect(s.received).toHaveLength(1);
  expect(s.received[0]).toMatchObject({ kind: "choice", index: 1, label: "Deny", answersTo: post, place: pet.id, from: { ref: "slack.user.TTEST.UOWNER" } });
  const resumed = new SlackChannel(s.bot, "TTEST:DTEST");
  await resumed.resolve(post!, "Denied by owner");
  const changed = s.calls.at(-1)!.params;
  expect(JSON.stringify(changed.blocks)).toContain("Denied by owner");
  expect(JSON.stringify(changed.blocks)).not.toContain("household_choice_");
  expect(changed.text).toContain("Approve network?");
});

test("status is one editable post with stop, then deleted; errors retain core semantics", async () => {
  const s = setup();
  const status = await s.channel.postStatus(pet, { state: "working", line: "Reading files", stop: "Stop" });
  await s.channel.editStatus(status, { state: "working", line: "Running checks", stop: "Stop" });
  expect(s.calls.at(-1)?.params.ts).toBe(status.slice("slack.TTEST.DTEST.".length));
  s.fail("chat.update", new RateLimited(1500));
  await expect(s.channel.editStatus(status, { state: "over", title: "Stopped" })).rejects.toBeInstanceOf(RateLimited);
  s.fail("chat.update", new SlackError("message_not_found"));
  await expect(s.channel.editStatus(status, { state: "over", title: "Stopped" })).rejects.toBeInstanceOf(StatusGone);
  await s.channel.dropStatus(status);
  expect(s.calls.at(-1)?.method).toBe("chat.delete");
});

test("delivery reaction replaces prior reaction; reactions and file handles parse without URLs", async () => {
  const s = setup();
  await s.channel.delivered(ref("1700000001.000001"));
  await s.channel.react(ref("1700000001.000001"), "✅");
  expect(s.calls.slice(-3).map(call => [call.method, call.params.name])).toEqual([["reactions.add", "eyes"], ["reactions.remove", "eyes"], ["reactions.add", "white_check_mark"]]);
  await s.incoming("EvR", { type: "reaction_added", reaction: "tada", event_ts: "1700000002.000001", item: { type: "message", channel: "DTEST", ts: "1700000001.000001" } });
  expect(s.received[0]).toMatchObject({ kind: "reaction", added: ["tada"] });
  await s.incoming("EvF", { files: [{ id: "FFILE", name: "proof.txt", size: 10, mimetype: "text/plain" }] });
  const message = s.received[1]!;
  if (message.kind !== "text") throw new Error("expected text");
  expect(String(message.attachments?.[0]?.file)).toBe("slack.TTEST.DTEST.file.FFILE");
  await expect(s.channel.download(message.attachments![0]!, new AbortController().signal)).rejects.toBeInstanceOf(DownloadRefused);
  expect("removeMessage" in s.channel).toBe(false); // Bot cannot delete another user's message.
});

test("multiple channels share a socket; leaving one cannot disconnect the other", async () => {
  const s = setup();
  const other = new SlackChannel(s.bot, "TTEST:DOTHER");
  const got: InboundMessage[] = [];
  other.start(async message => { got.push(message); });
  stops.push(() => other.stop());
  await s.incoming("Ev1", { channel: "DOTHER" });
  expect(got).toHaveLength(1);
  await s.channel.stop();
  expect(s.counts().disconnects).toBe(0);
  await s.incoming("Ev2", { channel: "DOTHER" });
  expect(got).toHaveLength(2);
  await other.stop();
  expect(s.counts().disconnects).toBe(1);
});

test("fast socket acknowledgement; failing handler does not poison the queue", async () => {
  const s = setup();
  let acked = false, failed = false;
  s.channel.start(async () => { expect(acked).toBe(true); if (!failed) { failed = true; throw new Error("failure"); } });
  const body = { team_id: "TTEST", event_id: "Ev1", event: { type: "message", user: "UOWNER", channel: "DTEST", ts: "1700000001.000001", text: "test" } };
  s.listeners.get("slack_event")!({ body, ack: async () => { acked = true; } });
  await Bun.sleep(10);
  expect(failed).toBe(true);
  await s.bot.take(body); // Failure was not marked delivered.
  expect(JSON.parse(s.state.get("slack.TTEST.BBOT.seen")!)).toEqual(["Ev1"]);
});

test("plain rendering, Block Kit limits, Unicode and disabled mass mentions", () => {
  expect(pieces("🐾".repeat(5601)).map(part => [...part].length)).toEqual([2800, 2800, 1]);
  expect(choiceBlocks([["A", "B"], ["C"]])).toMatchObject([{ elements: [{ value: "0" }, { value: "1" }, { value: "2" }] }]);
  expect(quietMarkdown("<!channel> <https://example.com|Link>")).toBe("&lt;!channel&gt; <https://example.com|Link>");
  expect(blocks("Hello")).toMatchObject([{ text: { verbatim: true } }]);
  expect(parseInbound({ event: { type: "message", user: "U1", ts: "bad", text: "x" } }, "slack.T.D", "T", () => undefined)).toBeUndefined();
});

test("real Web API client talks HTTP, token checks sanitize errors, rate limits do not sleep", async () => {
  let rate = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    expect(request.headers.get("authorization")).toBe("Bearer xoxb-test-token-00000000000000000000");
    if (rate) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
    return Response.json({ ok: true, team_id: "TTEST", bot_id: "BBOT", user_id: "UBOT", user: "household" });
  } });
  try {
    const check = slackTokenCheck(`http://127.0.0.1:${server.port}/`);
    const token = "xoxb-test-token-00000000000000000000";
    expect((await check.accept(token)).identity).toBe("TTEST:BBOT");
    expect(check.identityOf(token)).toBe("TTEST:BBOT");
    rate = true;
    await expect(new SlackWebApi(token, `http://127.0.0.1:${server.port}/`).call("auth.test")).rejects.toBeInstanceOf(RateLimited);
  } finally { server.stop(true); }
});

test("Household HTML retains emphasis, quotes, code and safe links in Slack", async () => {
  const { slackHtml } = await import("../../src/channel-adapters/slack/html");
  expect(slackHtml('<b>Launch scout</b>\n\nTask:\n<blockquote>First line\n&lt;!here&gt; &amp; &#128062;</blockquote>\n\nKey: <code>API_KEY</code>\n<i>Optional</i> <s>old</s>')).toBe('*Launch scout*\n\nTask:\n> First line\n> &lt;!here&gt; &amp; 🐾\n\nKey: `API_KEY`\n_Optional_ ~old~');
  expect(slackHtml('<pre><code class="language-sh">echo &quot;ok&quot;</code></pre>')).toBe('```\necho "ok"\n```');
  expect(slackHtml('<a href="https://example.com/?a=1&amp;b=2">Open</a>')).toBe('<https://example.com/?a=1&amp;b=2|Open>');
  expect(slackHtml('<a href="javascript:alert(1)">Open</a> &lt;b&gt;literal&lt;/b&gt;')).toBe('Open &lt;b&gt;literal&lt;/b&gt;');
  const s = setup();
  const [posted] = await s.channel.notice(inbox, '<b>Approval</b>\nUse <code>/secret demo</code>', [["Run"], ["Cancel"]], "html");
  expect(s.calls.at(-1)?.params.text).toBe('🏠 *Household*\n*Approval*\nUse `!secret demo`');
  await s.channel.setChoices(posted!, [], undefined, { text: '<b>Started</b>\n<code>demo</code>', format: "html" });
  expect(s.calls.at(-1)?.params.text).toBe('🏠 *Household*\n*Started*\n`demo`');
  await s.channel.resolve(posted!, "Done");
  expect(s.calls.at(-1)?.params.text).toBe('🏠 *Household*\n*Started*\n`demo`');
});
