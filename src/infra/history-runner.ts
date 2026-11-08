import type { Subprocess } from "bun";
import { join } from "node:path";
import { HouseholdError } from "../core/errors";
import { COMPILED } from "./release";
import { HISTORY_PROCESS_COMMAND } from "./history-process";
import type { HistoryFilter, HistoryPage, HistorySearch } from "./history-store";

/** The history process: its source run by Bun, or, for a compiled house, the binary itself told to be one. */
const PROCESS = COMPILED ? [process.execPath, HISTORY_PROCESS_COMMAND] : [process.execPath, join(import.meta.dir, "history-process.ts")];

/** How many searches may be running or waiting at once, of all pets (one each at most). */
export const MAX_SEARCHES = 4;

type Answer = { page: HistoryPage } | { error: string };
type Child = Subprocess<"ignore", "ignore", "inherit">;

interface Search {
  /** The pet asking: `house/pet`. */
  asker: string;
  filter: HistoryFilter;
  timer: ReturnType<typeof setTimeout>;
  settle: (answer: Answer) => void;
  /** Sent to a process that ran searches before: if it turns out dead, the search goes again to a fresh one. */
  reused?: boolean;
}

/**
 * History searches in a process of their own, with its own read-only connection: bun:sqlite is synchronous, so
 * a slow query on the daemon's connection would hold up everything (WAL keeps the two from blocking each other).
 * A process, not a Worker: terminating a Worker does not stop a query already running in SQLite, killing a
 * process does. One process, started on the first search and kept (a fresh one if it is gone); searches go one
 * at a time. Each has `timeoutMs` from when it is asked, waiting included: one still waiting then fails, one
 * running is killed with its process. A pet has one search at a time; MAX_SEARCHES in all.
 */
export class HistoryRunner implements HistorySearch {
  private child?: Child;
  private running?: Search;
  private readonly waiting: Search[] = [];

  constructor(
    private readonly database: string,
    private readonly timeoutMs: number,
    /** What runs the process; the database's path is its last argument. */
    private readonly command = PROCESS,
  ) {}

  search(filter: HistoryFilter): Promise<HistoryPage> {
    const asker = `${filter.house}/${filter.pet}`;
    const searches = [...this.waiting, ...(this.running ? [this.running] : [])];
    if (searches.some((search) => search.asker === asker)) return Promise.reject(new HouseholdError("a history search is already running: wait for its result"));
    if (searches.length >= MAX_SEARCHES) return Promise.reject(new HouseholdError("history search is busy: try again in a moment"));
    return new Promise((resolve, reject) => {
      const search: Search = {
        asker,
        filter,
        timer: setTimeout(() => this.expire(search), this.timeoutMs),
        settle: (answer) => ("error" in answer ? reject(new HouseholdError(answer.error)) : resolve(answer.page)),
      };
      this.waiting.push(search);
      this.next();
    });
  }

  /** Kills the process, if any; searches running or waiting fail. */
  stop(): void {
    this.kill();
    for (const search of [...this.waiting, ...(this.running ? [this.running] : [])]) this.finish(search, { error: "history search stopped" });
  }

  private next(): void {
    if (this.running) return;
    const search = this.waiting.shift();
    if (!search) return;
    this.running = search;
    const reused = this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed;
    if (!reused) this.child = this.spawn();
    search.reused = reused;
    this.child!.send(search.filter);
  }

  /** Its time is up: waiting, it never runs; running, its process is killed with the query. */
  private expire(search: Search): void {
    if (this.running === search) this.kill();
    this.finish(search, { error: `history search took longer than ${this.timeoutMs / 1000} s: narrow it (fewer words, a person, a date range)` });
  }

  private finish(search: Search, answer: Answer): void {
    clearTimeout(search.timer);
    const index = this.waiting.indexOf(search);
    if (index >= 0) this.waiting.splice(index, 1);
    else if (this.running === search) this.running = undefined;
    else return; // settled already
    search.settle(answer);
    this.next();
  }

  /**
   * A fresh process. One that has died since its last search is not reused (`next`); one whose death is not
   * reported yet fails the search sent to it, and that search goes again, once, to a fresh process.
   */
  private spawn(): Child {
    const child: Child = Bun.spawn([...this.command, this.database], {
      stdio: ["ignore", "ignore", "inherit"],
      // Answers and exits of a process killed since are not the running search's.
      ipc: (answer: Answer) => {
        if (this.child === child && this.running) this.finish(this.running, answer);
      },
      onExit: () => {
        if (this.child !== child) return;
        this.child = undefined;
        const search = this.running;
        if (!search) return;
        if (!search.reused) return this.finish(search, { error: "history search failed: its process exited" });
        this.running = undefined;
        this.waiting.unshift(search);
        this.next();
      },
    });
    return child;
  }

  private kill(): void {
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }
}
