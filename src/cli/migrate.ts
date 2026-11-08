import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownAgents } from "../app/agents";
import { configCheck } from "../app/kinds";
import { backUpBeforeMigrating, inspectMigrations, listBackups, migrateHousehold, restoreBackup, type MigrationReport } from "../app/migrations";
import { HouseholdError } from "../core/errors";
import { ConfigStore } from "../infra/config-store";
import { callControl } from "../infra/control-socket";
import type { Paths } from "../infra/paths";
import { SqliteStore } from "../infra/sqlite-store";

export const MIGRATE_USAGE = `  house migrate                  where the config and the database stand against this Household, and what is to run
                                 (the daemon runs it when it starts, after copying both aside)
  house migrate apply            run it now (daemon stopped): the config and the database are copied aside first
  house migrate backups          the copies taken before migrating, newest first
  house migrate restore <backup> put one back (daemon stopped); the current config and database are moved aside`;

async function daemonRunning(paths: Paths): Promise<boolean> {
  return (await callControl(paths.socket, "/status")) !== undefined;
}

function show(report: MigrationReport, json: boolean | undefined): void {
  if (json) return console.log(JSON.stringify(report, null, 2));
  console.log(`config     ${report.config ? `version ${report.config.version} of ${report.config.latest}` : "none yet"}`);
  console.log(`database   ${report.database ? `schema ${report.database.schema} of ${report.database.latest}` : "none yet"}`);
  if (report.pending.length === 0) return console.log("nothing to migrate");
  console.log("to run:");
  for (const each of report.pending) console.log(`  ${each.store === "database" ? "" : `${each.id}. `}${each.name} (${each.store})`);
}

/** `house migrate …`; false when `command` is not migrate. */
export async function runMigrate(paths: Paths, command: string | undefined, args: string[], values: { json?: boolean }): Promise<boolean> {
  if (command !== "migrate") return false;
  const [verb, name, ...rest] = args;
  if (!verb) {
    const dir = mkdtempSync(join(tmpdir(), "household-migrate-"));
    try {
      show(inspectMigrations(paths, dir), values.json);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return true;
  }
  if (verb === "apply" && !name) {
    if (await daemonRunning(paths)) throw new HouseholdError("the daemon is running: it migrated when it started; to run new ones, restart it (or stop it, then house migrate apply)");
    const { dir, report } = backUpBeforeMigrating(paths);
    if (!dir) return (show(report, values.json), true);
    if (!values.json) console.log(`config and database copied to ${dir}`);
    const store = new SqliteStore(paths.database); // its schema migrates as it opens
    try {
      const ran = await migrateHousehold({ config: new ConfigStore(paths.configFile, configCheck(knownAgents())), records: store, log: values.json ? undefined : console.log });
      if (values.json) console.log(JSON.stringify({ backup: dir, ran: ran.map(({ id, name, store }) => ({ id, name, store })), database: report.database }, null, 2));
      else if (report.database && report.database.schema < report.database.latest) console.log(`database schema ${report.database.schema} → ${report.database.latest}`);
    } finally {
      store.close();
    }
    return true;
  }
  if (verb === "backups" && !name) {
    const backups = listBackups(paths);
    if (values.json) console.log(JSON.stringify(backups, null, 2));
    else if (backups.length === 0) console.log("no migration backups");
    else for (const backup of backups) console.log(`${backup.name}  ${backup.files.join(", ")}`);
    return true;
  }
  if (verb === "restore" && name && rest.length === 0) {
    if (await daemonRunning(paths)) throw new HouseholdError("the daemon is running: stop it first (Ctrl-C or SIGTERM), then restore");
    const aside = restoreBackup(paths, name);
    console.log(`restored ${name}; the config and database it replaced are in ${aside}`);
    console.log("a backup from before an update needs the Household it was taken with: check out that version before you start");
    return true;
  }
  throw new HouseholdError(`unknown command or missing arguments: house migrate ${args.join(" ")}\nusage:\n${MIGRATE_USAGE}`);
}
