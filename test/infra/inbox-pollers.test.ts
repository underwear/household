import { expect, test } from "bun:test";
import { pollInbox, transitions } from "../../src/infra/inbox-pollers";
import { houseInboxSchema } from "../../src/core/house-inboxes";

test("HTTP contract sends cursor, limit and authorization; rejects redirects and malformed responses", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  let mode = "valid";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    if (mode === "redirect") return Response.redirect("https://example.com/stolen");
    if (mode === "invalid") return Response.json({ version: 1, items: [{ id: "1", text: "missing title" }] });
    if (mode === "large") return new Response("x".repeat(2_000_001));
    if (mode === "error") return new Response("secret echoed", { status: 401 });
    return Response.json({ version: 1, items: [{ id: "1", title: "Test", text: "Body" }], nextCursor: "two" });
  } });
  const source = { kind: "http" as const, url: `http://127.0.0.1:${server.port}/events`, headers: { Authorization: "Bearer host-secret" } };
  try {
    const result = await pollInbox(source, "one + /", "latest", new AbortController().signal);
    expect(result.cursor).toBe("two");
    expect(new URL(requests[0]!.url).searchParams.get("cursor")).toBe("one + /");
    expect(new URL(requests[0]!.url).searchParams.get("limit")).toBe("50");
    expect(requests[0]!.authorization).toBe("Bearer host-secret");
    for (mode of ["redirect", "invalid", "large", "error"]) {
      await expect(pollInbox(source, undefined, "new", new AbortController().signal)).rejects.toThrow();
    }
  } finally { server.stop(true); }
});
test("monitor transitions are quiet when unchanged, include recovery, and drain batches over 50", () => {
  const a = { state: "active", title: "CPU", text: "busy" };
  const first = transitions({ cpu: a });
  expect(first.items).toHaveLength(1);
  expect(transitions({ cpu: a }, first.cursor).items).toHaveLength(0);
  const cleared = transitions({}, first.cursor);
  expect(cleared.items[0]!.title).toContain("No longer active");
  const reactivated = transitions({ cpu: a }, cleared.cursor);
  expect(reactivated.items[0]!.id).not.toBe(first.items[0]!.id);
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, n) => [String(n), a]));
  const one = transitions(many), two = transitions(many, one.cursor), three = transitions(many, two.cursor);
  expect([one.items.length, two.items.length, three.items.length]).toEqual([50, 50, 20]);
  expect(transitions(many, three.cursor).items).toHaveLength(0);
});
test("Grafana baseline and Datadog monitor state use documented API endpoints", async () => {
  let kind = "grafana", state = "Alert";
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return Response.json(kind === "grafana" ? [{ fingerprint: "one", startsAt: "2026-11-09T00:00:00Z", labels: { alertname: "CPU" }, annotations: { summary: "hot" }, status: { state: "active" } }] : { id: 123, name: "CPU", overall_state: state, message: "check CPU" });
  } });
  try {
    const url = `http://127.0.0.1:${server.port}`, signal = new AbortController().signal;
    const baseline = await pollInbox({ kind: "grafana", url, headers: {} }, undefined, "new", signal);
    expect(baseline.items).toHaveLength(0);
    expect((await pollInbox({ kind: "grafana", url, headers: {} }, baseline.cursor, "new", signal)).items).toHaveLength(0);
    kind = "datadog";
    const source = { kind: "datadog" as const, url, headers: {}, monitor: "123" };
    const previous = await pollInbox(source, undefined, "new", signal);
    state = "OK";
    expect((await pollInbox(source, previous.cursor, "new", signal)).items[0]!.title).toBe("OK: CPU");
    expect(paths).toContain("/api/alertmanager/grafana/api/v2/alerts");
    expect(paths).toContain("/api/v1/monitor/123");
  } finally { server.stop(true); }
});
test("config rejects transport header overrides, embedded URL credentials and unsafe intervals", () => {
  const base = { name: "test", title: "Test", channel: "one", pets: [], source: { kind: "http", url: "https://example.com" } };
  for (const bad of [
    { ...base, intervalSeconds: 1 },
    { ...base, source: { ...base.source, url: "https://user:password@example.com" } },
    { ...base, source: { ...base.source, headers: { Host: "other.example" } } },
    { ...base, source: { ...base.source, headers: { Authorization: "a\r\nb" } } },
  ]) expect(houseInboxSchema.safeParse(bad).success).toBe(false);
});
