import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyDialog } from "./components/keys";
import { SecretDialog, SecretsPage, blockedHosts } from "./components/secrets";

const github = { name: "github", value: "ghp_secret-value", hosts: ["github.com", "api.github.com"], header: "authorization", env: "GITHUB_TOKEN", placeholder: "household-secret-github", houses: ["work"], note: "mine" };

const heroku = { name: "heroku", value: "hrku-x", hosts: ["api.heroku.com"], header: "authorization", env: "HEROKU_API_KEY", placeholder: "household-secret-heroku", note: null, onlyForCapabilities: ["heroku-prod"] };
const allow = [{ host: "github.com", byAgent: false }, { host: "*.github.com", byAgent: false }];

test("Workspace · Secrets: one page heading, the add button beside it, the list loading under the explanation", () => {
  const html = renderToStaticMarkup(<SecretsPage house="work" allow={allow} refresh={async () => {}} notify={() => {}} />);
  expect(html.match(/>Secrets</g)).toHaveLength(1); // the page's title, not a section's again
  expect(html).toContain('class="btn primary"');
  expect(html).toContain("+ Add secret");
  expect(html).toContain("the token never enters a VM");
  expect(html).toContain("Loading…");
});

test("a secret's hosts bots cannot reach: not covered by the workspace's allowlist (wildcards cover subdomains only)", () => {
  expect(blockedHosts(["github.com", "api.github.com", "raw.githubusercontent.com"], allow)).toEqual(["raw.githubusercontent.com"]);
  expect(blockedHosts(["github.com:8443"], allow)).toEqual(["github.com:8443"]); // another port, another entry
  expect(blockedHosts(["example.com"], [{ host: "*", byAgent: false }])).toEqual([]);
  expect(blockedHosts(["not a host"], [])).toEqual([]); // the form's own check says what is wrong with it
});

test("a new secret starts from a preset; the summary says what bots get and that a new variable waits for the next VM", () => {
  const fresh = renderToStaticMarkup(<SecretDialog house="work" onClose={() => {}} save={async () => {}} />);
  expect(fresh).toContain("Start from");
  expect(fresh).toContain('aria-pressed="true">Custom<');
  expect(fresh).toContain(">GitHub<");
  expect(fresh).toContain("Exact hosts, comma-separated.");
  expect(fresh).toContain("a placeholder in its variable");
  expect(fresh).toContain("at their next VM start.");
  const npm = renderToStaticMarkup(<SecretDialog house="work" preset="npm" allow={allow} onClose={() => {}} save={async () => {}} />);
  expect(npm).toContain('aria-pressed="true">npm<');
  expect(npm).toContain('value="registry.npmjs.org"');
  expect(npm).toContain("<code>NPM_TOKEN=household-secret-npm</code>");
  expect(npm).toContain("Not allowed in Network: registry.npmjs.org.");
  expect(npm).toContain('placeholder="npm_…"');
});

test("editing: name and preset are set once; nothing that needs a new VM changed yet; the header waits under Advanced", () => {
  const edit = renderToStaticMarkup(<SecretDialog house="work" secret={github} allow={allow} onClose={() => {}} save={async () => {}} />);
  expect(edit).not.toContain("Start from");
  expect(edit).not.toContain(">Name<");
  expect(edit).toContain('value="github.com, api.github.com"');
  expect(edit).toContain("<code>GITHUB_TOKEN=household-secret-github</code>");
  expect(edit).not.toContain("at their next VM start.");
  expect(edit).not.toContain("Not allowed in Network");
  expect(edit).toMatch(/<details class="field-help disclosure">.*Advanced.*>Header</s);
  expect(edit).not.toContain(">Workspaces<"); // a secret belongs to its workspace
});

test("a name already used in the workspace is refused before saving", () => {
  const html = renderToStaticMarkup(<SecretDialog house="work" preset="github" taken={["github"]} onClose={() => {}} save={async () => {}} />);
  expect(html).toContain("github already exists in work.");
});

test("a capability-only secret: who gets it is chosen, its capabilities ticked, and bots are told they never get it", () => {
  const html = renderToStaticMarkup(<SecretDialog house="work" secret={heroku} allow={[]} onClose={() => {}} save={async () => {}} />);
  expect(html).toContain("Who gets it");
  expect(html).toContain("Only scouts with heroku-prod get it.");
  expect(html).not.toContain("Not allowed in Network"); // scouts reach hosts through their capability, not this network
});

test("provider keys can be restricted to the only existing workspace, excluding future workspaces", () => {
  const key = { name: "claude", provider: "anthropic" as const, kind: "subscription", value: "sk-ant-oat01-x", note: null, pets: [], houses: ["work"], allowOverage: false, allowance: null };
  expect(renderToStaticMarkup(<KeyDialog houses={["work", "home"]} providers={["anthropic"]} keyView={key} onClose={() => {}} save={async () => {}} />)).toContain("Only bots in work.");
  expect(renderToStaticMarkup(<KeyDialog houses={["work"]} providers={["anthropic"]} onClose={() => {}} save={async () => {}} />)).toContain(">Workspaces<");
});
