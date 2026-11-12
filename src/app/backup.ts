import { Database } from "bun:sqlite";
import { SIDEWORKER_STATE_KEY } from "./sideworkers";
import { basename } from "node:path";
import { HouseholdError } from "../core/errors";
import { tlsFiles } from "../infra/certificates";
import type { Paths } from "../infra/paths";
import type { ContainerRuntime, StorageRuntime } from "../infra/runtime";
import type { HouseholdVersion } from "./version";

/**
 * A backup is one `.tar.gz` (mode 600) of: `manifest.json`, the config `household.yaml` (with the keys and bot
 * tokens in it), a snapshot of the database `household.db`, Household's CA (certificate and key) as `tls/` —
 * all in plain form, so the archive is as private as the config (TODO, the owner's call: encrypt it) — and the
 * configured ChatGPT subscription credentials as `codex-auth/<key>/auth.json`, and the
 * home volume of each pet that has one, as `volumes/<volume>.tar`. Enough for a whole Household on a new Mac:
 * pets keep trusting the same CA. Not the leaf (made again on the next start), the gateway's copies of the keys
 * (made on every start) or the logs. Which pets there are, and so which volumes, is the config's to say. Not the
 * Claude sign-ins (`claude-auth/`) either: each renewal (every few hours) kills the tokens before it, so a copy is
 * dead within hours; a restored Household signs in to Claude again (its keys say so).
 */
export const BACKUP = {
  /** 4: shared house skills, once per house. Format 3 remains importable (no shared skills). */
  format: 4,
  manifest: "manifest.json",
  config: "household.yaml",
  database: "household.db",
  tls: "tls",
  volumes: "volumes",
  skills: "skills",
} as const;

/** The files of the TLS dir a backup carries: the CA's. */
export const TLS_FILES = [tlsFiles("").caCert, tlsFiles("").caKey].map((path) => basename(path));

export interface Manifest {
  format: 3 | typeof BACKUP.format;
  /** ISO time of the export. */
  created: string;
  /** The Household that made it. */
  household: HouseholdVersion;
  /** The database's schema version (`user_version`), to show without opening it. */
  schema: number;
}

/** Where a volume's tar is in the archive. */
export const volumeEntry = (volume: string) => `${BACKUP.volumes}/${volume}.tar`;

/** Strings of a manifest are printed: short, and nothing that could steer a terminal. */
const SAFE = /^[\w.:+-]{1,64}$/;

/** Reads an archive's manifest: a format this Household reads. */
export function parseManifest(text: string): Manifest {
  let manifest: { format?: unknown; created?: unknown; household?: { version?: unknown; commit?: unknown }; schema?: unknown } | null;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new HouseholdError("not a Household backup: manifest.json is not JSON");
  }
  const format = manifest?.format;
  if (format === 1) throw new HouseholdError("archive format 1 is from before secrets were included; export again");
  if (format === 2) throw new HouseholdError("archive format 2 is from before keys-in-config: unpack it by hand (its secrets/ go into household.yaml as keys and tokens)");
  if (format !== 3 && format !== BACKUP.format) throw new HouseholdError(`archive format ${SAFE.test(String(format)) ? format : "?"} is not one this Household reads (${BACKUP.format})`);
  const { created, household, schema } = manifest!;
  const safe = (value: unknown): value is string => typeof value === "string" && SAFE.test(value);
  const commit = household?.commit;
  if (!safe(created) || !safe(household?.version) || !(commit === undefined || safe(commit)) || typeof schema !== "number" || !Number.isInteger(schema)) {
    throw new HouseholdError("not a Household backup: manifest.json lacks its time, Household version or schema");
  }
  return { format: format as Manifest["format"], created, household: { version: household.version, commit }, schema };
}

/** Local time as `YYYYMMDD-HHMM`. */
export function stamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}

/** What export and import need. */
export interface BackupDeps {
  paths: Paths;
  runtime: StorageRuntime & Pick<ContainerRuntime, "container" | "pause" | "unpause">;
  /** Progress, a line at a time. */
  log: (line: string) => void;
  now?: () => Date;
}

/** Workers can write their parent's home and their private sessions are not part of portable backups yet. */
export function sideworkerBackupStamp(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    const value = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key)?.value;
    if (JSON.parse(value(SIDEWORKER_STATE_KEY) ?? "[]").length) throw new HouseholdError("Close all sideworkers before backup or restore: they share bot files and their sessions are not included in backups yet.");
    // Used names persist after close, so a worker created and closed during export also invalidates it.
    return value(`${SIDEWORKER_STATE_KEY}.used-names`) ?? "[]";
  } finally { db.close(); }
}
