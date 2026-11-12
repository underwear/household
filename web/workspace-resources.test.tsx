import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CapacityDialog, FreeLink, ResourcesPage, overBudget, resourcesText } from "./components/workspace-resources";
import { useResourceForm } from "./components/bots";
import { workspaceBudget } from "../src/core/resources";
import type { WorkspaceView } from "./api";

const host = { cpus: 10, memoryMiB: 32768 };
const budget = workspaceBudget({ resources: { cpus: 8, memoryMiB: 8192 }, pets: [{ name: "sibling" }] }, [
  { name: "scout-one", kind: "scout", cpus: 2, memoryMiB: 2048, state: "waiting_approval" },
  { name: "fix-tests", kind: "sideworker", cpus: 2, memoryMiB: 1024, state: "closing" },
]);
const house = { name: "work", pets: [{ name: "sibling" }], resources: budget } as unknown as WorkspaceView;

test("Workspace · Resources: a meter per resource in words for screen readers, then who holds what, each state in words", () => {
  const html = renderToStaticMarkup(<ResourcesPage house={house} host={host} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain(">Resources<");
  expect(html).toContain("Change capacity…");
  expect(html).toContain('aria-label="CPU: 2 vCPU for bots, 4 vCPU for scouts and sideworkers, 2 vCPU free of 8 vCPU"');
  expect(html).toContain('aria-label="RAM: 1 GiB for bots, 3 GiB for scouts and sideworkers, 4 GiB free of 8 GiB"');
  expect(html).toContain("In use");
  expect(html).toContain("2</span><span class=\"muted\"> / 8 vCPU free");
  expect(html).toContain('href="/workspaces/work/bots/sibling/resources"'); // a bot's size is set on its own page
  expect(html).toContain("waiting for your approval");
  expect(html).toContain("being removed");
  expect(html).not.toContain("Over capacity");
});

test("more held than the capacity (an old config) is flagged; a capacity below what is held is refused before saving", () => {
  const over = { ...budget, total: { cpus: 4, memoryMiB: 8192 } };
  expect(overBudget(budget)).toBe(false);
  expect(overBudget(over)).toBe(true);
  const page = renderToStaticMarkup(<ResourcesPage house={{ ...house, resources: over } as WorkspaceView} host={host} refresh={async () => {}} notify={() => {}} />);
  expect(page).toContain("Over capacity");
  expect(page).toContain('class="resource-bar over"');
  const dialog = renderToStaticMarkup(<CapacityDialog house="work" budget={over} host={host} onClose={() => {}} save={async () => {}} />);
  expect(dialog).toContain("6 vCPU is held now: close a scout or sideworker first");
  expect(dialog).not.toContain("4 GiB is held now");
  const tight = renderToStaticMarkup(<CapacityDialog house="work" budget={{ ...budget, total: { cpus: 1, memoryMiB: 8192 } }} host={host} onClose={() => {}} save={async () => {}} />);
  expect(tight).toContain("Bots alone hold 2 vCPU: make one smaller first.");
});

test("scouts and sideworkers link to what is free instead of a count of their own", () => {
  expect(resourcesText({ cpus: 2, memoryMiB: 1536 })).toBe("2 vCPU · 1.5 GiB");
  expect(renderToStaticMarkup(<FreeLink house={house} />)).toBe('<a href="/workspaces/work/resources" class="text-link">2 vCPU · 4 GiB free</a>');
});

test("on a small host the capacity dialog opens within it, its RAM in whole steps (never «3.697265625 GiB»)", () => {
  const small = { cpus: 4, memoryMiB: 3786 };
  const dialog = renderToStaticMarkup(<CapacityDialog house="work" budget={workspaceBudget({ pets: [] })} host={small} onClose={() => {}} save={async () => {}} />);
  expect(dialog).toMatch(/value="4"[\s\S]*of 4 vCPU/);
  expect(dialog).toMatch(/value="3.625"[\s\S]*of 3.625 GiB/);
  expect(dialog).not.toContain("3.697");
});

test("a new bot's allocation is bounded by its workspace's capacity, and the line under it counts that capacity", () => {
  const tight = { name: "home", pets: [], resources: workspaceBudget({ resources: { cpus: 2, memoryMiB: 1024 }, pets: [] }) } as unknown as WorkspaceView;
  const Form = () => <>{useResourceForm({ host: { cpus: 4, memoryMiB: 3786 }, houses: [tight] }, "home").fields}</>;
  const html = renderToStaticMarkup(<Form />);
  expect(html).toMatch(/value="2"[\s\S]*of 2 vCPU/);
  expect(html).toMatch(/value="1"[\s\S]*of 1 GiB/);
  expect(html).toContain("In this workspace: 2 of 2 vCPU · 1 of 1 GiB");
  expect(html).not.toContain("of 4 vCPU");
});
