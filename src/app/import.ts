import { HostHomeStorage } from "../infra/home-storage";
import { houseSkillsRoot } from "../infra/house-skills";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HouseholdError } from "../core/errors";
import { ConfigStore } from "../infra/config-store";
import { schemaVersion } from "../infra/db-snapshot";
import { copyPlainTree } from "../infra/plain-tree";
import { SCHEMA_VERSION } from "../infra/sqlite-store";
import { unpackFile } from "../infra/tarball";
import { BACKUP, parseManifest, sideworkerBackupStamp, TLS_FILES, volumeEntry, type BackupDeps } from "./backup";
import { instanceId, ownerOf, petContainer, petVolume } from "./pet-plane";
import { VERSION } from "./version";
import { CODEX_AUTH_BACKUP, assertAuthDestination, copyDedicatedAuth, dedicatedAuthRoot, readDedicatedAuth, subscriptionAuthKeys } from "./codex-auth-backup";

/** No backup of a few pets' homes comes near this; an archive that unpacks to more is refused. */
export const MAX_UNPACKED_BYTES = 20 * 1024 ** 3;

/** A database is its file and, while open or after a crash, its `-wal` and `-shm`: they go together. */
const databaseFiles = (path: string) => [path, `${path}-wal`, `${path}-shm`];

/**
 * `house import`, with the daemon stopped (the caller's check): restores an export (see `BACKUP`). Its pets are
 * the restored config's; their volumes are named here, never by the archive. Refuses a pet whose container is
 * running or is another Household's (names are global), and, unless `force`, anything it would replace: a
 * config, a database, a TLS dir, a pet's home with files. With `force` the config, the database and the TLS dir
 * are moved aside to `*.bak-<ms>` (the TLS dir whole, so no old leaf stays: the next start makes one for the
 * restored CA); nothing is deleted, and each home is replaced. Every refusal comes before any change. An archive of another
 * Household version is restored with a warning; one whose schema is newer, refused. Stops at the next step once
 * `signal` aborts; the unpacked archive (keys and tokens in plain form) is always removed.
 */
export async function importHousehold(
  { paths, runtime, log, now = () => new Date() }: BackupDeps,
  file: string,
  { force = false, signal }: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new HouseholdError(`no such file: ${file}`);
  if (existsSync(paths.database)) sideworkerBackupStamp(paths.database);
  const staging = mkdtempSync(join(tmpdir(), "household-import-"));
  const skillStorage = new HostHomeStorage(houseSkillsRoot(paths.stateDir));
  const cancelSkills = () => skillStorage.cancel();
  signal?.addEventListener("abort", cancelSkills, { once: true });
  try {
    const unpacked = join(staging, "archive"); // beside it, out of the archive's reach: the checked copies
    mkdirSync(unpacked);
    await unpackFile(file, unpacked, MAX_UNPACKED_BYTES, signal);
    signal?.throwIfAborted();
    const root = realpathSync(unpacked);
    // What it reads must be the archive's own: no link to elsewhere, at any level.
    const entry = (name: string, kind: "file" | "dir" = "file") => {
      const path = join(unpacked, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      const right = kind === "file" ? stat?.isFile() : stat?.isDirectory();
      if (!right || !realpathSync(path).startsWith(`${root}/`)) throw new HouseholdError(`not a Household backup: no ${name} in ${file}`);
      return path;
    };
    const manifest = parseManifest(readFileSync(entry(BACKUP.manifest), "utf8"));
    const { household: from, schema: archived, created } = manifest;
    log(`archive from Household ${from.version}${from.commit ? ` at ${from.commit}` : ""} (schema ${archived}), made ${created}`);
    if (from.version !== VERSION) log(`warning: the archive is from Household ${from.version}, this is ${VERSION}; restoring anyway`);
    const config = entry(BACKUP.config);
    const database = entry(BACKUP.database);
    const tars = new Set(readdirSync(entry(BACKUP.volumes, "dir")));
    // Each checked whole by copying it (a link anywhere is refused): what is restored later is that clean copy.
    const checked = (dir: string) => ({ dir: join(staging, dir), files: copyPlainTree(entry(dir, "dir"), join(staging, dir)) });
    const tls = checked(BACKUP.tls);
    for (const name of tls.files) if (!TLS_FILES.includes(name)) log(`ignored: ${BACKUP.tls}/${name} (a backup carries only the CA)`);
    const ca = tls.files.filter((name) => TLS_FILES.includes(name));
    const household = await new ConfigStore(config).load();
    const schema = schemaVersion(database);
    if (schema > SCHEMA_VERSION) {
      throw new HouseholdError(`the backup's database has schema ${schema}, newer than this Household knows (${SCHEMA_VERSION}): update Household first`);
    }
    sideworkerBackupStamp(database);
    const homes = household.houses.flatMap((house) =>
      house.pets.map((pet) => ({ house: house.name, pet: pet.name, volume: petVolume(house.name, pet.name) })),
    );
    for (const name of tars) {
      if (!homes.some(({ volume }) => `${volume}.tar` === name)) log(`ignored: ${BACKUP.volumes}/${name} (no such pet in the backup's config)`);
    }
    const restore = homes.filter(({ volume }) => tars.has(`${volume}.tar`)).map((home) => ({ ...home, tar: entry(volumeEntry(home.volume)) }));

    const skillArchives: {house: string; tar: string}[] = [];
    if (manifest.format === 4) {
      entry(BACKUP.skills, "dir");
      for (const house of household.houses) {
        const name = `${BACKUP.skills}/${house.name}.tar`;
        if (lstatSync(join(root, name), {throwIfNoEntry:false})) skillArchives.push({house: house.name, tar: entry(name)});
      }
    }
    const authRoot = dedicatedAuthRoot(paths.configFile);
    const auth = subscriptionAuthKeys(household.keys).map(({ name, accountId }) => {
      const source = readDedicatedAuth(join(root, CODEX_AUTH_BACKUP), name, accountId);
      assertAuthDestination(authRoot, name);
      return { name, source, target: join(authRoot, name) };
    });

    const mine = instanceId(paths.stateDir);
    const blocked: string[] = [];
    for (const { house, pet } of homes) {
      const info = await runtime.container(petContainer(house, pet));
      if (!info) continue;
      const owner = ownerOf(info);
      if (owner !== mine) {
        const whose = owner ? `another Household's (instance ${owner})` : "not Household's";
        blocked.push(`container ${info.name} is ${whose}: its home is not this Household's to replace`);
      } else if (["running", "paused", "starting", "stopping", "unknown"].includes(info.state)) {
        // On its way up or down, or with an agent in a state the runtime cannot read, a VM may write its home too.
        blocked.push(`bot ${house}/${pet} is ${info.state}: stop it first (msb stop ${info.name})`);
      }
    }
    if (blocked.length > 0) throw new HouseholdError(blocked.join("\n"));
    const present = [paths.configFile, ...databaseFiles(paths.database), ...(ca.length > 0 ? [paths.tlsDir] : []), ...auth.map(({ target }) => target)].filter((path) => existsSync(path));
    const used: string[] = [];
    for (const { volume } of restore) if (await runtime.volumeHasFiles(volume)) used.push(volume);
    const usedSkills: string[] = [];
    for (const house of household.houses) if (await skillStorage.volumeHasFiles(house.name)) usedSkills.push(house.name);
    if (!force && (present.length > 0 || used.length > 0 || usedSkills.length > 0)) {
      const what = [...present, ...used.map((volume) => `volume ${volume} (has files)`), ...usedSkills.map(house => `house ${house} skills (has files)`)];
      throw new HouseholdError(
        `would replace:\n  ${what.join("\n  ")}\nrun again with --force: the config, the database and TLS are moved aside to *.bak-<time>, the homes replaced`,
      );
    }

    signal?.throwIfAborted();
    const restored: string[] = [];
    try {
      const suffix = `.bak-${now().getTime()}`;
      for (const path of present) {
        const to = asideName(path, paths.database, suffix);
        renameSync(path, to);
        log(`moved aside: ${path} → ${to}`);
      }
      mkdirSync(dirname(paths.configFile), { recursive: true });
      copyFileSync(config, paths.configFile);
      chmodSync(paths.configFile, 0o600); // it holds the keys and bot tokens
      restored.push("config");
      log(`config: ${paths.configFile}`);
      mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
      copyFileSync(database, paths.database);
      chmodSync(paths.database, 0o600);
      restored.push("database");
      log(`database: ${paths.database} (schema ${schema})`);
      if (ca.length > 0) {
        mkdirSync(paths.tlsDir, { mode: 0o700 });
        for (const name of ca) writeFileSync(join(paths.tlsDir, name), readFileSync(join(tls.dir, name)), { mode: 0o600, flag: "wx" });
        restored.push("tls"); // the same CA: pets keep trusting it
        log(`tls: ${paths.tlsDir}`);
      }
      for (const { name, source } of auth) {
        copyDedicatedAuth(source, authRoot, name);
        restored.push(`Codex subscription ${name}`);
        log(`Codex subscription ${name}: dedicated authentication restored`);
      }
      // Preserve previous shared folders alongside restored state, including for old format-3 imports.
      for (const house of usedSkills) renameSync(join(houseSkillsRoot(paths.stateDir), house), join(houseSkillsRoot(paths.stateDir), `${house}${suffix}`));
      for (const {house, tar} of skillArchives) {
        signal?.throwIfAborted();
        await skillStorage.loadVolume(house, tar);
        restored.push(`house ${house} skills`);
      }
      for (const { volume, tar } of restore) {
        signal?.throwIfAborted();
        await runtime.loadVolume(volume, tar);
        restored.push(`volume ${volume}`);
        log(`volume ${volume}: ${used.includes(volume) ? "replaced" : "restored"}`);
      }
    } catch (error) {
      log(`restored before the failure: ${restored.join(", ") || "nothing"}`);
      throw error;
    }
    log("next: `house doctor`, then `house start`");
  } finally {
    signal?.removeEventListener("abort", cancelSkills);
    rmSync(staging, { recursive: true, force: true });
  }
}

/** `household.db-wal` goes aside as `household.db.bak-<ms>-wal`, where SQLite looks for the `.bak` database's WAL. */
function asideName(path: string, database: string, suffix: string): string {
  return path.startsWith(`${database}-`) ? `${database}${suffix}${path.slice(database.length)}` : `${path}${suffix}`;
}
