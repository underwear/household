// The daemon's history process (`HistoryRunner`): one read-only connection to the database, one search per IPC
// message, answered with `{ page }` or `{ error }`. It goes when the daemon does. Run as this file by Bun, or as
// `house __history <database>` by a compiled house.
import { openReadOnly, searchHistory, type HistoryFilter } from "./history-store";

/** The hidden command a compiled house runs this as. */
export const HISTORY_PROCESS_COMMAND = "__history";

export function runHistoryProcess(database: string): void {
  const db = openReadOnly(database);
  process.on("disconnect", () => process.exit(0));
  process.on("message", (filter: HistoryFilter) => {
    try {
      process.send!({ page: searchHistory(db, filter) });
    } catch (error) {
      process.send!({ error: (error as Error).message });
    }
  });
}

if (import.meta.main) runHistoryProcess(process.argv[2]!);
