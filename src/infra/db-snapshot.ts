import { Database } from "bun:sqlite";

/**
 * Writes a consistent copy of SQLite database `source` to `target` (a new file) while another process may be
 * writing it: `VACUUM INTO` reads one snapshot, the WAL included, which a copy of the file would miss. The copy
 * is in rollback-journal mode, a single file. Resolves to its schema version.
 */
export function snapshotDatabase(source: string, target: string): number {
  // Not `readonly`: SQLite does not open a WAL database so while its `-shm` is missing. Not `query_only` either:
  // it refuses VACUUM INTO. The source is only read.
  const db = new Database(source, { readwrite: true, create: false });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run("VACUUM INTO ?", [target]);
  } finally {
    db.close();
  }
  return schemaVersion(target);
}

/** `PRAGMA user_version` of a database in rollback-journal mode (a snapshot); throws if it is not SQLite. */
export function schemaVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  } finally {
    db.close();
  }
}
