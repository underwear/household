import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ScoutAccess, ScoutCard, ScoutDetailPage, ScoutDialog, ScoutRuns, ScoutsPage } from "./components/scouts";
import { CapabilitiesPage, CapabilityPage, ScoutsTabs } from "./components/capabilities";
import { SecretDialog } from "./components/secrets";
import { Shell } from "./components/shell";
import { WorkspaceFeatureSettings } from "./components/workspace-features";
import { SkillsPage } from "./components/skills";
import { capabilityPath, routeOf, scoutPath } from "./router";
import type { WorkspaceView, SecretView } from "./api";
import type { CapabilityView, ScoutDetailView, ScoutListView, ScoutRunView, ScoutView } from "./scout-api";

const heroku: CapabilityView = {
  name: "heroku-prod", description: "Heroku CLI for prod", install: "curl … | sh", network: { any: false, allow: ["api.heroku.com"] },
  keys: [{ secret: "heroku-prod", via: "vm", env: "HEROKU_API_KEY" }], kind: "access", usedBy: ["prod-ops"],
  keyVariables: [{ secret: "heroku-prod", via: "vm", env: "HEROKU_API_KEY" }], lastTest: null, testing: false, revisions: 2,
};
const browser: CapabilityView = { ...heroku, name: "browser", description: "Playwright", network: { any: true, allow: [] }, keys: [], kind: "tool", usedBy: [], keyVariables: [] };
const own: CapabilityView = { ...heroku, name: "prod-ops", description: "Prod Ops's own", owner: "prod-ops" };
const scout: ScoutView = {
  name: "prod-ops", title: "Prod Ops", emoji: "🛠️", description: "Production incidents", instructions: "Read first.", capabilities: ["browser"], own,
  network: { open: false, allow: ["api.heroku.com"], limitedBy: ["prod-ops"] }, keysInVm: [{ capability: "prod-ops", env: "HEROKU_API_KEY" }], problems: [],
};
const house: WorkspaceView = { name: "work", owners: [], pets: [{ name: "sibling", title: "Sibling", emoji: "🤖" } as WorkspaceView["pets"][number]], channels: [], allow: [], features: { scouts: true, preview: false, sideworkers: true } };
const limits = { maxScouts: 2, cpus: 2, memoryMiB: 2048 };
const initial: ScoutDetailView = { scout, capabilities: [heroku, browser], runs: [], defaults: { agent: null, limits } };
const list = (extra: Partial<ScoutListView> = {}): ScoutListView => ({ scouts: [scout], capabilities: [heroku, browser], runs: [], limits, agent: null, ...extra });
const noop = async () => {};
const props = { house, agents: [], keys: [], refresh: noop, notify: () => {} };
const run = (extra: Partial<ScoutRunView> = {}): ScoutRunView => ({ id: "run-1", scout: "scout", capabilities: ["browser", "media"], parent: "sibling", task: "Read <script>bad</script>", status: "done", startedAt: "2026-11-07T12:00:00Z", endedAt: "2026-11-07T12:01:00Z", outcome: "success", threadUrl: "https://t.me/example/12", report: "Done", ...extra });

test("routes: Scouts and Capabilities tabs, a scout's pages and a capability have stable paths; old ones redirect", () => {
  for (const tab of ["scouts", "capabilities"] as const) expect(routeOf(`/workspaces/work/${tab}`)).toEqual({ page: "workspace", name: "work", tab });
  expect(routeOf(scoutPath("work", "prod-ops"))).toEqual({ page: "scout", workspace: "work", scout: "prod-ops", tab: "overview" });
  for (const tab of ["instructions", "access", "runs"] as const) expect(routeOf(scoutPath("work", "prod-ops", tab))).toEqual({ page: "scout", workspace: "work", scout: "prod-ops", tab });
  expect(scoutPath("work", "prod-ops")).toBe("/workspaces/work/scouts/prod-ops");
  expect(routeOf(capabilityPath("work", "heroku-prod"))).toEqual({ page: "capability", workspace: "work", capability: "heroku-prod" });
  expect(routeOf("/workspaces/work/special-scouts/prod-ops")).toEqual({ page: "redirect", to: "/workspaces/work/scouts/prod-ops" });
  for (const old of ["special-scouts", "scout-default", "scout-resources"]) expect(routeOf(`/workspaces/work/${old}`)).toEqual({ page: "redirect", to: "/workspaces/work/scouts" });
});

test("scouts off: no nav entry; pages say so; the feature switch links to its settings only when on", () => {
  const off = { ...house, features: { ...house.features!, scouts: false } };
  const shell = (h: WorkspaceView, path = "/workspaces/work") => renderToStaticMarkup(<Shell me={{} as never} houses={[h]} house="work" path={path} theme="dark" onToggleTheme={() => {}} onSignOut={() => {}} onNewWorkspace={() => {}}>{null}</Shell>);
  expect(shell(house)).toContain('href="/workspaces/work/secrets"');
  expect(shell(house, "/workspaces/work/secrets")).toContain(">Secrets<");
  const active = /href="\/workspaces\/work\/scouts"[^>]*class="nav-item active"|class="nav-item active"[^>]*href="\/workspaces\/work\/scouts"/;
  expect(shell(off)).not.toContain('href="/workspaces/work/scouts"');
  expect(shell(house)).toContain('href="/workspaces/work/scouts"');
  for (const path of ["/workspaces/work/capabilities", "/workspaces/work/capabilities/heroku-prod", "/workspaces/work/scouts/prod-ops/access"]) expect(shell(house, path)).toMatch(active);
  expect(renderToStaticMarkup(<ScoutsPage {...props} house={off} />)).toContain("Turn on in Settings");
  expect(renderToStaticMarkup(<ScoutDetailPage {...props} house={off} name={scout.name} initial={initial} />)).not.toContain("Edit scout");
  expect(renderToStaticMarkup(<WorkspaceFeatureSettings house={house} refresh={noop} notify={() => {}} />)).toContain("Scout settings");
  expect(renderToStaticMarkup(<WorkspaceFeatureSettings house={off} refresh={noop} notify={() => {}} />)).not.toContain("Scout settings");
});

test("Scouts: two tabs, scout cards, a quiet line when none runs, recent runs; scouts without a harness are called out", () => {
  const view = list({ runs: [run()] });
  const html = renderToStaticMarkup(<ScoutsPage {...props} initial={view} />);
  for (const label of ["Scouts", "Capabilities"]) expect(html).toContain(`>${label}<`);
  for (const gone of ["Default scout", "Special scouts", "Resources", "assemble"]) expect(html).not.toContain(gone);
  expect(html).toContain(">Settings<");
  expect(html).toContain("+ New scout");
  expect(html).toContain("None running · up to 2 at once");
  expect(html).toContain("Prod Ops has no harness");
  expect(html).toContain('href="/workspaces/work/scouts/prod-ops"');
  expect(html).toContain(">Recent runs<");
  expect(html).toContain("browser, media"); // an earlier assembled run shows what it was made of
  const busy = renderToStaticMarkup(<ScoutsPage {...props} initial={list({ runs: [run({ id: "run-2", status: "running", blueprint: "prod-ops", outcome: undefined })] })} />);
  expect(busy).toContain(">Running<");
  expect(busy).toContain("Stop…");
  const withHarness = renderToStaticMarkup(<ScoutsPage {...props} initial={{ ...view, agent: { agent: "claude-code-tmux", key: "claude", model: "opus" } }} />);
  expect(withHarness).not.toContain("has no harness");
  expect(renderToStaticMarkup(<ScoutsTabs house="work" current="capabilities" count={3} />)).toContain('class="tab current"');
  expect(renderToStaticMarkup(<ScoutsPage {...props} initial={list({ scouts: [], capabilities: [] })} />)).toContain("No scouts");
});

test("a scout's card: its own setup first, then capabilities; network, keys in its VM, runs", () => {
  const card = renderToStaticMarkup(<ScoutCard house="work" scout={scout} runs={[run({ blueprint: "prod-ops" })]} />);
  expect(card.indexOf("own setup")).toBeLessThan(card.indexOf(">browser<"));
  expect(card).toContain("Only 1 host");
  expect(card).toContain("1 key in its VM");
  expect(card).toContain("1 run");
});

test("a scout's page: four tabs; Overview sums it up and says what it runs on", () => {
  const html = renderToStaticMarkup(<ScoutDetailPage {...props} name={scout.name} initial={initial} />);
  for (const label of ["Overview", "Instructions", "Access", "Runs"]) expect(html).toContain(`>${label}<`);
  expect(html).toContain('href="/workspaces/work/scouts" class="page-back">← Scouts</a>');
  expect(html).toContain("no harness · 2 vCPU · 2 GiB");
  expect(html).toContain("the workspace&#x27;s");
  expect(html).toContain("Change…");
  expect(html).toContain("$HEROKU_API_KEY");
  expect(html).toContain("Delete scout");
  const custom = renderToStaticMarkup(<ScoutDetailPage {...props} name={scout.name} initial={{ ...initial, scout: { ...scout, resources: { cpus: 4 } } }} />);
  expect(custom).toContain("4 vCPU");
  expect(custom).toContain("its own");
});

test("a scout's access: shared ticks, its own setup in rows, workspace, and what they make beside one Save", () => {
  const html = renderToStaticMarkup(<ScoutAccess house="work" scout={scout} capabilities={[heroku, browser]} save={noop} />);
  for (const title of ["Shared capabilities", "Its own setup", "Workspace"]) expect(html).toContain(`>${title}<`);
  expect(html).toContain('href="/workspaces/work/capabilities/prod-ops"');
  expect(html).toContain("Only api.heroku.com");
  expect(html).toContain("$HEROKU_API_KEY inside its VM");
  expect(html.match(/>Save</g)).toHaveLength(1);
  const bare = renderToStaticMarkup(<ScoutAccess house="work" scout={{ ...scout, own: null }} capabilities={[heroku, browser]} save={noop} />);
  expect(bare).toContain("+ Add own setup");
  expect(bare).toContain("Open internet");
  const repo = renderToStaticMarkup(<ScoutAccess house="work" scout={{ ...scout, workspace: { repo: "https://github.com/acme/ops.git", branch: "main" } }} capabilities={[heroku, browser]} save={noop} />);
  expect(repo).toContain('value="https://github.com/acme/ops.git"');
  expect(repo).toContain("api.heroku.com, github.com");
});

test("new scout: shared ones to tick, an own setup to opt into; harness and resources come later", () => {
  const html = renderToStaticMarkup(<ScoutDialog capabilities={[heroku, browser]} taken={[]} onClose={() => {}} save={noop} />);
  expect(html).toContain("A setup of its own");
  expect(html).toContain("heroku-prod");
  for (const gone of ["vCPU", "Model", "special"]) expect(html).not.toContain(gone);
});

test("run history: escaped tasks, outcomes in words, the calling bot by title", () => {
  const html = renderToStaticMarkup(<ScoutRuns house="work" pets={house.pets} scouts={[scout]} runs={[run()]} showScout refresh={noop} />);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Succeeded");
  expect(html).toContain("took 1 min");
  expect(html).toContain(">Sibling</a>");
  expect(html).toContain(">Scout<");
});

test("capabilities: the list (drafts from bots on top) and a capability's page", () => {
  const list = renderToStaticMarkup(<CapabilitiesPage house={house} refresh={noop} notify={() => {}} />);
  expect(list).toContain("+ New capability");
  const page = renderToStaticMarkup(<CapabilityPage house={house} name="heroku-prod" refresh={noop} notify={() => {}} />);
  expect(page).toContain("Loading…"); // the page loads its detail; its parts are rendered in the browser
});

test("secrets: kept for capabilities, never the bots'; a capability's skills are labelled as its", () => {
  const secret = { name: "heroku", value: "fake", hosts: ["api.heroku.com"], header: "Authorization", env: "HEROKU_API_KEY", houses: ["work"], onlyForCapabilities: ["heroku-prod"] } as unknown as SecretView;
  const html = renderToStaticMarkup(<SecretDialog house="work" secret={secret} onClose={() => {}} save={noop} />);
  expect(html).toContain("Only scouts with a capability");
  expect(html).toContain("Bots and sideworkers never get it");
  const skills = renderToStaticMarkup(<SkillsPage house="work" capability="heroku-prod" notify={() => {}} />);
  expect(skills).toContain("Loading skills…");
});
