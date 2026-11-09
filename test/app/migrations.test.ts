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

test("migration 3: browser and dev capabilities left as their templates made them get Node.js 22; edited ones stay", async () => {
  const { CAPABILITY_TEMPLATES, LEGACY_NODE_INSTALLS } = await import("../../src/builtin-capabilities");
  const { parseDocument } = await import("yaml");
  const migration = CONFIG_MIGRATIONS.find((each) => each.id === 3)!;
  const doc = parseDocument("houses:\n  work:\n    capabilities: []\n");
  const capabilities = doc.getIn(["houses", "work", "capabilities"]) as import("yaml").YAMLSeq;
  for (const [name, install] of Object.entries(LEGACY_NODE_INSTALLS)) capabilities.items.push(doc.createNode({ name, install }));
  capabilities.items.push(doc.createNode({ name: "browser", install: "my own script\n" }));
  migration.change(doc);
  const installs = (doc.toJS() as { houses: { work: { capabilities: { name: string; install: string }[] } } }).houses.work.capabilities;
  const template = (name: string) => CAPABILITY_TEMPLATES.find((each) => each.name === name)!.install;
  expect(installs.map((each) => each.install)).toEqual([template("browser"), template("dev"), "my own script\n"]);
  expect(template("browser")).toContain("setup_22.x");
  expect(template("dev")).not.toContain(" npm");
  migration.change(parseDocument("houses:\n  work:\n    network: { allow: [] }\n")); // nothing to rewrite: harmless
});

test("migration 4 copies shared secrets only to existing recipients, preserving capability restrictions and independent ownership", async () => {
  const paths = household();
  const old = `# Owner configuration
version: 3
secrets:
  shared: # shared token
    value: synthetic-shared
    hosts: [api.example.com]
    env: SHARED_TOKEN
    note: keep this note
  private:
    value: synthetic-private
    hosts: [api.example.com:8443]
    env: PRIVATE_TOKEN
    houses: [work]
    header: x-api-key
  scout:
    value: synthetic-scout
    hosts: [api.example.com]
    env: SCOUT_TOKEN
    houses: [work]
    onlyForCapabilities: [deploy]
houses:
  work:
    network: {allow: []}
    capabilities:
      - name: deploy
        keys: [{secret: scout, via: gateway}]
  home:
    network: {allow: []}
`;
  writeFileSync(paths.configFile, old);
  const config = new ConfigStore(paths.configFile);
  // Read-only inspection can project legacy config, but ordinary edits cannot silently migrate without backup.
  expect((await config.load()).houses[1]!.secrets!.map(secret => secret.name)).toEqual(["shared"]);
  await expect(config.updateSecret("work", "private", { value: "changed" })).rejects.toThrow("migration");
  expect(readFileSync(paths.configFile, "utf8")).toBe(old);
  const backup = backUpBeforeMigrating(paths);
  expect(backup.dir).toBeDefined();
  expect(readFileSync(join(backup.dir!, "household.yaml"), "utf8")).toBe(old);
  const records = new SqliteStore(paths.database);
  try {
    expect((await migrateHousehold({ config, records })).map(step => step.id)).toEqual([4]);
    const saved = readFileSync(paths.configFile, "utf8");
    expect(saved).not.toMatch(/^secrets:/m);
    expect(saved).toContain("# Owner configuration");
    expect(saved).toContain("shared token");
    const migrated = await config.load();
    expect(migrated.houses[0]!.secrets!.find(secret => secret.name === "private")).toMatchObject({ header: "x-api-key", hosts: [{ host: "api.example.com", port: 8443 }] });
    expect(migrated.houses[0]!.secrets!.find(secret => secret.name === "scout")!.onlyForCapabilities).toEqual(["deploy"]);
    await config.updateSecret("work", "shared", { value: "changed" });
    expect((await config.load()).houses[1]!.secrets![0]!.value).toBe("synthetic-shared");
    await config.createHouse("future");
    expect((await config.load()).houses.find(house => house.name === "future")!.secrets ?? []).toEqual([]);
    expect(await migrateHousehold({ config, records })).toEqual([]);
  } finally { records.close(); }
});

test("migration 4 refuses orphaned and colliding secrets without writing or exposing values", async () => {
  const legacy = { value: "DO_NOT_PRINT_THIS", hosts: ["api.example.com"], env: "TOKEN" };
  const cases = [
    { version: 3, secrets: { token: legacy }, houses: {} },
    { version: 3, secrets: { token: { ...legacy, houses: ["missing"] } }, houses: { work: { network: { allow: [] } } } },
    { version: 3, secrets: { token: legacy }, houses: { work: { network: { allow: [] }, secrets: { token: legacy } } } },
  ];
  for (const raw of cases) {
    const paths = household(), original = JSON.stringify(raw);
    writeFileSync(paths.configFile, original);
    const config = new ConfigStore(paths.configFile);
    let message = "";
    try { await config.migrate(); } catch (error) { message = String(error); }
    expect(message).not.toBe("");
    expect(message).not.toContain(legacy.value);
    expect(readFileSync(paths.configFile, "utf8")).toBe(original);
  }
});

test("latest config rejects global secrets and cross-house selectors", async () => {
  const paths = household();
  const secret = { value: "synthetic", hosts: ["api.example.com"], env: "TOKEN" };
  for (const raw of [
    { version: CONFIG_VERSION, secrets: { token: secret }, houses: {} },
    { version: CONFIG_VERSION, houses: { work: { network: { allow: [] }, secrets: { token: { ...secret, houses: ["home"] } } } } },
  ]) {
    writeFileSync(paths.configFile, JSON.stringify(raw));
    await expect(new ConfigStore(paths.configFile).load()).rejects.toThrow("invalid config");
  }
});


test("migration 4 materializes YAML aliases so independent secrets survive removing the global catalog", async () => {
  const paths = household();
  writeFileSync(paths.configFile, `version: 3
secrets:
  first:
    value: &token synthetic-aliased
    hosts: &hosts [api.example.com]
    env: FIRST_TOKEN
  second:
    value: *token
    hosts: *hosts
    env: SECOND_TOKEN
houses:
  work: {network: {allow: []}}
  home: {network: {allow: []}}
`);
  const config = new ConfigStore(paths.configFile);
  await config.migrate();
  await config.updateSecret("work", "first", { value: "changed" });
  const result = await config.load();
  expect(result.houses[0]!.secrets![1]!.value).toBe("synthetic-aliased");
  expect(result.houses[1]!.secrets!.map(secret => secret.value)).toEqual(["synthetic-aliased", "synthetic-aliased"]);
});
