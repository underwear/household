import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyDialog } from "./components/keys";
import { SecretDialog, SecretsSection } from "./components/secrets";

const github = { name: "github", value: "ghp_secret-value", hosts: ["github.com", "api.github.com"], header: "authorization", env: "GITHUB_TOKEN", placeholder: "household-secret-github", houses: ["work"], note: "mine" };

test("Workspace Secrets: a dedicated section for this house", () => {
  const html = renderToStaticMarkup(<SecretsSection house="work" notify={() => {}} />);
  expect(html).toContain(">Secrets<");
  expect(html).toContain("+ Add secret");
  expect(html).toContain("Loading…");
});

test("a new secret starts from a preset; its variable says what bots get; a change explains hot activation and deferred environment update", () => {
  const fresh = renderToStaticMarkup(<SecretDialog house="work" onClose={() => {}} save={async () => {}} />);
  expect(fresh).toContain('<option value="github">GitHub</option>');
  expect(fresh).toContain("Exact hosts, comma-separated.");
  expect(fresh).toContain("at their next VM start.");
  const edit = renderToStaticMarkup(<SecretDialog house="work" secret={github} onClose={() => {}} save={async () => {}} />);
  expect(edit).not.toContain(">Preset<"); // a secret's name and preset are set once
  expect(edit).toContain("Bots get household-secret-github here.");
  expect(edit).toContain('value="github.com, api.github.com"');
  expect(edit).not.toContain("at their next VM start."); // nothing that needs a new VM changed yet
  expect(edit).not.toContain(">Workspaces<");
});

test("provider keys can be restricted to the only existing workspace, excluding future workspaces", () => {
  const key = { name: "claude", provider: "anthropic" as const, kind: "subscription", value: "sk-ant-oat01-x", note: null, pets: [], houses: ["work"], allowOverage: false, allowance: null };
  expect(renderToStaticMarkup(<KeyDialog houses={["work", "home"]} providers={["anthropic"]} keyView={key} onClose={() => {}} save={async () => {}} />)).toContain("Only bots in work.");
  expect(renderToStaticMarkup(<KeyDialog houses={["work"]} providers={["anthropic"]} onClose={() => {}} save={async () => {}} />)).toContain(">Workspaces<");
});

test("a secret belongs to its workspace, without a global scope selector", () => {
  const html = renderToStaticMarkup(<SecretDialog house="work" onClose={() => {}} save={async () => {}} />);
  expect(html).not.toContain(">Workspaces<");
  expect(html).not.toContain("every workspace");
});
