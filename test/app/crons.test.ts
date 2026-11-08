import { expect, test } from "bun:test";
import { join } from "node:path";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { Crons } from "../../src/app/crons";
import { cronTools } from "../../src/app/cron-tools";
import { mcpHandler } from "../../src/infra/mcp-server";
import { tempDir, fakeClock } from "../helpers";

import { householdTimezone } from "../../src/core/timezone";

test("Household defaults to UTC and honors an explicit time zone", () => {
  expect(householdTimezone()).toBe("UTC");
  expect(householdTimezone("Europe/Madrid")).toBe("Europe/Madrid");
});

const start = Date.parse("2026-11-05T12:00:00Z");
const once = {
  name: "Check build",
  body: "Inspect yesterday's build. Keep it internal.",
  at: "2026-11-05T12:01:00",
};
const repeating = {
  name: "Morning",
  body: "Review the queue.",
  cron: "0 9 * * 1-5",
};

test("persistent atomic dispatch, no duplicate after reopen, delivery lifecycle retained", () => {
  const file = join(tempDir(), "state.db");
  let db = new SqliteStore(file);
  const job = db.crons.create("work", "a", once, start);
  expect(db.crons.due(start)).toHaveLength(0);
  const message = db.crons.fire(job, start + 60_000)!;
  expect(db.unfinished("work", "a")).toEqual([message]);
  expect(message.text).toContain(once.body);
  expect(message.origin).toBe("cron");
  expect(db.crons.fire(job, start + 60_000)).toBeUndefined();
  db.close();
  db = new SqliteStore(file);
  expect(db.crons.due(start + 120_000)).toHaveLength(0);
  expect(db.crons.view("work", "a").runs).toHaveLength(1);
  db.setStatus(message.id, "delivered");
  db.setStatus(message.id, "answered");
  const view = db.crons.view("work", "a");
  expect(view.runs[0]!.status).toBe("answered");
  expect(view.runs[0]!.delivered).not.toBeNull();
  expect(view.runs[0]!.finished).not.toBeNull();
  expect(view.events.map((e) => e.kind)).toEqual([
    "answered",
    "delivered",
    "queued",
    "created",
  ]);
  db.close();
});

test("ownership, validation, revision conflicts and soft deletion", () => {
  const db = new SqliteStore(":memory:");
  const s = db.crons;
  const job = s.create("work", "a", once, start);
  expect(s.view("work", "b").jobs).toHaveLength(0);
  expect(() => s.get("work", "b", job.id)).toThrow("not found");
  expect(() => s.get("other", "a", job.id)).toThrow("not found");
  expect(() =>
    s.update(
      "work",
      "a",
      job.id,
      1,
      { ...once, at: "2026-11-05T11:00:00" },
      start,
    ),
  ).toThrow("future");
  expect(() =>
    s.create("work", "a", { ...once, at: "2026-11-06T09:00:00+01:00" }, start),
  ).toThrow();
  expect(() =>
    s.create("work", "a", { ...repeating, at: once.at }, start),
  ).toThrow();
  expect(() =>
    s.create("work", "a", { ...repeating, timezone: "Nowhere/No" }, start),
  ).toThrow();
  expect(() =>
    s.create("work", "a", { ...repeating, cron: "* * * * * *" }, start),
  ).toThrow();
  expect(() =>
    s.create("work", "a", { ...repeating, cron: "garbage" }, start),
  ).toThrow();
  const edited = s.update(
    "work",
    "a",
    job.id,
    1,
    { ...once, name: "Updated" },
    start,
  );
  expect(() => s.delete("work", "a", job.id, 1, start)).toThrow("changed");
  s.delete("work", "a", job.id, edited.revision, start);
  expect(s.due(start + 100_000)).toHaveLength(0);
  expect(s.view("work", "a").events.map((e) => e.kind)).toEqual([
    "deleted",
    "updated",
    "created",
  ]);
  db.close();
});

test("recurrence uses timezone, coalesces missed runs and skips overlapping occurrences", () => {
  const db = new SqliteStore(":memory:");
  const s = db.crons;
  s.setTimezone("Europe/Madrid", start);
  const j = s.create("h", "p", repeating, start);
  expect(j.at).toBe("2026-11-06T08:00:00.000Z");
  const late = Date.parse("2026-11-10T15:00:00Z");
  const m = s.fire(j, late)!;
  expect(s.get("h", "p", j.id).at).toBe("2026-11-11T08:00:00.000Z");
  expect(s.view("h", "p").runs).toHaveLength(1);
  s.fire(s.get("h", "p", j.id), Date.parse("2026-11-11T09:00:00Z"));
  expect(s.view("h", "p").runs).toHaveLength(1);
  expect(s.view("h", "p").events[0]!.kind).toBe("skipped");
  db.setStatus(m.id, "answered");
  expect(
    s.fire(s.get("h", "p", j.id), Date.parse("2026-11-12T09:00:00Z")),
  ).toBeDefined();
  expect(s.view("h", "p").runs).toHaveLength(2);
  db.close();
});

test("DST follows wall-clock time in the selected zone", () => {
  const db = new SqliteStore(":memory:");
  const s = db.crons;
  const now = Date.parse("2026-10-24T06:00:00Z");
  s.setTimezone("Europe/Madrid", now);
  const j = s.create("h", "p", { ...repeating, cron: "0 9 * * *" }, now);
  expect(j.at).toBe("2026-10-24T07:00:00.000Z");
  s.fire(j, Date.parse(j.at));
  expect(s.get("h", "p", j.id).at).toBe("2026-10-25T08:00:00.000Z");
  db.close();
});

test("host timer stops, ignores absent pets and catches up once on return", () => {
  const db = new SqliteStore(":memory:");
  const clock = fakeClock();
  clock.tick(start);
  let active = false;
  const accepted: number[] = [];
  const service = new Crons(
    db.crons,
    {
      acceptScheduled: (_h, _p, m) => {
        accepted.push(m.id);
      },
    },
    () => active,
    () => {},
    clock,
  );
  expect(() => service.create("h", "p", once)).toThrow("configured");
  active = true;
  service.create("h", "p", once);
  active = false;
  service.start();
  clock.tick(120_000);
  expect(accepted).toHaveLength(0);
  active = true;
  clock.tick(1000);
  expect(accepted).toHaveLength(1);
  clock.tick(1000);
  expect(accepted).toHaveLength(1);
  service.stop();
  db.close();
});

test("MCP CRUD only uses authenticated pet identity", async () => {
  const db = new SqliteStore(":memory:");
  const clock = fakeClock();
  clock.tick(start);
  const crons = new Crons(
    db.crons,
    { acceptScheduled: () => {} },
    () => true,
    () => {},
    clock,
  );
  const handler = mcpHandler(
    { name: "household", version: "1" },
    cronTools(crons),
  );
  const call = async (pet: string, name: string, args: object = {}) =>
    (
      await handler(
        { house: "work", pet },
        new Request("http://test/mcp", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      )
    ).json();
  const created = await call("a", "cron_create", once);
  const job = JSON.parse(created.result.content[0].text);
  expect((await call("b", "cron_get", { id: job.id })).result.isError).toBe(
    true,
  );
  expect(
    (await call("b", "cron_delete", { id: job.id, revision: 1 })).result
      .isError,
  ).toBe(true);
  expect(
    (await call("a", "cron_create", { ...once, pet: "b" })).result.isError,
  ).toBe(true);
  expect(
    JSON.parse((await call("a", "cron_list")).result.content[0].text).jobs,
  ).toHaveLength(1);
  expect(
    (await call("a", "cron_update", { id: job.id, revision: 1, ...repeating }))
      .result.isError,
  ).toBeUndefined();
  expect(
    (await call("a", "cron_delete", { id: job.id, revision: 2 })).result
      .isError,
  ).toBeUndefined();
  db.close();
});

test("one Household timezone controls every task; per-task timezone is rejected", () => {
  const db = new SqliteStore(":memory:");
  const s = db.crons;
  s.setTimezone("Europe/Madrid", start);
  const a = s.create(
    "h",
    "a",
    { name: "Once", body: "check", at: "2026-11-06T09:00" },
    start,
  );
  const b = s.create("h", "b", repeating, start);
  expect(a.at).toBe("2026-11-06T08:00:00.000Z");
  expect(b.at).toBe(a.at);
  expect(() =>
    s.create("h", "a", { ...repeating, timezone: "UTC" }, start),
  ).toThrow();
  s.setTimezone("UTC", start);
  expect(s.get("h", "a", a.id).at).toBe("2026-11-06T09:00:00.000Z");
  expect(s.get("h", "b", b.id).at).toBe("2026-11-06T09:00:00.000Z");
  expect(s.view("h", "a").timezone).toBe("UTC");
  expect(s.view("h", "a").events[0]!.kind).toBe("timezone");
  db.close();
});

test("disabled pets retain due tasks without dispatch; enabling catches up once", () => {
  const db = new SqliteStore(":memory:");
  let enabled = false;
  const delivered: number[] = [];
  const clock = { now: () => start + 120_000, after: () => () => {} };
  const crons = new Crons(db.crons, { acceptScheduled: (_h, _p, message) => { delivered.push(message.id); } }, () => true, () => {}, clock, () => enabled);
  db.crons.create("work", "a", once, start);
  crons.tick();
  crons.tick();
  expect(crons.list("work", "a").runs).toHaveLength(0);
  expect(crons.list("work", "a").jobs).toHaveLength(1);
  enabled = true;
  crons.tick();
  crons.tick();
  expect(delivered).toHaveLength(1);
  db.close();
});
