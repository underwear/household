import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { houseInboxSchema } from "../src/core/house-inboxes";
import type { HouseView, InboxView, PetView } from "./api";
import { HouseInboxesPage, PetInboxes, everyWords, inboxState, subscribedCount } from "./components/house-inboxes";

const pet = (name: string, title: string, emoji: string) => ({ name, title, emoji, display: `${emoji} ${title}` }) as PetView;
const HOUSE = {
  name: "work",
  pets: [pet("sibling", "Sibling", "🐾"), pet("chair", "Chair", "🪑")],
  channels: [
    { chat: "1", name: "DM", pets: ["sibling", "chair"] },
    { chat: "2", name: "Slack", pets: ["sibling"] },
  ],
} as unknown as HouseView;
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

test("a pet's Inboxes tab: a Receives and a Silent switch per inbox; a channel it is not in says how to join", () => {
  const items = [
    view({ name: "mail", title: "Work mail", pets: ["sibling"], quiet: ["sibling"], delivery: "silent" }),
    view({ name: "health", title: "Prod health", channel: "2", source: { kind: "health", url: "https://example.com/healthz" } }),
  ];
  const notify = () => {};
  const html = (name: "sibling" | "chair") => renderToStaticMarkup(<PetInboxes house={HOUSE} pet={HOUSE.pets.find((p) => p.name === name)!} inboxes={{ items, error: "", now: 0, refresh: async () => {} }} notify={notify} />);
  const sibling = html("sibling");
  expect(sibling.match(/role="switch" aria-checked="true"/g)).toHaveLength(2); // receives Work mail, silently
  expect(sibling).toContain("The only subscriber of a pets-only inbox.");
  expect(sibling).toContain("pets only, replies in DM");
  const chair = html("chair");
  expect(chair).toContain("Not in Slack");
  expect(chair).not.toContain('aria-checked="true"');
  expect(subscribedCount(items, "sibling")).toBe(1);
  expect(subscribedCount(undefined, "sibling")).toBe(0);
});

test("the house's Inboxes page renders in the design's parts while it loads", () => {
  const html = renderToStaticMarkup(<HouseInboxesPage house={HOUSE} notify={() => {}} />);
  expect(html).toContain('<h1 class="h1" tabindex="-1">Inboxes</h1>');
  expect(html).toContain('<button class="btn primary">+ Add inbox</button>');
  expect(html).toContain("Loading…");
  expect(html).toContain('class="text-link"');
});
