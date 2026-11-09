import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SideworkerProfiles, SideworkerProfileDialog } from "./components/sideworker-profiles";
import type { HarnessView, WorkspaceView, KeyView } from "./api";

const agents: HarnessView[] = [
  { name: "alpha", models: ["alpha-fast"], defaultModel: "alpha-fast", providers: ["anthropic"], modes: [{ id: "ask", label: "Ask first" }], defaultMode: "ask", settings: [], modelOptions: [{ id: "alpha-fast", label: "Fast", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }], defaultReasoningEffort: "low" }] },
  { name: "beta", models: ["beta-deep"], defaultModel: "beta-deep", providers: ["openai"], modes: [{ id: "auto", label: "Automatic" }], defaultMode: "auto", settings: [] },
];
const keys: KeyView[] = [
  { name: "alpha-key", provider: "anthropic", kind: "API key", value: "", note: null, pets: [], houses: null, allowOverage: false, allowance: null },
  { name: "beta-key", provider: "openai", kind: "subscription", value: "", note: null, pets: [], houses: ["work"], allowOverage: false, allowance: null },
];
const house: WorkspaceView = { name: "work", allow: [], owners: [], channels: [], pets: [], sideworkerProfiles: [] };

test("workspace profiles: the bot's own settings by default (said once), then owner-approved alternatives", () => {
  const empty = renderToStaticMarkup(<SideworkerProfiles house={house} agents={agents} keys={keys} refresh={async () => {}} notify={() => {}} />);
  expect(empty).toContain("runs on its bot&#x27;s own harness and model"); // the default, in the hint
  expect(empty).toContain("None yet: every sideworker runs on its bot&#x27;s settings.");
  expect(empty).toContain("+ Add profile");
  const configured = { ...house, sideworkerProfiles: [{ name: "review", agent: "beta", key: "beta-key", model: "beta-deep", mode: "auto" }] };
  const html = renderToStaticMarkup(<SideworkerProfiles house={configured} agents={agents} keys={keys} refresh={async () => {}} notify={() => {}} />);
  expect(html).toContain("review");
  expect(html).toContain("beta · beta-deep · key beta-key");
  expect(html).toContain("Default reasoning · Automatic");
  expect(html).toContain(">Edit</button>");
  expect(html).toContain(">Remove</button>");
});

test("profile editor reuses adapter controls with matching keys and native effort defaults", () => {
  const html = renderToStaticMarkup(<SideworkerProfileDialog agents={agents} keys={keys} taken={[]} profile={{ name: "quick", agent: "alpha", key: "alpha-key" }} onClose={() => {}} save={async () => {}} />);
  expect(html).toContain('value="alpha" selected=""');
  expect(html).toContain('<option value="beta">beta</option>');
  expect(html).toContain('value="alpha-key" selected=""');
  expect(html).not.toContain('value="beta-key"');
  expect(html).toContain('value="alpha-fast" selected=""');
  expect(html).toContain('value="ask" selected=""');
  expect(html).toContain("Default (native)");
  expect(html).toContain('<option value="low">low</option>');
});
