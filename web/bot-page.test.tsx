import { WorkspaceSideworkers, PendingSideworkerRow } from "./components/bot-sideworkers";
import { routeOf } from "./router";
import { withWorkers } from "./components/bot-state";
import { WorkspaceOverviewPage } from "./components/workspace-overview";
import { BotsPage } from "./components/bots";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceView, BotView } from "./api";
import { BotChannels, placing } from "./components/bot-channels";
import { BotDetailPage } from "./components/bot-detail";
import { botPath } from "./router";

test("joining and leaving a channel: who stays the default", () => {
  expect(placing({ pets: [], default: null }, "owl", true)).toEqual({ pets: ["owl"], default: null }); // alone: the default by being alone
  expect(placing({ pets: ["cat"], default: null }, "owl", true)).toEqual({ pets: ["cat", "owl"], default: "cat" }); // the one there already
  expect(placing({ pets: ["cat", "dog"], default: "dog" }, "owl", true)).toEqual({ pets: ["cat", "dog", "owl"], default: "dog" });
  expect(placing({ pets: ["cat", "owl", "dog"], default: "owl" }, "owl", false)).toEqual({ pets: ["cat", "dog"], default: "cat" }); // hands it on
  expect(placing({ pets: ["cat", "owl"], default: "owl" }, "owl", false)).toEqual({ pets: ["cat"], default: null });
  expect(placing({ pets: ["cat", "owl", "dog"], default: "dog" }, "owl", false)).toEqual({ pets: ["cat", "dog"], default: "dog" });
});

const owl: BotView = { name: "owl", title: "Owl", ownTitle: "Owl", display: "🦉 Owl", emoji: "🦉", ownEmoji: "🦉", aliases: [], agent: "a", model: "m", settings: {}, mode: null, key: "k", problem: null, state: "running" };
const cat: BotView = { ...owl, name: "cat", title: "Cat", ownTitle: null, display: "🐈 Cat", emoji: "🐈" };
const channel = (chat: string, pets: string[], first: string | null) => ({ kind: "telegram-private", platform: "telegram", label: "Telegram Bot DM (threaded)", name: chat, ownName: chat, note: null, fields: {}, shown: {}, chat, pets, default: first, problem: null });
const house: WorkspaceView = { name: "work", allow: [], owners: [], pets: [owl, cat], channels: [channel("home", ["owl", "cat"], "cat"), channel("lab", [], null)] };
const capacity = { host: { cpus: 10, memoryMiB: 32768 }, houses: [house] };

test("a bot's page: tabs by path and Channels without a notification-like counter", () => {
  expect(botPath("work", "owl")).toBe("/workspaces/work/bots/owl");
  expect(botPath("work", "owl", "tasks")).toBe("/workspaces/work/bots/owl/tasks");
  const page = renderToStaticMarkup(<BotDetailPage house={house} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(page).toContain('<a href="/workspaces/work/bots/owl" class="tab current" aria-current="page">Overview</a>');
  expect(page).toContain('<a href="/workspaces/work/bots/owl/channels" class="tab">Channels</a>');
  expect(page).toContain('<a href="/workspaces/work/bots/owl/harness" class="tab">Harness</a>');
  expect(page).toContain('<button type="button" class="btn">Logs</button>'); // a panel from the header, beside Console
  expect(page).not.toContain('href="/workspaces/work/bots/owl/logs"');
  expect(page).toContain(">Scheduled tasks</span>"); // the overview's tiles: next and last run in one
  expect(page).toContain('<a href="/workspaces/work/bots/owl/resources" class="stat">'); // its CPU, RAM and disk now
  expect(page).not.toContain("Last run");
  expect(page).toContain("Remove bot");
  const tasks = renderToStaticMarkup(<BotDetailPage house={house} pet={owl} tab="tasks" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(tasks).toContain("Scheduled tasks");
  expect(tasks).not.toContain("Remove bot");
});

test("a bot's channels: a switch each, the default marked, Make default where it shares a channel", () => {
  const html = renderToStaticMarkup(<BotChannels house={house} pet={owl} platforms={[]} refresh={async () => {}} notify={() => {}} />);
  expect(html.match(/role="switch"/g)).toHaveLength(2);
  expect(html).toContain('aria-checked="true" aria-label="Owl in home · Telegram Bot DM (threaded)"');
  expect(html).toContain('aria-checked="false" aria-label="Owl in lab · Telegram Bot DM (threaded)"');
  expect(html).toContain(">Make default<"); // cat is the default in home
  expect(html).toContain('<span class="chip-note">default</span>'); // on cat's chip
  expect(html).toContain("No bots yet"); // lab
});

test("bot actions offer Restart and provide an Environment tab", () => {
  const page = renderToStaticMarkup(<BotDetailPage house={house} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(page).toContain('>Restart</button>');
  expect(page).not.toContain('>Environment</button>');
  expect(page).toContain('href="/workspaces/work/bots/owl/environment" class="tab">Environment</a>');
});

test("restarting asks how: let the harness save its work first (the default), or now", async () => {
  const { RestartDialog } = await import("./components/bots");
  const html = renderToStaticMarkup(<RestartDialog house="work" pet={owl} onClose={() => {}} onRestarted={() => {}} />);
  expect(html).toContain("Let it save its work first");
  expect(html).toContain('checked="" value="notify"');
  expect(html).toContain(">Restart</button>");
  expect(html.match(/<button/g)).toHaveLength(2); // Cancel and Restart: one way out, one way on
});

test("a bot's Skills tab: its personal ones to edit, and a line to the workspace's and Household's", () => {
  const html = renderToStaticMarkup(<BotDetailPage house={house} pet={owl} tab="skills" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain('href="/workspaces/work/bots/owl/skills" class="tab current"');
  expect(html).toContain('<h2 class="h2">Personal</h2>'); // its own, edited here
  expect(html).toContain('href="/workspaces/work/skills" class="text-link">the shared and the built-in skills</a>'); // the others are on the workspace's page
  expect(html.match(/<h1/g)).toHaveLength(1); // a tab under the bot's title, not a page of its own
});

test("a bot's lifecycle: Disable is on its Overview, a disabled bot says so above every tab with Enable", () => {
  const on = renderToStaticMarkup(<BotDetailPage house={house} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(on).toContain(">AGENTS.md</a>"); // the tab: CLAUDE.md or AGENTS.md, by the harness
  expect(on).toContain("Disable bot");
  expect(on).not.toContain('class="bot-off"');
  const off = { ...owl, enabled: false, state: "disabled" };
  const tasks = renderToStaticMarkup(<BotDetailPage house={{ ...house, pets: [off, cat] }} pet={off} tab="tasks" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(tasks).toContain('class="bot-off"');
  expect(tasks).toContain(">Enable</button>");
  expect(tasks).toMatch(/<button type="button" class="btn" disabled="">Restart<\/button>/);
});

test("a bot's Harness tab: what runs it, saved together; nothing to save until something changes", async () => {
  const { BotHarness } = await import("./components/bot-harness");
  const agents = [{ name: "a", models: ["m"], defaultModel: "m", providers: ["anthropic"], modes: [] }] as never;
  const html = renderToStaticMarkup(<BotHarness house="work" pet={owl} agents={agents} keys={[]} refresh={async () => {}} notify={() => {}} />);
  for (const label of [">Harness<", ">Key<", ">Model<", ">Reasoning effort<"]) expect(html).toContain(label);
  expect(html).toContain('<button type="submit" class="btn primary" disabled="">Save</button>');
  expect(html).not.toContain("Saving restarts");
});

test("sideworker detail identifies its parent and offers only readable runtime tabs and close", () => {
  const worker = { ...owl, name: "sw-test", title: "sw-test", sideworker: { parent: "owl", cwd: "/home/agent/projects/demo" } };
  const ownWorkspace = { ...house, pets: [...house.pets, worker] };
  const html = renderToStaticMarkup(<BotDetailPage house={ownWorkspace} pet={worker} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain("Sideworker of");
  expect(html).toContain('/home/agent/projects/demo');
  expect(html).toContain("Close sideworker");
  expect(html).toContain('href="/workspaces/work/sideworkers" class="stat"'); // its parent's tile: to the workspace's Sideworkers
  expect(html).not.toContain('class="btn danger">'); // closing is at the foot of Overview, not in the header
  for (const action of ["Edit bot", "Disable bot", "Remove bot", "Scheduled tasks", ">Environment</a>", ">AGENTS.md</a>", ">Harness</a>", ">Restart</button>"]) expect(html).not.toContain(action);
  for (const tab of ["Skills", "Memory", "Resources"]) expect(html).toContain(`>${tab}</a>`);
  const forged = renderToStaticMarkup(<BotDetailPage house={ownWorkspace} pet={worker} tab="tasks" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(forged).not.toContain("Scheduled tasks");
  // Its parent has no Sideworkers tab: a tile on its Overview counts them and leads to the workspace's page.
  const parent = renderToStaticMarkup(<BotDetailPage house={ownWorkspace} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(parent).not.toContain(">Sideworkers<span");
  expect(parent).not.toContain('href="/workspaces/work/bots/owl/sideworkers"');
  expect(parent).toMatch(/href="\/workspaces\/work\/sideworkers" class="stat">.*Sideworkers.*<span class="stat-value">1<\/span><span class="stat-sub">1 running<\/span>/);
  expect(routeOf("/workspaces/work/bots/owl/sideworkers")).toEqual({ page: "redirect", to: "/workspaces/work/sideworkers" });
});


test("a worker awaiting cleanup stays visible with a retry action, without its VM size", () => {
  const html = renderToStaticMarkup(<PendingSideworkerRow worker={{ house: "work", name: "sw-retry", parent: "owl", cwd: "/home/agent/work", cpus: 2, memoryMiB: 1024, createdAt: 1, closing: true }} parent={null} onRetry={() => {}} />);
  expect(html).toContain("sw-retry");
  expect(html).toContain("Cleanup pending");
  expect(html).toContain("it still holds its share of the workspace&#x27;s budget");
  expect(html).toContain("Retry close");
  expect(html).not.toContain("vCPU");
  expect(html).not.toContain('href=');
});

test("sideworkers sit under the bot that started them, not beside it as bots", () => {
  const worker = { ...owl, name: "sw-test", title: "sw-test", sideworker: { parent: "owl", cwd: "/home/agent/projects/demo" } };
  const ownWorkspace = { ...house, pets: [worker, ...house.pets] };
  const order = withWorkers(ownWorkspace.pets).map((pet) => pet.name);
  expect(order.indexOf("sw-test")).toBe(order.indexOf("owl") + 1);
  const overview = renderToStaticMarkup(<WorkspaceOverviewPage house={ownWorkspace} />);
  expect(overview).toContain('<span class="sideworker-branch" aria-hidden="true">↳</span>');
  expect(overview).toMatch(/href="\/workspaces\/work\/sideworkers" class="stat">.*<span class="stat-value">1<\/span>/); // the workspace's tile
  const cards = renderToStaticMarkup(<BotsPage house={ownWorkspace} ask={() => {}} save={async () => {}} agents={[]} capacity={capacity} />);
  expect(cards).not.toContain('href="/workspaces/work/bots/sw-test"');
  expect(cards).toContain("1 sideworker");
});

test("a workspace's Sideworkers page lists them in one list, each with the bot that started it", () => {
  const worker = { ...owl, name: "sw-test", title: "sw-test", sideworker: { parent: "owl", cwd: "/home/agent/projects/demo" } };
  const html = renderToStaticMarkup(<WorkspaceSideworkers house={{ ...house, pets: [...house.pets, worker] }} refresh={async () => {}} />);
  expect(html).toContain('<h2 class="h2">Running</h2>');
  expect(html).toContain(">Started by<");
  expect(html).toContain('<a href="/workspaces/work/bots/owl" class="row-link ellipsis">'); // the bot that started it
  expect(html).toContain('href="/workspaces/work/bots/sw-test"');
  expect(html).toContain(">Close…</button>");
  expect(renderToStaticMarkup(<WorkspaceSideworkers house={house} refresh={async () => {}} />)).toContain("None running.");
});

test("a bot's Lifecycle tab, after AGENTS.md: its schedule, notice and both messages, the defaults filled in", () => {
  const nightly = { ...owl, lifecycle: { enabled: true, every: "daily" as const, at: "04:00", notice: 5 } };
  const page = renderToStaticMarkup(<BotDetailPage house={house} pet={nightly} tab="lifecycle" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(page.indexOf(">AGENTS.md</a>")).toBeLessThan(page.indexOf(">Lifecycle</a>"));
  expect(page).toContain('href="/workspaces/work/bots/owl/lifecycle" class="tab current" aria-current="page">Lifecycle</a>');
  expect(page).toContain("Restarts every day at 04:00");
  expect(page).toContain('value="04:00"');
  expect(page).toContain("Shutdown message");
  expect(page).toContain("~/work/HANDOFF.md");
  expect(page).not.toContain("Reset to default");
  // A bot without one: the defaults, switched off.
  const off = renderToStaticMarkup(<BotDetailPage house={house} pet={owl} tab="lifecycle" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(off).toContain("Never restarted on a schedule.");
  expect(off).not.toContain('type="time"');
  expect(off).not.toContain("<textarea"); // its messages only while it is on
  expect(page.match(/<textarea/g)).toHaveLength(2);
  expect(routeOf("/workspaces/work/bots/owl/lifecycle")).toEqual({ page: "bot", workspace: "work", bot: "owl", tab: "lifecycle" });
});
