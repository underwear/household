import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schemaVersion, snapshotDatabase } from "../../src/infra/db-snapshot";
import { tempDir } from "../helpers";

// Not readonly: SQLite does not open a WAL-mode file (the plain copy) so without its -shm.
const count = (path: string) => {
  const db = new Database(path, { readwrite: true });
  try {
    return db.query<{ n: number }, []>("SELECT count(*) AS n FROM t").get()!.n;
  } finally {
    db.close();
  }
};

test("the snapshot has what is only in the WAL yet, which a copy of the file misses; its schema version comes along", () => {
  const dir = tempDir();
  const source = join(dir, "household.db");
  const writer = new Database(source, { create: true });
  writer.run("PRAGMA journal_mode = WAL");
  writer.run("PRAGMA wal_autocheckpoint = 0"); // as a busy daemon's: the newest pages are in the -wal file
  writer.run("CREATE TABLE t (x)");
  writer.run("PRAGMA user_version = 11");
  writer.run("PRAGMA wal_checkpoint(TRUNCATE)");
  for (let i = 0; i < 50; i++) writer.run("INSERT INTO t VALUES (?)", [i]);
  expect(statSync(`${source}-wal`).size).toBeGreaterThan(0);

  copyFileSync(source, join(dir, "copy.db"));
  expect(count(join(dir, "copy.db"))).toBe(0); // the trap: a plain copy loses the 50 rows

  expect(snapshotDatabase(source, join(dir, "snap.db"))).toBe(11);
  expect(count(join(dir, "snap.db"))).toBe(50);
  writer.close();
});

test("snapshots taken while another process writes are each consistent: every transaction whole or absent", async () => {
  const dir = tempDir();
  const source = join(dir, "household.db");
  const setup = new Database(source, { create: true });
  setup.run("PRAGMA journal_mode = WAL");
  setup.run("CREATE TABLE t (x)");
  setup.close();
  // Each transaction adds two rows: a snapshot with an odd count would have caught one half done.
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(source)});
    db.run("PRAGMA busy_timeout = 5000");
    const pair = db.transaction((i) => { db.run("INSERT INTO t VALUES (?)", [i]); db.run("INSERT INTO t VALUES (?)", [i]); });
    console.log("ready");
    for (let i = 0; i < 1e9; i++) pair(i);`;
  const writer = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit" });
  const reader = writer.stdout.getReader();
  await reader.read(); // "ready"
  try {
    const counts: number[] = [];
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(30);
      const snap = join(dir, `snap-${i}.db`);
      snapshotDatabase(source, snap);
      counts.push(count(snap));
    }
    expect(counts.every((n) => n % 2 === 0)).toBe(true);
    expect(counts.at(-1)!).toBeGreaterThan(counts[0]!); // the writer did write meanwhile
  } finally {
    writer.kill();
    await writer.exited;
  }
});

test("a file that is not SQLite has no schema version", () => {
  const path = join(tempDir(), "junk.db");
  writeFileSync(path, "x".repeat(4096));
  expect(() => schemaVersion(path)).toThrow();
});
