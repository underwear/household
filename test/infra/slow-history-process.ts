// A history process for HistoryRunner's tests: house "slow" never finishes (a query stuck in SQLite), "crash"
// exits, "exit" answers and then exits (dies between searches), any other answers at once with an empty page.
process.on("disconnect", () => process.exit(0));
process.on("message", ({ house }: { house: string }) => {
  if (house === "crash") process.exit(3);
  while (house === "slow") {} // synchronous, as a query in bun:sqlite is
  process.send!({ page: { records: [], more: false } });
  if (house === "exit") setTimeout(() => process.exit(0), 10);
});
