import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { CONFIG_MIGRATIONS, CONFIG_VERSION, type ConfigMigration } from "../infra/config-migrations";
import type { ConfigStore } from "../infra/config-store";
import { snapshotDatabase } from "../infra/db-snapshot";
import type { Paths } from "../infra/paths";
import type { KeyValueStore } from "../infra/sqlite-store";
import { SCHEMA_VERSION } from "../infra/sqlite-store";
import { configVersionOf } from "../infra/yaml-doc";
import { VERSION } from "./version";

/*
 * How Household's data follows Household when it is updated. Three stores, each with its own version:
 *
 * - the database's tables: `PRAGMA user_version`, its schema migrations (infra/sqlite-schema.ts), run when it opens;
 * - household.yaml: its `version`, the last config migration it has had (infra/config-migrations.ts);
 * - what Household keeps in the database's records (scout runs, sideworkers, capability revisions, …): the state
 *   migrations below, each recorded once it ran.
 *
 * Config and state migrations are one sequence: ids ascending, append only, never renumbered, run in order. A
 * newer store than this Household knows is refused (update Household, or restore the backup). Before anything is
 * migrated the daemon copies the config and the database aside (`backUpBeforeMigrating`): a migration is never
 * undone, a backup is restored.
 */

export interface StateContext {
  records: KeyValueStore;
}

/**
 * A change to what Household keeps in the database's records. It must be harmless on a database that has nothing
 * of what it rewrites (a new one: it runs there too).
 */
export interface StateMigration {
  id: number;
  name: string;
  store: "state";
  run(context: StateContext): void | Promise<void>;
}

export type Migration = ConfigMigration | StateMigration;

/** Append here (an id after every config migration's and state migration's). */
export const STATE_MIGRATIONS: readonly StateMigration[] = [];

export const MIGRATIONS: readonly Migration[] = [...CONFIG_MIGRATIONS, ...STATE_MIGRATIONS].sort((a, b) => a.id - b.id);

const APPLIED_KEY = "household.migrations.v1";

/** A state migration that ran: when, and by which Household. */
export interface AppliedMigration { id: number; name: string; at: string; by: string }

export function appliedMigrations(records: Pick<KeyValueStore, "get">): AppliedMigration[] {
  const raw = records.get(APPLIED_KEY);
  return raw ? (JSON.parse(raw) as AppliedMigration[]) : [];
}

/** What is still to run, in order: config migrations past the config's version, state ones not recorded. */
export function pendingOf(migrations: readonly Migration[], configVersion: number, applied: readonly AppliedMigration[]): Migration[] {
  const done = new Set(applied.map((each) => each.id));
  return migrations.filter((migration) => (migration.store === "config" ? migration.id > configVersion : !done.has(migration.id)));
}

/**
 * Runs what is pending, in order, each recorded as it completes (a failed one stops the rest: the next start tries
 * it again). The database's schema has been migrated already: that happens when it opens.
 */
export async function migrateHousehold({ config, records, migrations = MIGRATIONS, log = () => {} }: {
  config: Pick<ConfigStore, "version" | "applyMigration">;
  records: KeyValueStore;
  migrations?: readonly Migration[];
  log?: (text: string) => void;
}): Promise<Migration[]> {
  const pending = pendingOf(migrations, await config.version(), appliedMigrations(records));
  const ran: Migration[] = [];
  for (const migration of pending) {
    if (migration.store === "config") {
      if (!(await config.applyMigration(migration))) continue;
    } else {
      await migration.run({ records });
      records.set(APPLIED_KEY, JSON.stringify([...appliedMigrations(records), { id: migration.id, name: migration.name, at: new Date().toISOString(), by: VERSION }]));
    }
    log(`migration ${migration.id} (${migration.store}): ${migration.name}`);
    ran.push(migration);
  }
  return ran;
}

/** Where each store stands against this Household, and what is still to run. */
export interface MigrationReport {
  config: { version: number; latest: number } | null;
  database: { schema: number; latest: number } | null;
  pending: { id: number; store: "config" | "state" | "database"; name: string }[];
}

/**
 * Looks at the config and a snapshot of the database (written into `dir`, consistent while a daemon writes it)
 * without changing either. A store newer than this Household throws.
 */
export function inspectMigrations(paths: Pick<Paths, "configFile" | "database">, dir: string, migrations: readonly Migration[] = MIGRATIONS): MigrationReport {
  let config: MigrationReport["config"] = null, database: MigrationReport["database"] = null, applied: AppliedMigration[] = [];
  if (existsSync(paths.configFile)) {
    const version = configVersionOf(parseDocument(readFileSync(paths.configFile, "utf8")));
    if (version > CONFIG_VERSION) throw new Error(`${paths.configFile} is from a newer Household (config version ${version}, this one knows up to ${CONFIG_VERSION})`);
    config = { version, latest: CONFIG_VERSION };
  }
  if (existsSync(paths.database)) {
    const target = join(dir, "household.db");
    const schema = snapshotDatabase(paths.database, target);
    if (schema > SCHEMA_VERSION) throw new Error(`${paths.database} has schema ${schema}, newer than this Household knows (${SCHEMA_VERSION})`);
    database = { schema, latest: SCHEMA_VERSION };
    const db = new Database(target, { readonly: true });
    try {
      applied = appliedMigrations({ get: (key) => db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value });
    } catch { /* a database from before its records table: none ran */ } finally {
      db.close();
    }
  }
  const pending: MigrationReport["pending"] = [];
  if (database && database.schema < database.latest) pending.push({ id: database.latest, store: "database", name: `database schema ${database.schema} → ${database.latest}` });
  // No config, no database: nothing to migrate (a new Household writes both at the latest).
  if (config || database) {
    for (const migration of pendingOf(migrations, config?.version ?? CONFIG_VERSION, applied)) {
      if (migration.store === "state" && !database) continue; // no records yet
      pending.push({ id: migration.id, store: migration.store, name: migration.name });
    }
  }
  return { config, database, pending };
}

export const backupsDir = (paths: Pick<Paths, "stateDir">) => join(paths.stateDir, "backups");
const BACKUP_PREFIX = "pre-migrate-";
/** How many migration backups are kept: the oldest go. */
const KEEP_BACKUPS = 5;

/**
 * Copies the config and the database aside when something is to be migrated (`backups/pre-migrate-<time>`, mode
 * 700): a migration is never undone, this is restored (`house migrate restore`). Nothing is kept when nothing is
 * pending. Resolves to the backup's directory, if one was kept, and what is pending.
 */
export function backUpBeforeMigrating(paths: Pick<Paths, "configFile" | "database" | "stateDir">, { migrations = MIGRATIONS, now = new Date() }: { migrations?: readonly Migration[]; now?: Date } = {}): { dir?: string; report: MigrationReport } {
  const root = backupsDir(paths);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dir = join(root, `${BACKUP_PREFIX}${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`);
  mkdirSync(dir, { mode: 0o700 });
  try {
    const report = inspectMigrations(paths, dir, migrations);
    if (report.pending.length === 0) {
      rmSync(dir, { recursive: true, force: true });
      return { report };
    }
    if (existsSync(paths.configFile)) {
      copyFileSync(paths.configFile, join(dir, "household.yaml"));
      chmodSync(join(dir, "household.yaml"), 0o600);
    }
    for (const old of listBackups(paths).slice(KEEP_BACKUPS)) rmSync(join(root, old.name), { recursive: true, force: true });
    return { dir, report };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Migration backups, newest first. */
export function listBackups(paths: Pick<Paths, "stateDir">): { name: string; at: Date; files: string[] }[] {
  const root = backupsDir(paths);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && statSync(join(root, name)).isDirectory())
    .map((name) => ({ name, at: statSync(join(root, name)).mtime, files: readdirSync(join(root, name)).sort() }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Puts a migration backup back (the daemon stopped): its config and database replace the current ones, which are
 * moved aside first (`backups/replaced-<time>`), so a restore is undone the same way.
 */
export function restoreBackup(paths: Pick<Paths, "configFile" | "database" | "stateDir">, name: string, now = new Date()): string {
  const source = join(backupsDir(paths), name);
  if (!name.startsWith(BACKUP_PREFIX) || name.includes("/") || !existsSync(source)) throw new Error(`no migration backup '${name}' (house migrate backups lists them)`);
  const aside = join(backupsDir(paths), `replaced-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`);
  mkdirSync(aside, { mode: 0o700 });
  const files: [string, string][] = [["household.yaml", paths.configFile], ["household.db", paths.database]];
  for (const [file, current] of files) {
    if (!existsSync(join(source, file))) continue;
    if (existsSync(current)) renameSync(current, join(aside, file));
    // A database's write-ahead log belongs to the database it replaces.
    if (file === "household.db") for (const suffix of ["-wal", "-shm"]) if (existsSync(current + suffix)) renameSync(current + suffix, join(aside, file + suffix));
    copyFileSync(join(source, file), current);
    chmodSync(current, 0o600);
  }
  return aside;
}
