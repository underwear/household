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

test("alert cursor retains only identity, state and title, not repeated message bodies", () => {
  const result = transitions({ cpu: { state: "active", title: "CPU", text: "large body".repeat(1000) } });
  expect(result.cursor!.length).toBeLessThan(200);
  expect(result.cursor).not.toContain("large body");
  expect(transitions({ cpu: { state: "active", title: "CPU", text: "changed annotation" } }, result.cursor).items).toHaveLength(0);
});

test("JSON watcher compares canonical fields, missing vs null, recurrence and persisted hashes", async () => {
  let body: unknown = { price: 5, status: "open", noise: 1, "a/b": { "~": null } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body) });
  const source = { kind: "json-watch" as const, url: `http://127.0.0.1:${server.port}`, headers: {}, pointers: ["/price", "/a~1b/~0"] };
  const poll = (cursor?: string, initial: "new" | "latest" = "new") => pollInbox(source, cursor, initial, new AbortController().signal);
  try {
    const baseline = await poll(); expect(baseline.items).toHaveLength(0);
    expect(baseline.cursor).not.toContain("price");
    body = { noise: 2, "a/b": { "~": null }, status: "closed", price: 5 };
    expect((await poll(baseline.cursor)).items).toHaveLength(0);
    body = { price: 6 };
    const changed = await poll(baseline.cursor);
    expect(changed.items[0]!.text).toContain('/price: 6');
    expect(changed.items[0]!.text).toContain('[missing]');
    const imported = await poll(undefined, "latest");
    expect(imported.items).toHaveLength(1);
    body = { price: 5, "a/b": { "~": null } };
    const again = await poll(changed.cursor);
    expect(again.items).toHaveLength(1);
    expect(again.items[0]!.id).not.toBe(changed.items[0]!.id);
    source.pointers = [];
    const whole = await poll();
    body = { "a/b": { "~": null }, price: 5 };
    expect((await poll(whole.cursor)).items).toHaveLength(0);
    body = { price: [1, 2] };
    const array = await poll(whole.cursor);
    body = { price: [2, 1] };
    expect((await poll(array.cursor)).items).toHaveLength(1);
  } finally { server.stop(true); }
});

test("health checks debounce failure, emit recovery once, and distinguish parent cancellation", async () => {
  let status = 200;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ignored", {status}) });
  const source = {kind: "health" as const, url: `http://127.0.0.1:${server.port}`, headers: {}, failures: 2, timeoutMs: 1000, expectedStatus: 200};
  const poll = (cursor?: string) => pollInbox(source, cursor, "new", new AbortController().signal);
  try {
    let result = await poll(); expect(result.items).toHaveLength(0);
    status = 503;
    result = await poll(result.cursor); expect(result.items).toHaveLength(0);
    result = await poll(result.cursor); expect(result.items[0]!.title).toBe("Endpoint is down");
    result = await poll(result.cursor); expect(result.items).toHaveLength(0);
    status = 200;
    result = await poll(result.cursor); expect(result.items[0]!.title).toBe("Endpoint recovered");
    result = await poll(result.cursor); expect(result.items).toHaveLength(0);
    status = 503; source.failures = 1;
    result = await poll(); expect(result.items[0]!.title).toBe("Endpoint is down"); expect(result.baselineHandled).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(pollInbox(source, result.cursor, "new", controller.signal)).rejects.toThrow("cancelled");
  } finally { server.stop(true); }
});

test("RSS/Atom baseline consumes the whole feed; imports drain batches; namespaces, CDATA and links work", async () => {
  let xml = '<rss version="2.0"><channel><title>Feed</title>' + Array.from({length: 120}, (_,i) => `<item><guid>${i}</guid><title>Entry ${i}</title><description><![CDATA[<b>Hello</b> world]]></description><link>/item/${i}</link></item>`).join("") + '</channel></rss>';
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(xml) });
  const source = { kind: "rss" as const, url: `http://127.0.0.1:${server.port}/feed`, headers: {} };
  const poll = (cursor?: string, initial: "new" | "latest" = "new") => pollInbox(source, cursor, initial, new AbortController().signal);
  try {
    const baseline = await poll(); expect(baseline.items).toHaveLength(0);
    expect((await poll(baseline.cursor)).items).toHaveLength(0);
    const a = await poll(undefined, "latest"), b = await poll(a.cursor), c = await poll(b.cursor);
    expect([a.items.length, b.items.length, c.items.length]).toEqual([50,50,20]);
    expect(a.items[0]!.text).toBe("Hello world");
    expect(a.items[0]!.url).toBe(`http://127.0.0.1:${server.port}/item/0`);
    xml = '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Atom</atom:title><atom:entry><atom:id>new</atom:id><atom:title>A &amp; B</atom:title><atom:summary>Summary</atom:summary><atom:link rel="self" href="/api"/><atom:link rel="alternate" href="/article"/><atom:updated>2026-11-09T12:00:00Z</atom:updated></atom:entry></atom:feed>';
    const atom = await poll(c.cursor);
    expect(atom.items[0]!.title).toBe("A & B"); expect(atom.items[0]!.url).toEndWith("/article");
    expect(atom.items[0]!.occurredAt).toBe("2026-11-09T12:00:00.000Z");
    expect((await poll(atom.cursor)).items).toHaveLength(0);
    for (xml of ['<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss/>', '<rss><channel>', '<html/>']) await expect(poll()).rejects.toThrow();
  } finally { server.stop(true); }
});

test("silent mode requires subscribers and watch configuration is bounded", () => {
  const base = { name: "test", title: "Test", channel: "one", pets: [], source: {kind: "json-watch", url: "https://example.com"} };
  expect(houseInboxSchema.parse(base).delivery).toBe("announce");
  expect(houseInboxSchema.safeParse({...base, delivery: "silent"}).success).toBe(false);
  expect(houseInboxSchema.safeParse({...base, delivery: "silent", pets: ["alice"]}).success).toBe(true);
  for (const pointers of [["price"], ["/bad~2escape"], ["/x", "/x"]]) expect(houseInboxSchema.safeParse({...base, source: {...base.source, pointers}}).success).toBe(false);
});
