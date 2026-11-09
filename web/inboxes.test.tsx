import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { houseInboxSchema } from "../src/core/house-inboxes";
import type { ChannelKindView, ChannelView, WorkspaceView, InboxView, BotView } from "./api";
import { SlackSetup, slackUrl } from "./components/slack-setup";
import { WorkspaceInboxesPage, BotInboxes, everyWords, inboxState, subscribedCount } from "./components/workspace-inboxes";

const pet = (name: string, title: string, emoji: string) => ({ name, title, emoji, display: `${emoji} ${title}` }) as BotView;
const WORKSPACE = {
  name: "work",
  pets: [pet("sibling", "Sibling", "🤖"), pet("chair", "Chair", "🪑")],
  channels: [
    { chat: "1", name: "DM", pets: ["sibling", "chair"] },
    { chat: "2", name: "Slack", pets: ["sibling"] },
  ],
} as unknown as WorkspaceView;
const status = { initialized: true, recent: [], nextCheck: 0, failures: 0, pendingCount: 0, running: false };
const view = (inbox: object, more: Partial<InboxView["status"]> = {}): InboxView => ({
  inbox: houseInboxSchema.parse({ title: "Mail", channel: "1", pets: [], intervalSeconds: 300, source: { kind: "rss", url: "https://example.com/feed" }, ...inbox }),
  status: { ...status, ...more },
});

test("an inbox's interval and state in words", () => {
  expect(everyWords(60)).toBe("every minute");
  expect(everyWords(300)).toBe("every 5 min");
  expect(everyWords(7200)).toBe("every 2 h");
  expect(everyWords(86400)).toBe("daily");
  expect(inboxState(view({ name: "a" }))).toEqual({ tone: "idle", label: "Watching" });
  expect(inboxState(view({ name: "a", enabled: false }, { error: "down", failures: 5 }))).toEqual({ tone: "off", label: "Paused" });
  expect(inboxState(view({ name: "a" }, { error: "down", failures: 1 }))).toEqual({ tone: "busy", label: "Retrying" });
  expect(inboxState(view({ name: "a" }, { error: "down", failures: 3 }))).toEqual({ tone: "danger", label: "Needs attention" });
  expect(inboxState(view({ name: "a" }, { initialized: false }))).toEqual({ tone: "busy", label: "First check soon" });
});

test("a bot's Inboxes tab: a Receives and a Silent switch per inbox; a channel it is not in says how to join", () => {
  const items = [
    view({ name: "mail", title: "Work mail", pets: ["sibling"], quiet: ["sibling"], delivery: "silent" }),
    view({ name: "health", title: "Prod health", channel: "2", source: { kind: "health", url: "https://example.com/healthz" } }),
  ];
  const notify = () => {};
  const html = (name: "sibling" | "chair") => renderToStaticMarkup(<BotInboxes house={WORKSPACE} pet={WORKSPACE.pets.find((p) => p.name === name)!} inboxes={{ items, error: "", now: 0, refresh: async () => {} }} notify={notify} />);
  const sibling = html("sibling");
  expect(sibling.match(/role="switch" aria-checked="true"/g)).toHaveLength(2); // receives Work mail, silently
  expect(sibling).toContain("The only subscriber of a bots-only inbox.");
  expect(sibling).toContain("bots only, replies in DM");
  const chair = html("chair");
  expect(chair).toContain("Not in Slack");
  expect(chair).not.toContain('aria-checked="true"');
  expect(subscribedCount(items, "sibling")).toBe(1);
  expect(subscribedCount(undefined, "sibling")).toBe(0);
});

test("the workspace's Inboxes page renders in the design's parts while it loads", () => {
  const html = renderToStaticMarkup(<WorkspaceInboxesPage house={WORKSPACE} notify={() => {}} />);
  expect(html).toContain('<h1 class="h1" tabindex="-1">Inboxes</h1>');
  expect(html).toContain('<button class="btn primary">+ Add inbox</button>');
  expect(html).toContain("Loading…");
  expect(html).toContain('class="text-link"');
});

test("a Slack DM's edit form is one form, as every channel's: no folded settings, its DM read only with a way to it", () => {
  const spec = { kind: "slack-private", label: "Slack Bot DM", chat: { label: "Workspace:DM" } } as unknown as ChannelKindView;
  const channel = { kind: "slack-private", label: "Slack Bot DM", name: "Slack", ownName: "Slack", chat: "T01:D02", fields: { token: "xoxb-x", appToken: "xapp-x" }, pets: ["sibling"], default: null, note: null } as unknown as ChannelView;
  const html = renderToStaticMarkup(<SlackSetup house={WORKSPACE} spec={spec} channel={channel} onClose={() => {}} back={() => {}} save={async () => {}} />);
  expect(html).toContain("Edit Slack · Slack Bot DM");
  expect(html).not.toContain("<details");
  expect(html).toContain('href="https://app.slack.com/client/T01/D02"');
  expect(html).toContain("Socket Mode app token");
  expect(slackUrl("T01:D02")).toBe("https://app.slack.com/client/T01/D02");
});
