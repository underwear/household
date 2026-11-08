import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HouseFeatureSettings } from "./components/house-features";
import { HousePreviews, PetPreviews } from "./components/pet-previews";
import { PreviewReachSettings } from "./components/house-features";
import { Shell } from "./components/shell";
import { routeOf } from "./router";
import { HousePage } from "./components/house";
import type { HouseView, PreviewView } from "./api";

const house: HouseView = { name: "work", allow: [], owners: [], channels: [], pets: [] };
const settings = (view: HouseView) => renderToStaticMarkup(<HouseFeatureSettings house={view} refresh={async () => {}} notify={() => {}} />);

test("house features: a switch each, with a line on what it does; one that is on leads to its own page", () => {
  const off = settings({ ...house, features: { scouts: false, preview: false, sideworkers: false } });
  expect(off.match(/role="switch"/g)).toHaveLength(3);
  expect(off).toContain(">Sideworkers<");
  expect(off).toContain(">HTTP previews<");
  expect(off).not.toContain("Sideworker settings"); // off: nowhere to go
  expect(off).not.toContain("Preview settings");
  expect(off).not.toContain("Who can open"); // reach lives on the Previews page now
  const on = settings({ ...house, features: { scouts: false, preview: true, sideworkers: true } });
  expect(on).toContain('href="/houses/work/sideworkers" class="text-link">Sideworker settings</a>');
  expect(on).toContain('href="/houses/work/previews" class="text-link">Preview settings</a>');
});

test("preview reach: this computer only by default, addresses only for another one", () => {
  const reach = (view: HouseView) => renderToStaticMarkup(<PreviewReachSettings house={view} refresh={async () => {}} notify={() => {}} />);
  const local = reach({ ...house, features: { scouts: false, preview: true, sideworkers: true } });
  expect(local).toContain("This computer only");
  expect(local).not.toContain(">Listen on<"); // the default reach needs no addresses
  expect(local).toContain("Links have no login");
  const custom = reach({ ...house, features: { scouts: false, preview: true, sideworkers: true }, preview: { bindAddress: "0.0.0.0", publicHost: "mac-mini.local" } });
  expect(custom).toContain(">Listen on<");
  expect(custom).toContain('value="mac-mini.local"');
});

test("a pet's previews: one list with each link, its port and state; none at all while previews are off and none open", () => {
  const active: PreviewView = { id: "p1", house: "work", pet: "owl", port: 5173, title: "Landing", status: "active", url: "http://127.0.0.1:41873/", expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), requested_at: new Date().toISOString() };
  const pending: PreviewView = { id: "p2", house: "work", pet: "owl", port: 3000, title: "Docs", status: "pending", requested_at: new Date().toISOString() };
  const html = renderToStaticMarkup(<PetPreviews house="work" pet="owl" enabled initial={[active, pending]} />);
  expect(html).toContain('<h2 class="h2">Previews</h2>');
  expect(html).toContain('class="text-link mono ellipsis">http://127.0.0.1:41873/</a>');
  expect(html).toContain("min left");
  expect(html).toContain("Waiting for you in chat");
  expect(html).toContain(">Cancel</button>");
  expect(renderToStaticMarkup(<PetPreviews house="work" pet="owl" enabled />)).toContain("None open.");
  expect(renderToStaticMarkup(<PetPreviews house="work" pet="owl" enabled={false} />)).toBe("");
  expect(renderToStaticMarkup(<PetPreviews house="work" pet="owl" enabled={false} initial={[active]} />)).toContain("Landing"); // still open: still shown, to close
});

test("with sideworkers off, the house's Sideworkers page says so above everything, with the way back on", () => {
  const html = renderToStaticMarkup(<HousePage house={{ ...house, features: { scouts: false, preview: false, sideworkers: false } }} tab="sideworkers" known={{ agents: [] } as never} keys={[]} capacity={{ host: { cpus: 8, memoryMiB: 16384 } } as never} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain('<div class="pet-off" role="status">');
  expect(html).toContain("pets cannot start new ones");
  expect(html).toContain('href="/houses/work/settings" class="btn small">Turn on in Settings</a>');
  expect(html).not.toContain(">Running<"); // nothing under it: no workers, profiles or limits while off
  expect(html).not.toContain(">Limits<");
});

test("a house's Previews page: every pet's previews with whose each is, then who can open the links; off, only that it is off", () => {
  const owl = { name: "owl", title: "Owl", emoji: "🦉" } as HouseView["pets"][number];
  const on = { ...house, pets: [owl], features: { scouts: false, preview: true, sideworkers: true } };
  const preview: PreviewView = { id: "p1", house: "work", pet: "owl", port: 5173, title: "Landing", status: "pending", requested_at: new Date().toISOString() };
  const list = renderToStaticMarkup(<HousePreviews house={on} initial={[preview]} />);
  expect(list).toContain(">Pet<");
  expect(list).toContain('<a href="/houses/work/pets/owl" class="row-link ellipsis">Owl</a>');
  const page = (view: HouseView) => renderToStaticMarkup(<HousePage house={view} tab="previews" known={{ agents: [] } as never} keys={[]} capacity={{ host: { cpus: 8, memoryMiB: 16384 } } as never} refresh={async () => {}} notify={() => {}} />);
  expect(page(on)).toContain("Who can open the links");
  const off = page({ ...on, features: { scouts: false, preview: false, sideworkers: true } });
  expect(off).toContain("Pets cannot show you web apps");
  expect(off).not.toContain("Who can open the links");
  expect(routeOf("/houses/work/previews")).toEqual({ page: "house", name: "work", tab: "previews" });
});

test("the sidebar leaves out a feature the house has off; its address still works", () => {
  const shell = (features: HouseView["features"]) => renderToStaticMarkup(
    <Shell me={{} as never} houses={[{ ...house, features }]} house="work" path="/houses/work" theme="dark" onToggleTheme={() => {}} onSignOut={() => {}} onNewHouse={() => {}}>{null}</Shell>,
  );
  const on = shell({ scouts: false, preview: true, sideworkers: true });
  expect(on).toContain('href="/houses/work/sideworkers"');
  expect(on).toContain('href="/houses/work/previews"');
  const off = shell({ scouts: false, preview: false, sideworkers: false });
  expect(off).not.toContain('href="/houses/work/sideworkers"');
  expect(off).not.toContain('href="/houses/work/previews"');
});
