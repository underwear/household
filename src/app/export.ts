import { HostHomeStorage } from "../infra/home-storage";
import { houseSkillsRoot } from "../infra/house-skills";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HouseholdError } from "../core/errors";
import { ConfigStore } from "../infra/config-store";
import { snapshotDatabase } from "../infra/db-snapshot";
import { packDir } from "../infra/tarball";
import { BACKUP, stamp, sideworkerBackupStamp, TLS_FILES, volumeEntry, type BackupDeps, type Manifest } from "./backup";
import { instanceId, ownerOf, petContainer, petVolume } from "./pet-plane";
import { householdVersion } from "./version";
import { CODEX_AUTH_BACKUP, copyDedicatedAuth, dedicatedAuthRoot, readDedicatedAuth, subscriptionAuthKeys } from "./codex-auth-backup";

/**
 * `house export`: the config (keys and bot tokens in it), a snapshot of the database, Household's CA and every pet's home, in one
 * archive (see `BACKUP`),
 * `household-<YYYYMMDD-HHMM>.tar.gz` in the current dir unless `file` is given. The daemon may be running: the
 * database snapshot is consistent anyway, and each running pet is paused while its home is read (a message to it
 * waits that moment). An existing file is never written over. Stops at the next step once `signal` aborts.
 * Resolves to the archive and its size.
 */
export async function exportHousehold(
  { paths, runtime, log, now = () => new Date() }: BackupDeps,
  file?: string,
  signal?: AbortSignal,
): Promise<{ file: string; bytes: number }> {
  const created = now();
  const target = resolve(file ?? `household-${stamp(created)}.tar.gz`);
  for (const [what, path] of [["config", paths.configFile], ["database", paths.database]] as const) {
    if (!existsSync(path)) throw new HouseholdError(`nothing to export: no ${what} at ${path}`);
  }
  const household = await new ConfigStore(paths.configFile).load();
  const workerStamp = sideworkerBackupStamp(paths.database);
  try {
    // Made here, empty, by this process only: never someone else's file, never readable by others (private history).
    writeFileSync(target, "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HouseholdError(`${target} exists; give another file name`);
    throw error;
  }
  const staging = mkdtempSync(join(tmpdir(), "household-export-"));
  const skillStorage = new HostHomeStorage(houseSkillsRoot(paths.stateDir));
  const cancelSkills = () => skillStorage.cancel();
  signal?.addEventListener("abort", cancelSkills, { once: true });
  try {
    copyFileSync(paths.configFile, join(staging, BACKUP.config));
    chmodSync(join(staging, BACKUP.config), 0o600);
    const schema = snapshotDatabase(paths.database, join(staging, BACKUP.database));
    log(`database: snapshot, schema ${schema}`);
    const ca = TLS_FILES.filter((name) => existsSync(join(paths.tlsDir, name)));
    mkdirSync(join(staging, BACKUP.tls), { mode: 0o700 });
    for (const name of ca) {
      copyFileSync(join(paths.tlsDir, name), join(staging, BACKUP.tls, name));
      chmodSync(join(staging, BACKUP.tls, name), 0o600);
    }
    log(`${BACKUP.tls}: ${ca.join(", ") || "none"}`);
    for (const { name, accountId } of subscriptionAuthKeys(household.keys)) {
      const source = readDedicatedAuth(dedicatedAuthRoot(paths.configFile), name, accountId);
      copyDedicatedAuth(source, join(staging, CODEX_AUTH_BACKUP), name);
      log(`Codex subscription ${name}: dedicated authentication saved`);
    }
    mkdirSync(join(staging, BACKUP.volumes));
    for (const house of household.houses) {
      for (const pet of house.pets) {
        signal?.throwIfAborted();
        await saveHome(runtime, house.name, pet.name, staging, log, instanceId(paths.stateDir));
      }
    }
    mkdirSync(join(staging, BACKUP.skills));
    for (const house of household.houses) {
      signal?.throwIfAborted();
      if (!(await skillStorage.volumeHasFiles(house.name))) continue;
      const paused: string[] = [];
      try {
        for (const pet of house.pets) {
          const name = petContainer(house.name, pet.name);
          const info = await runtime.container(name);
          if (info && ownerOf(info) !== instanceId(paths.stateDir)) throw new HouseholdError("foreign pet runtime during skills export");
          if (info?.state === "running") { paused.push(name); await runtime.pause(name); }
        }
        await skillStorage.saveVolume(house.name, join(staging, BACKUP.skills, `${house.name}.tar`));
      } finally {
        const resumed = await Promise.allSettled(paused.map(name => runtime.unpause(name)));
        if (resumed.some(result => result.status === "rejected")) throw new HouseholdError("could not resume every pet after skills export; check house status");
      }
      log(`house ${house.name}: shared skills saved`);
    }
    signal?.throwIfAborted();
    if (sideworkerBackupStamp(paths.database) !== workerStamp) throw new HouseholdError("A sideworker started during export; close all sideworkers and retry the export.");
    const manifest: Manifest = { format: BACKUP.format, created: created.toISOString(), household: await householdVersion(), schema };
    writeFileSync(join(staging, BACKUP.manifest), `${JSON.stringify(manifest)}\n`);
    await packDir(staging, target);
    return { file: target, bytes: statSync(target).size };
  } catch (error) {
    rmSync(target, { force: true }); // ours, from above: a half-written archive is not a backup
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelSkills);
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Saves a pet's home into `dir`, if it has files (a pet that never ran has none). */
async function saveHome(runtime: BackupDeps["runtime"], house: string, pet: string, dir: string, log: BackupDeps["log"], owner: string): Promise<void> {
  const volume = petVolume(house, pet);
  const container = petContainer(house, pet);
  const info = await runtime.container(container);
  if (info && ownerOf(info) !== owner) throw new HouseholdError(`pet ${house}/${pet}: same-named runtime belongs to another Household; not paused or exported`);
  if (!(await runtime.volumeHasFiles(volume))) return log(`pet ${house}/${pet}: no home yet, skipped`);
  const state = info?.state;
  // Paused, the pet changes nothing while its files are read. One paused already is someone else's to unpause.
  const pause = state === "running";
  try {
    if (pause) await runtime.pause(container);
    await runtime.saveVolume(volume, join(dir, volumeEntry(volume)));
  } finally {
    if (pause) await runtime.unpause(container); // also when the pause itself was cut short: it may have taken
  }
  const how = pause ? "paused while saved" : state === "paused" ? "it was paused, left so" : "pet not running";
  log(`pet ${house}/${pet}: home ${volume} (${how})`);
}
