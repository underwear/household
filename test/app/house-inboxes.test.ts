import { expect, test } from "bun:test";
import { HouseInboxes } from "../../src/app/house-inboxes";
import { houseInboxSchema, type InboxItem } from "../../src/core/house-inboxes";
import type { House } from "../../src/core/household";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { Poller } from "../../src/infra/inbox-pollers";

const inbox = () => houseInboxSchema.parse({ name: "mail", title: "Mail", source: { kind: "http", url: "https://example.com/feed" }, channel: "one", pets: ["alice", "bob"], intervalSeconds: 60 });
const event = (id: string): InboxItem => ({ id, title: "New " + id, text: "External content" });
function setup(poll: Poller, initial: "new" | "latest" = "new", store = new SqliteStore(":memory:")) {
  let now = 1000000;
  const posted: InboxItem[] = [], delivered: string[] = [];
  let fail: string | undefined;
  const source = { ...inbox(), initial };
  const house: House = { name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ name: "alice" }, { name: "bob" }], channels: [], people: { owners: [] }, inboxes: [source] };
  const service = new HouseInboxes(store, {
    post: async (_h, _i, e) => { if (fail === "post") throw Error("private token"); posted.push(e); },
    pet: (_h, _i, p) => { if (fail === p) throw Error("private token"); delivered.push(p); },
  }, poll, () => now);
  service.setHouses([house]);
  return { service, store, posted, delivered, house, source, fail: (value?: string) => { fail = value; }, advance: () => { now += 60000; } };
}
test("baseline, durable cursor and IDs skip old items across restart", async () => {
  let items = [event("old")];
  const cursors: (string | undefined)[] = [];
  const poll: Poller = async (_s, cursor) => { cursors.push(cursor); return { items, cursor: "next" }; };
  const s = setup(poll);
  await s.service.run("work", "mail");
  expect(s.posted).toHaveLength(0);
  items = [event("old"), event("new")];
  await s.service.run("work", "mail");
  expect(s.posted).toHaveLength(1);
  expect(s.delivered).toEqual(["alice", "bob"]);
  const restarted = setup(poll, "new", s.store);
  await restarted.service.run("work", "mail");
  expect(restarted.posted).toHaveLength(0);
  expect(cursors).toEqual([undefined, "next", "next"]);
});
test("partial fanout retries only the unfinished recipient, without reposting", async () => {
  const s = setup(async () => ({ items: [event("one")], cursor: "1" }), "latest");
  s.fail("bob");
  const failed = await s.service.run("work", "mail");
  expect(s.posted).toHaveLength(1);
  expect(s.delivered).toEqual(["alice"]);
  expect(failed.status.pendingCount).toBe(1);
  expect(failed.status.error).not.toContain("private token");
  s.fail();
  await s.service.run("work", "mail");
  expect(s.posted).toHaveLength(1);
  expect(s.delivered).toEqual(["alice", "bob"]);
  expect(s.service.list("work")[0]!.status.pendingCount).toBe(0);
});
test("channel failure retains events and cursor; credentials echoed by the source are redacted", async () => {
  const s = setup(async () => ({ items: [{ ...event("one"), text: "Bearer super-secret and super-secret" }], cursor: "1" }), "latest");
  s.source.source = { kind: "http", url: "https://example.com/feed", headers: { Authorization: "Bearer super-secret" } };
  s.fail("post");
  await s.service.run("work", "mail");
  expect(s.service.list("work")[0]!.status.pendingCount).toBe(1);
  s.fail();
  await s.service.run("work", "mail");
  expect(JSON.stringify(s.posted)).not.toContain("super-secret");
  expect(s.posted[0]!.text).toContain("[redacted credential]");
});
test("failed first poll does not advance baseline; paused sources cannot run", async () => {
  let broken = true;
  const s = setup(async () => { if (broken) throw Error("server echoed password"); return { items: [event("old")] }; });
  const result = await s.service.run("work", "mail");
  expect(result.status.initialized).toBe(false);
  expect(result.status.error).not.toContain("password");
  broken = false;
  await s.service.run("work", "mail");
  expect(s.posted).toHaveLength(0);
  s.source.enabled = false;
  await expect(s.service.run("work", "mail")).rejects.toThrow("Resume");
});
test("source changes baseline again and connection test never changes durable state", async () => {
  const s = setup(async () => ({ items: [event("one")], cursor: "head" }));
  await s.service.test(s.source);
  expect(s.service.list("work")[0]!.status.initialized).toBe(false);
  await s.service.run("work", "mail");
  s.source.source = { kind: "http", url: "https://other.example/feed", headers: {} };
  expect(s.service.list("work")[0]!.status.initialized).toBe(false);
  await s.service.run("work", "mail");
  expect(s.posted).toHaveLength(0);
});
test("overlap is refused and edits wait for cancellation before deleting state", async () => {
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const s = setup(async (_s, _c, _i, signal) => {
    started();
    await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancel")), { once: true }));
    return { items: [] };
  });
  const run = s.service.run("work", "mail"); await ready;
  await expect(s.service.run("work", "mail")).rejects.toThrow("already");
  await s.service.edit("work", "mail", async () => { s.service.setHouses([]); }, true);
  await run;
  expect(s.store.get("house.inboxes.v1.work/mail")).toBeUndefined();
});
test("pending events cannot silently move to a different channel", async () => {
  const s = setup(async () => ({ items: [event("one")] }), "latest");
  s.fail("post"); await s.service.run("work", "mail");
  expect(() => s.service.assertChange("work", { ...s.source, channel: "other" })).toThrow("pending");
});
test("paused pets still get a durable queue entry; Delivery owns when their VM may run", async () => {
  const s = setup(async () => ({ items: [event("one")] }), "latest");
  s.house.pets[1]!.enabled = false;
  await s.service.run("work", "mail");
  expect(s.delivered).toEqual(["alice", "bob"]);
  s.source.pets = ["alice"];
  await s.service.run("work", "mail");
  expect(s.delivered).toEqual(["alice", "bob"]);
  expect(s.service.list("work")[0]!.status.pendingCount).toBe(0);
});

test("rotating credentials preserves the cursor and pending delivery", async () => {
  const cursors: (string | undefined)[] = [];
  const s = setup(async (_source, cursor) => { cursors.push(cursor); return { items: [event("one")], cursor: "head" }; });
  await s.service.run("work", "mail");
  s.source.source = { kind: "http", url: "https://example.com/feed", headers: { Authorization: "Bearer rotated" } };
  expect(s.service.list("work")[0]!.status.initialized).toBe(true);
  await s.service.run("work", "mail");
  expect(cursors).toEqual([undefined, "head"]);
});

test("failure backoff never polls more often than a long custom interval", async () => {
  const s = setup(async () => { throw Error("unavailable"); });
  s.source.intervalSeconds = 86400;
  const result = await s.service.run("work", "mail");
  expect(result.status.nextCheck - Date.parse(result.status.lastCheck!)).toBe(86400000);
});
