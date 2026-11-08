import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backUpBeforeMigrating, inspectMigrations, listBackups, MIGRATIONS, migrateHousehold, restoreBackup, appliedMigrations, type Migration } from "../../src/app/migrations";
import { CONFIG_MIGRATIONS, CONFIG_VERSION } from "../../src/infra/config-migrations";
import { ConfigStore } from "../../src/infra/config-store";
import { SCHEMA_VERSION, SqliteStore } from "../../src/infra/sqlite-store";
import { tempDir } from "../helpers";

function household() {
  const dir = tempDir();
  return { configFile: join(dir, "household.yaml"), database: join(dir, "household.db"), stateDir: dir, dir };
}
const OLD = "houses:\n  work:\n    network: { allow: [] }\n    scoutLimits: { maxScouts: 3, timeoutMinutes: 60 }\n    defaultScout: { capabilities: [] }\n";

test("ids are one sequence: unique, ascending, the config's version is its last migration's", () => {
  const ids = MIGRATIONS.map((each) => each.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(ids[0]).toBe(1);
  expect(CONFIG_VERSION).toBe(Math.max(...CONFIG_MIGRATIONS.map((each) => each.id)));
});

test("a config from before versions runs every config migration once, then says so in its version", async () => {
  const paths = household();
  writeFileSync(paths.configFile, OLD);
  const config = new ConfigStore(paths.configFile);
  expect(await config.version()).toBe(0);
  const store = new SqliteStore(paths.database);
  const logged: string[] = [];
  const ran = await migrateHousehold({ config, records: store, log: (text) => logged.push(text) });
  expect(ran.map((each) => each.id)).toEqual(CONFIG_MIGRATIONS.map((each) => each.id));
  const text = readFileSync(paths.configFile, "utf8");
  expect(text).toStartWith(`version: ${CONFIG_VERSION}\n`);
  expect(text).not.toContain("defaultScout");
  expect(text).not.toContain("timeoutMinutes");
  expect(logged[0]).toBe("migration 1 (config): a house's default scout becomes the General scout");
  expect(await migrateHousehold({ config, records: store })).toEqual([]); // once only
  store.close();
});

test("state migrations run in the sequence with the config's, each recorded; a failed one stops the rest and runs again", async () => {
  const paths = household();
  const store = new SqliteStore(paths.database);
  // The config's side as ConfigStore does it, past the real migrations' versions.
  let version = 0;
  const config = { version: async () => version, applyMigration: async (each: { id: number; change: (doc: never) => void }) => { if (version >= each.id) return false; each.change(undefined as never); version = each.id; return true; } };
  const order: string[] = [];
  let fail = true;
  const migrations: Migration[] = [
    { id: 1, store: "config", name: "c1", change: () => void order.push("c1") },
    { id: 2, store: "state", name: "s2", run: ({ records }) => { order.push("s2"); records.set("x", "1"); } },
    { id: 3, store: "state", name: "s3", run: () => { order.push("s3"); if (fail) throw new Error("boom"); } },
    { id: 4, store: "config", name: "c4", change: () => void order.push("c4") },
  ];
  await expect(migrateHousehold({ config, records: store, migrations })).rejects.toThrow("boom");
  expect(order).toEqual(["c1", "s2", "s3"]);
  expect(appliedMigrations(store).map((each) => each.id)).toEqual([2]);
  fail = false;
  expect((await migrateHousehold({ config, records: store, migrations })).map((each) => each.id)).toEqual([3, 4]);
  expect(order).toEqual(["c1", "s2", "s3", "s3", "c4"]);
  expect(version).toBe(4);
  store.close();
});

test("a new config is written at the latest version: nothing to migrate", async () => {
  const paths = household();
  const config = new ConfigStore(paths.configFile);
  await config.createHouse("work");
  expect(readFileSync(paths.configFile, "utf8")).toStartWith(`version: ${CONFIG_VERSION}\n`);
  expect(await config.version()).toBe(CONFIG_VERSION);
  expect((await config.load()).houses[0]!.name).toBe("work");
});

test("a config from a newer Household is not read, nor migrated", async () => {
  const paths = household();
  writeFileSync(paths.configFile, `version: ${CONFIG_VERSION + 1}\nhouses: {}\n`);
  await expect(new ConfigStore(paths.configFile).load()).rejects.toThrow("is from a newer Household");
  expect(() => inspectMigrations(paths, paths.dir)).toThrow("is from a newer Household");
});

test("before migrating, the config and the database are copied aside; nothing is kept when nothing is pending; a backup is restored", async () => {
  const paths = household();
  writeFileSync(paths.configFile, OLD);
  new SqliteStore(paths.database).close();
  const { dir, report } = backUpBeforeMigrating(paths, { now: new Date("2026-11-08T10:00:00Z") });
  expect(report.config).toEqual({ version: 0, latest: CONFIG_VERSION });
  expect(report.database).toEqual({ schema: SCHEMA_VERSION, latest: SCHEMA_VERSION });
  expect(report.pending.map((each) => each.id)).toEqual(CONFIG_MIGRATIONS.map((each) => each.id));
  expect(dir).toEndWith("backups/pre-migrate-20261108T100000Z");
  expect(listBackups(paths)[0]!.files).toEqual(["household.db", "household.yaml"]);

  const store = new SqliteStore(paths.database);
  await migrateHousehold({ config: new ConfigStore(paths.configFile), records: store });
  store.set("after", "migrating");
  store.close();
  expect(backUpBeforeMigrating(paths, { now: new Date("2026-11-08T11:00:00Z") }).dir).toBeUndefined();
  expect(listBackups(paths)).toHaveLength(1);

  const aside = restoreBackup(paths, "pre-migrate-20261108T100000Z", new Date("2026-11-08T12:00:00Z"));
  expect(readFileSync(paths.configFile, "utf8")).toBe(OLD);
  const restored = new SqliteStore(paths.database);
  expect(restored.get("after")).toBeUndefined();
  restored.close();
  expect(existsSync(join(aside, "household.yaml"))).toBe(true); // what it replaced
  expect(() => restoreBackup(paths, "../etc")).toThrow("no migration backup");
});

test("only the newest five backups are kept", () => {
  const paths = household();
  for (let hour = 10; hour < 17; hour++) {
    writeFileSync(paths.configFile, OLD);
    backUpBeforeMigrating(paths, { now: new Date(`2026-11-08T${hour}:00:00Z`) });
  }
  expect(listBackups(paths).map((each) => each.name)).toEqual([16, 15, 14, 13, 12].map((hour) => `pre-migrate-20261108T${hour}0000Z`));
});
