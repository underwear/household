import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SlackSetup, resultProblem, slackAccessWords } from "./components/slack-connectors";
import { WorkspaceConnectors } from "./components/workspace-connectors";
import type { WorkspaceView } from "./api";

const options = [{ value: "sibling", label: "👽 Пупс" }];
const house = { name: "work", pets: [{ name: "sibling", title: "Пупс" }], channels: [], owners: [] } as unknown as WorkspaceView;

test("Connectors: one list for Google and Slack under one Add connector", () => {
  const html = renderToStaticMarkup(<WorkspaceConnectors house={house} notify={() => {}} />);
  expect(html.match(/<h2/g) ?? []).toHaveLength(0); // no separate Slack section
  expect(html).toContain("+ Add connector");
  expect(html).toContain("Loading…");
});

test("a new Slack connection starts at access and bots, like Google's; a token import is one link away", () => {
  const html = renderToStaticMarkup(<SlackSetup house="work" options={options} back={() => {}} onClose={() => {}} saved={async () => {}} />);
  expect(html).toContain('aria-current="step">Access<');
  expect(html).toContain(">Read only<");
  expect(html).toContain(">Read and send<");
  expect(html).toContain("This is not a chat channel");
  expect(html).toContain("Use a user token instead");
  expect(html).toContain("Continue to Slack");
  expect(html).toContain(">Back<");
  const again = renderToStaticMarkup(<SlackSetup house="work" options={options} existing={{ id: "s1", teamId: "T", team: "Zendrop", userId: "U", user: "igor", scopes: [], pets: ["sibling"], allowWrite: true, connectedAt: "", needsReconnect: true }} onClose={() => {}} saved={async () => {}} />);
  expect(again).toContain("Reconnect Zendrop");
  expect(again).toMatch(/checked=""[^>]*value="send"|value="send"[^>]*checked=""/);
  expect(again).not.toContain(">Back<");
});

test("a pasted connection result must be the whole callback address with its code and state", () => {
  expect(resultProblem("")).toBeUndefined();
  expect(resultProblem("https://agents-household.dev/slack/callback/?code=abc&state=xyz")).toBeUndefined();
  for (const wrong of ["abc", "https://evil.test/slack/callback/?code=a&state=b", "https://agents-household.dev/slack/callback/?state=b"]) expect(resultProblem(wrong)).toContain("Paste the whole result");
  expect(slackAccessWords({ allowWrite: true })).toBe("read and send");
  expect(slackAccessWords({})).toBe("read only");
});
