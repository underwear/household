import { expect, test } from "bun:test";
import { SocketModeClient, LogLevel } from "@slack/socket-mode";
import type { ServerWebSocket } from "bun";
import { Chat } from "../../src/app/chat";
import { Dialogs } from "../../src/app/dialogs";
import { SlackBot, SlackChannel } from "../../src/channel-adapters/slack";
import { SlackWebApi } from "../../src/channel-adapters/slack/api";
import type { House } from "../../src/core/household";
import type { MessageDraft } from "../../src/core/message";
import { channelKey, petPlaceKey } from "../../src/core/channels";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { EventLog } from "../../src/infra/event-log";
import { tempDir, waitFor } from "../helpers";

test("real Socket Mode + Web API SDK → House routing, replies, owner buttons and Stop", async () => {
  let socket: ServerWebSocket<unknown> | undefined;
  let serial = 0;
  const acks: string[] = [];
  const posts: Record<string, any>[] = [];
  const calls: { method: string; params: Record<string, any> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const method = new URL(request.url).pathname.slice(1);
      if (method === "socket") { if (server.upgrade(request)) return; return new Response("bad upgrade", { status: 400 }); }
      const raw = await request.text();
      const params = request.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      if (typeof params.blocks === "string") params.blocks = JSON.parse(params.blocks);
      calls.push({ method, params });
      if (method === "apps.connections.open") return Response.json({ ok: true, url: `ws://127.0.0.1:${server.port}/socket` });
      if (method === "auth.test") return Response.json({ ok: true, team_id: "TTEST", user_id: "UBOT", bot_id: "BBOT" });
      if (method === "conversations.info") return Response.json({ ok: true, channel: { is_im: true } });
      if (method === "chat.postMessage") { const ts = `1700000000.${String(++serial).padStart(6, "0")}`; posts.push({ ...params, ts }); return Response.json({ ok: true, ts }); }
      if (method === "chat.update") Object.assign(posts.find(post => post.ts === params.ts) ?? {}, params);
      return Response.json({ ok: true });
    },
    websocket: {
      open(ws) { socket = ws; ws.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "ATEST" }, debug_info: {} })); },
      message(_ws, message) { const data = JSON.parse(String(message)); if (data.envelope_id) acks.push(data.envelope_id); },
    },
  });
  const state = new SqliteStore(":memory:");
  const log = new EventLog(`${tempDir()}/slack.log`, () => {});
  const url = `http://127.0.0.1:${server.port}/`;
  const bot = new SlackBot({ token: "xoxb-synthetic-test-only-000000", appToken: "xapp-synthetic-test-only-000000", state, log, api: new SlackWebApi("xoxb-synthetic-test-only-000000", url), socket: () => new SocketModeClient({ appToken: "xapp-synthetic-test-only-000000", clientOptions: { slackApiUrl: url, retryConfig: { retries: 0 } }, logLevel: LogLevel.ERROR }) });
  const channel = new SlackChannel(bot, "TTEST:DTEST");
  const config = { kind: "slack-private" as const, token: "xoxb-synthetic", appToken: "xapp-synthetic", chat: "TTEST:DTEST", pets: ["sibling", "owl"], default: "sibling" };
  channel.setMainPlace(petPlaceKey("sibling", channelKey(config)));
  const house: House = { name: "work", network: { kind: "allowlist", allow: [] }, people: { owners: [{ platform: "slack", id: "TTEST:UOWNER" }] }, pets: [{ name: "sibling" }, { name: "owl", title: "Owl" }], channels: [config] };
  const drafts: { pet: string; draft: MessageDraft }[] = [];
  let interrupted: string | undefined;
  const chat = new Chat({
    send: (_house, pet, draft) => { drafts.push({ pet, draft }); return { activity: "idle", queued: 1 }; },
    answered() {}, reject: () => true,
    interrupt: async (_house, pet) => { interrupted = pet; return { status: "stopped" }; },
  }, () => new Map([["work", new Map([[channelKey(config), { channel }]])]]), log, new Dialogs(log), state);
  let envelope = 0;
  const emit = (payload: object, type = "events_api") => {
    const id = `envelope-${++envelope}`;
    socket!.send(JSON.stringify({ type, envelope_id: id, payload, accepts_response_payload: false }));
    return id;
  };
  const message = (event: object) => emit({ team_id: "TTEST", event_id: `Ev${envelope + 1}`, event: { type: "message", channel: "DTEST", user: "UOWNER", ts: `1700000010.${String(envelope + 1).padStart(6, "0")}`, text: "Hello", ...event } });
  try {
    await chat.setHouses([house]);
    await waitFor(() => !!socket && posts.length === 1);
    message({ text: "Owl, plan the checks" });
    await waitFor(() => drafts.length === 1);
    expect(drafts[0]!.pet).toBe("owl");
    expect(drafts[0]!.draft.header?.from?.trust).toBe("owner");
    expect(JSON.stringify(drafts[0])).not.toContain("xoxb");
    expect(chat.replyFormat("work", "owl", "c1").name).toBe("slack-mrkdwn");
    const reply = await chat.reply("work", "owl", "*Ready* — review the plan", undefined, "c1");
    const root = state.get(`slack.TTEST.DTEST.thread.${petPlaceKey("owl", channelKey(config))}`)!;
    expect(posts.at(-1)?.thread_ts).toBe(root);
    await chat.editReply("work", "owl", reply.channel, reply.id, "*Ready* — checks passed");
    expect(posts.at(-1)?.text).toContain("checks passed");
    message({ text: "!stop", thread_ts: root });
    await waitFor(() => interrupted === "owl");
    expect(drafts).toHaveLength(1); // Stop is not a prompt.
    const decision = chat.ownerCard("work", "owl", {
      text: "Allow api.example.com?", start: "waiting",
      view: value => value === "waiting" ? { choices: [["Allow"], ["Deny"]] } : { outcome: value },
      press: (_state, index) => index === 0 ? "allowed" : "denied",
    }, new AbortController().signal);
    await waitFor(() => posts.at(-1)?.text?.includes("Allow api.example.com?"));
    const card = posts.at(-1)!;
    const press = (user: string) => emit({ type: "block_actions", team: { id: "TTEST" }, channel: { id: "DTEST" }, user: { id: user }, message: { ts: card.ts, thread_ts: root }, container: { message_ts: card.ts }, actions: [{ action_id: "household_choice_1", value: "1", action_ts: `1700000020.${String(envelope).padStart(6, "0")}`, text: { text: "Deny" } }] }, "interactive");
    press("UGUEST");
    await waitFor(() => calls.some(call => call.method === "chat.postEphemeral"));
    expect(calls.find(call => call.method === "chat.postEphemeral")?.params.text).toContain("Only the owner");
    press("UOWNER");
    expect(await decision).toBe("denied");
    await waitFor(() => acks.length === envelope);
    expect(JSON.stringify(card.blocks)).not.toContain("household_choice");
    expect(acks).toHaveLength(4);
    const beforeMain = posts.length;
    message({ text: "Hello default pet" });
    await waitFor(() => drafts.length === 2);
    expect(drafts[1]!.pet).toBe("sibling");
    chat.onDelivery({ kind: "delivered", house: "work", pet: "sibling", messages: [{ ...drafts[1]!.draft, id: 1, status: "delivered" }] });
    await chat.reply("work", "sibling", "Direct main reply", [["Continue"]], "c1");
    expect(posts).toHaveLength(beforeMain + 1); // No root or inbox-to-thread duplicate notices.
    expect(posts.at(-1)?.thread_ts).toBeUndefined();
    expect(posts.at(-1)?.text).toContain("Direct main reply");
    message({ text: "!stop" });
    await waitFor(() => interrupted === "sibling");
  } finally { await chat.stop(); server.stop(true); state.close(); }
}, 15_000);
