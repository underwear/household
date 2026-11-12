import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MicrosoftSetup, microsoftAccessWords } from "./components/microsoft-connectors";
import { CONNECTOR_TYPES } from "./components/workspace-connectors";

test("Microsoft is available in Add connector and defaults to read-only private enrollment", () => {
  expect(CONNECTOR_TYPES.find(t => t.id === "microsoft")?.label).toBe("Microsoft To Do");
  const html = renderToStaticMarkup(<MicrosoftSetup house="home" ready options={[{ value: "alice", label: "Alice" }]} onClose={() => {}} saved={async () => {}} />);
  expect(html).toContain("Connect Microsoft To Do");
  expect(html).toContain("Prepare Microsoft sign-in");
  expect(html).toMatch(/checked=""[^>]*value="read"|value="read"[^>]*checked=""/);
  expect(html).not.toMatch(/role="switch"[^>]*checked=""/);
  expect(html).toContain("Tokens stay on this host");
  expect(html).toContain("delete lists and tasks");
});

test("Microsoft reconnection preserves selected access and bots, unavailable hosts explain setup", () => {
  const html = renderToStaticMarkup(<MicrosoftSetup house="home" ready={false} options={[{ value: "alice", label: "Alice" }]}
    existing={{ id: "a", account: "me@example.com", displayName: "Me", writable: true, pets: ["alice"], connectedAt: "", needsReconnect: true }}
    onClose={() => {}} saved={async () => {}} />);
  expect(html).toContain("Reconnect me@example.com");
  expect(html).toMatch(/checked=""[^>]*value="write"|value="write"[^>]*checked=""/);
  expect(html).toMatch(/role="switch"[^>]*checked=""/);
  expect(html).toContain("Microsoft isn&#x27;t set up on this host.");
  expect(microsoftAccessWords({ writable: true })).toBe("read and write");
  expect(microsoftAccessWords({ writable: false })).toBe("read only");
});
