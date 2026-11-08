// The daemon's history process (`HistoryRunner`): one read-only connection to the database (argv[2]), one search
// per IPC message, answered with `{ page }` or `{ error }`. It goes when the daemon does.
import { openReadOnly, searchHistory, type HistoryFilter } from "./history-store";

const db = openReadOnly(process.argv[2]!);
process.on("disconnect", () => process.exit(0));
process.on("message", (filter: HistoryFilter) => {
  try {
    process.send!({ page: searchHistory(db, filter) });
  } catch (error) {
    process.send!({ error: (error as Error).message });
  }
});
