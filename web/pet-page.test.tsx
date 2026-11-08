import { HouseSideworkers, PendingSideworkerRow } from "./components/pet-sideworkers";
import { routeOf } from "./router";
import { withWorkers } from "./components/pet-state";
import { HouseOverviewPage } from "./components/house-overview";
import { PetsPage } from "./components/pets";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { HouseView, PetView } from "./api";
import { PetChannels, placing } from "./components/pet-channels";
import { PetDetailPage } from "./components/pet-detail";
import { petPath } from "./router";

test("joining and leaving a channel: who stays the default", () => {
  expect(placing({ pets: [], default: null }, "owl", true)).toEqual({ pets: ["owl"], default: null }); // alone: the default by being alone
  expect(placing({ pets: ["cat"], default: null }, "owl", true)).toEqual({ pets: ["cat", "owl"], default: "cat" }); // the one there already
  expect(placing({ pets: ["cat", "dog"], default: "dog" }, "owl", true)).toEqual({ pets: ["cat", "dog", "owl"], default: "dog" });
  expect(placing({ pets: ["cat", "owl", "dog"], default: "owl" }, "owl", false)).toEqual({ pets: ["cat", "dog"], default: "cat" }); // hands it on
  expect(placing({ pets: ["cat", "owl"], default: "owl" }, "owl", false)).toEqual({ pets: ["cat"], default: null });
  expect(placing({ pets: ["cat", "owl", "dog"], default: "dog" }, "owl", false)).toEqual({ pets: ["cat", "dog"], default: "dog" });
});

const owl: PetView = { name: "owl", title: "Owl", ownTitle: "Owl", display: "🦉 Owl", emoji: "🦉", ownEmoji: "🦉", aliases: [], agent: "a", model: "m", settings: {}, mode: null, key: "k", problem: null, state: "running" };
const cat: PetView = { ...owl, name: "cat", title: "Cat", ownTitle: null, display: "🐈 Cat", emoji: "🐈" };
const channel = (chat: string, pets: string[], first: string | null) => ({ kind: "telegram-private", platform: "telegram", label: "Telegram Bot DM (threaded)", name: chat, ownName: chat, note: null, fields: {}, shown: {}, chat, pets, default: first, problem: null });
const house: HouseView = { name: "work", allow: [], owners: [], pets: [owl, cat], channels: [channel("home", ["owl", "cat"], "cat"), channel("lab", [], null)] };
const capacity = { host: { cpus: 10, memoryMiB: 32768 }, houses: [house] };

test("a pet's page: tabs by path and Channels without a notification-like counter", () => {
  expect(petPath("work", "owl")).toBe("/houses/work/pets/owl");
  expect(petPath("work", "owl", "tasks")).toBe("/houses/work/pets/owl/tasks");
  const page = renderToStaticMarkup(<PetDetailPage house={house} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(page).toContain('<a href="/houses/work/pets/owl" class="tab current" aria-current="page">Overview</a>');
  expect(page).toContain('<a href="/houses/work/pets/owl/channels" class="tab">Channels</a>');
  expect(page).toContain('<a href="/houses/work/pets/owl/agent" class="tab">Agent</a>');
  expect(page).toContain('<button type="button" class="btn">Logs</button>'); // a panel from the header, beside Console
  expect(page).not.toContain('href="/houses/work/pets/owl/logs"');
  expect(page).toContain(">Scheduled tasks</span>"); // the overview's tiles: next and last run in one
  expect(page).toContain('<a href="/houses/work/pets/owl/resources" class="stat">'); // its CPU, RAM and disk now
  expect(page).not.toContain("Last run");
  expect(page).toContain("Remove pet");
  const tasks = renderToStaticMarkup(<PetDetailPage house={house} pet={owl} tab="tasks" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(tasks).toContain("Scheduled tasks");
  expect(tasks).not.toContain("Remove pet");
});

test("a pet's channels: a switch each, the default marked, Make default where it shares a channel", () => {
  const html = renderToStaticMarkup(<PetChannels house={house} pet={owl} platforms={[]} refresh={async () => {}} notify={() => {}} />);
  expect(html.match(/role="switch"/g)).toHaveLength(2);
  expect(html).toContain('aria-checked="true" aria-label="Owl in home · Telegram Bot DM (threaded)"');
  expect(html).toContain('aria-checked="false" aria-label="Owl in lab · Telegram Bot DM (threaded)"');
  expect(html).toContain(">Make default<"); // cat is the default in home
  expect(html).toContain('<span class="chip-note">default</span>'); // on cat's chip
  expect(html).toContain("No pets yet"); // lab
});

test("pet actions offer Restart and provide an Environment tab", () => {
  const page = renderToStaticMarkup(<PetDetailPage house={house} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(page).toContain('>Restart</button>');
  expect(page).not.toContain('>Environment</button>');
  expect(page).toContain('href="/houses/work/pets/owl/environment" class="tab">Environment</a>');
});

test("restarting asks how: let the agent save its work first (the default), or now", async () => {
  const { RestartDialog } = await import("./components/pets");
  const html = renderToStaticMarkup(<RestartDialog house="work" pet={owl} onClose={() => {}} onRestarted={() => {}} />);
  expect(html).toContain("Let it save its work first");
  expect(html).toContain('checked="" value="notify"');
  expect(html).toContain(">Restart</button>");
  expect(html.match(/<button/g)).toHaveLength(2); // Cancel and Restart: one way out, one way on
});

test("a pet's Skills tab: its personal ones to edit, and a line to the house's and Household's", () => {
  const html = renderToStaticMarkup(<PetDetailPage house={house} pet={owl} tab="skills" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain('href="/houses/work/pets/owl/skills" class="tab current"');
  expect(html).toContain('<h2 class="h2">Personal</h2>'); // its own, edited here
  expect(html).toContain('href="/houses/work/skills" class="text-link">the shared and the built-in skills</a>'); // the others are on the house's page
  expect(html.match(/<h1/g)).toHaveLength(1); // a tab under the pet's title, not a page of its own
});

test("a pet's lifecycle: Disable is on its Overview, a disabled pet says so above every tab with Enable", () => {
  const on = renderToStaticMarkup(<PetDetailPage house={house} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(on).toContain(">Instructions</a>"); // the tab: CLAUDE.md or AGENTS.md, by the agent
  expect(on).toContain("Disable pet");
  expect(on).not.toContain('class="pet-off"');
  const off = { ...owl, enabled: false, state: "disabled" };
  const tasks = renderToStaticMarkup(<PetDetailPage house={{ ...house, pets: [off, cat] }} pet={off} tab="tasks" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(tasks).toContain('class="pet-off"');
  expect(tasks).toContain(">Enable</button>");
  expect(tasks).toMatch(/<button type="button" class="btn" disabled="">Restart<\/button>/);
});

test("a pet's Agent tab: what runs it, saved together; nothing to save until something changes", async () => {
  const { PetAgent } = await import("./components/pet-agent");
  const agents = [{ name: "a", models: ["m"], defaultModel: "m", providers: ["anthropic"], modes: [] }] as never;
  const html = renderToStaticMarkup(<PetAgent house="work" pet={owl} agents={agents} keys={[]} refresh={async () => {}} notify={() => {}} />);
  for (const label of [">Agent<", ">Key<", ">Model<", ">Reasoning effort<"]) expect(html).toContain(label);
  expect(html).toContain('<button type="submit" class="btn primary" disabled="">Save</button>');
  expect(html).not.toContain("Saving restarts");
});

test("sideworker detail identifies its parent and offers only readable runtime tabs and close", () => {
  const worker = { ...owl, name: "sw-test", title: "sw-test", sideworker: { parent: "owl", cwd: "/home/agent/projects/demo" } };
  const ownHouse = { ...house, pets: [...house.pets, worker] };
  const html = renderToStaticMarkup(<PetDetailPage house={ownHouse} pet={worker} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain("Sideworker of");
  expect(html).toContain('/home/agent/projects/demo');
  expect(html).toContain("Close sideworker");
  expect(html).toContain('href="/houses/work/sideworkers" class="stat"'); // its parent's tile: to the house's Sideworkers
  expect(html).not.toContain('class="btn danger">'); // closing is at the foot of Overview, not in the header
  for (const action of ["Edit pet", "Disable pet", "Remove pet", "Scheduled tasks", ">Environment</a>", ">Instructions</a>", ">Agent</a>", ">Restart</button>"]) expect(html).not.toContain(action);
  for (const tab of ["Skills", "Memory", "Resources"]) expect(html).toContain(`>${tab}</a>`);
  const forged = renderToStaticMarkup(<PetDetailPage house={ownHouse} pet={worker} tab="tasks" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(forged).not.toContain("Scheduled tasks");
  // Its parent has no Sideworkers tab: a tile on its Overview counts them and leads to the house's page.
  const parent = renderToStaticMarkup(<PetDetailPage house={ownHouse} pet={owl} agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(parent).not.toContain(">Sideworkers<span");
  expect(parent).not.toContain('href="/houses/work/pets/owl/sideworkers"');
  expect(parent).toMatch(/href="\/houses\/work\/sideworkers" class="stat">.*Sideworkers.*<span class="stat-value">1<\/span><span class="stat-sub">1 running<\/span>/);
  expect(routeOf("/houses/work/pets/owl/sideworkers")).toEqual({ page: "redirect", to: "/houses/work/sideworkers" });
});


test("a worker awaiting cleanup stays visible with a retry action and resource allocation", () => {
  const html = renderToStaticMarkup(<PendingSideworkerRow worker={{ house: "work", name: "sw-retry", parent: "owl", cwd: "/home/agent/work", cpus: 2, memoryMiB: 1024, createdAt: 1, closing: true }} parent={null} onRetry={() => {}} />);
  expect(html).toContain("sw-retry");
  expect(html).toContain("Cleanup pending");
  expect(html).toContain("it still counts toward the limit");
  expect(html).toContain("Retry close");
  expect(html).toContain("2 vCPU · 1 GiB");
  expect(html).not.toContain('href=');
});

test("sideworkers sit under the pet that started them, not beside it as pets", () => {
  const worker = { ...owl, name: "sw-test", title: "sw-test", sideworker: { parent: "owl", cwd: "/home/agent/projects/demo" } };
  const ownHouse = { ...house, pets: [worker, ...house.pets] };
  const order = withWorkers(ownHouse.pets).map((pet) => pet.name);
  expect(order.indexOf("sw-test")).toBe(order.indexOf("owl") + 1);
  const overview = renderToStaticMarkup(<HouseOverviewPage house={ownHouse} />);
  expect(overview).toContain('<span class="sideworker-branch" aria-hidden="true">↳</span>');
  expect(overview).toMatch(/href="\/houses\/work\/sideworkers" class="stat">.*<span class="stat-value">1<\/span>/); // the house's tile
  const cards = renderToStaticMarkup(<PetsPage house={ownHouse} ask={() => {}} save={async () => {}} agents={[]} capacity={capacity} />);
  expect(cards).not.toContain('href="/houses/work/pets/sw-test"');
  expect(cards).toContain("1 sideworker");
});

test("a house's Sideworkers page lists them in one list, each with the pet that started it", () => {
  const worker = { ...owl, name: "sw-test", title: "sw-test", sideworker: { parent: "owl", cwd: "/home/agent/projects/demo" } };
  const html = renderToStaticMarkup(<HouseSideworkers house={{ ...house, pets: [...house.pets, worker] }} refresh={async () => {}} />);
  expect(html).toContain('<h2 class="h2">Running</h2>');
  expect(html).toContain(">Started by<");
  expect(html).toContain('<a href="/houses/work/pets/owl" class="row-link ellipsis">'); // the pet that started it
  expect(html).toContain('href="/houses/work/pets/sw-test"');
  expect(html).toContain(">Close…</button>");
  expect(renderToStaticMarkup(<HouseSideworkers house={house} refresh={async () => {}} />)).toContain("None running.");
});

test("a pet's Lifecycle tab, after Instructions: its schedule, notice and both messages, the defaults filled in", () => {
  const nightly = { ...owl, lifecycle: { enabled: true, every: "daily" as const, at: "04:00", notice: 5 } };
  const page = renderToStaticMarkup(<PetDetailPage house={house} pet={nightly} tab="lifecycle" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(page.indexOf(">Instructions</a>")).toBeLessThan(page.indexOf(">Lifecycle</a>"));
  expect(page).toContain('href="/houses/work/pets/owl/lifecycle" class="tab current" aria-current="page">Lifecycle</a>');
  expect(page).toContain("Restarts every day at 04:00");
  expect(page).toContain('value="04:00"');
  expect(page).toContain("Shutdown message");
  expect(page).toContain("~/work/HANDOFF.md");
  expect(page).not.toContain("Reset to default");
  // A pet without one: the defaults, switched off.
  const off = renderToStaticMarkup(<PetDetailPage house={house} pet={owl} tab="lifecycle" agents={[]} keys={[]} capacity={capacity} refresh={async () => {}} notify={() => {}} />);
  expect(off).toContain("Never restarted on a schedule.");
  expect(off).not.toContain('type="time"');
  expect(off).not.toContain("<textarea"); // its messages only while it is on
  expect(page.match(/<textarea/g)).toHaveLength(2);
  expect(routeOf("/houses/work/pets/owl/lifecycle")).toEqual({ page: "pet", house: "work", pet: "owl", tab: "lifecycle" });
});
