import { expect, test } from "bun:test";
import { join } from "node:path";
import { HistoryRunner } from "../../src/infra/history-runner";
import type { HistoryFilter } from "../../src/infra/history-store";
import { SqliteStore } from "../../src/infra/sqlite-store";
import { ref } from "../app/fake-channel";
import { tempDir } from "../helpers";

const SLOW = [process.execPath, join(import.meta.dir, "slow-history-process.ts")];
const filter = (house: string): HistoryFilter => ({ house, pet: "sibling", channel: "c1", limit: 20 });

test("a search runs in the history process on the database: the daemon's records are found, in order", async () => {
  const path = join(tempDir(), "household.db");
  const store = new SqliteStore(path);
  for (const text of ["buy an elephant", "buying it already"]) {
    store.remember("work", { refs: [ref(text)], place: "pet:sibling@telegram-private:1", pet: "sibling", journals: ["sibling"], sender: { kind: "pet", name: "sibling" }, text, excerpt: text });
  }
  const runner = new HistoryRunner(path, 5_000);
  try {
    const page = await runner.search({ ...filter("work"), words: ["buy"] });
    expect(page.records.map(({ id, text }) => [id, text])).toEqual([["m2", "buying it already"], ["m1", "buy an elephant"]]);
    store.remember("work", { refs: [ref("later")], place: "pet:sibling@telegram-private:1", pet: "sibling", journals: ["sibling"], sender: { kind: "pet", name: "sibling" }, text: "buying another", excerpt: "x" });
    expect((await runner.search({ ...filter("work"), words: ["buying"] })).records.map(({ id }) => id)).toEqual(["m3", "m2"]); // the daemon's writes are seen
  } finally {
    runner.stop();
    store.close();
  }
});

const EMPTY = { records: [], more: false };
const TOO_LONG = "history search took longer than 0.3 s: narrow it (fewer words, a person, a date range)";

test("a search over the cap is killed with its process and the pet is told to narrow it; the daemon goes on meanwhile; the next search works", async () => {
  const runner = new HistoryRunner(join(tempDir(), "unused.db"), 300, SLOW);
  try {
    expect(await runner.search(filter("fast"))).toEqual(EMPTY);
    let ticks = 0;
    const ticking = setInterval(() => ticks++, 20);
    const started = Date.now();
    await expect(runner.search(filter("slow"))).rejects.toThrow(TOO_LONG);
    const took = Date.now() - started;
    clearInterval(ticking);
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1_500);
    expect(ticks).toBeGreaterThan(5); // the daemon's event loop kept running
    expect(await runner.search(filter("fast"))).toEqual(EMPTY); // a fresh process
  } finally {
    runner.stop();
  }
});

test("the cap counts from when a search is asked: one still waiting behind a slow one fails at its deadline, one asked later still runs", async () => {
  const runner = new HistoryRunner(join(tempDir(), "unused.db"), 300, SLOW);
  try {
    const started = Date.now();
    const slow = runner.search(filter("slow"));
    const waiting = runner.search(filter("fast")).catch((error: Error) => [error.message, Date.now() - started]);
    await Bun.sleep(150);
    const later = runner.search(filter("other")); // its 300 ms end after the slow one is killed
    await expect(slow).rejects.toThrow(TOO_LONG);
    const [message, after] = (await waiting) as [string, number];
    expect(message).toBe(TOO_LONG);
    expect(after).toBeLessThan(500); // not 300 waiting + 300 of its own
    expect(await later).toEqual(EMPTY);
  } finally {
    runner.stop();
  }
});

test("a pet has one search at a time, and all pets a few", async () => {
  const runner = new HistoryRunner(join(tempDir(), "unused.db"), 300, SLOW);
  try {
    const slow = runner.search(filter("slow"));
    await expect(runner.search(filter("slow"))).rejects.toThrow("a history search is already running");
    const others = ["a", "b", "c"].map((house) => runner.search(filter(house)).catch(() => "expired"));
    await expect(runner.search(filter("d"))).rejects.toThrow("history search is busy: try again in a moment");
    await expect(slow).rejects.toThrow(TOO_LONG);
    expect(await Promise.all(others)).toEqual(["expired", "expired", "expired"]); // asked together with the slow one
    await expect(runner.search(filter("slow"))).rejects.toThrow(TOO_LONG); // its search over, the pet may search again
  } finally {
    runner.stop();
  }
});

test("a process that dies fails its search; one that died between searches is not reused", async () => {
  const runner = new HistoryRunner(join(tempDir(), "unused.db"), 5_000, SLOW);
  try {
    await expect(runner.search(filter("crash"))).rejects.toThrow("history search failed: its process exited");
    expect(await runner.search(filter("fast"))).toEqual(EMPTY);
    // Its process exits right after answering: the next search, sent at once or later, gets a fresh one.
    for (const wait of [0, 0, 5, 20, 100]) {
      expect(await runner.search(filter("exit"))).toEqual(EMPTY);
      await Bun.sleep(wait);
      expect(await runner.search(filter("fast"))).toEqual(EMPTY);
    }
  } finally {
    runner.stop();
  }
});
