/** Every `ms`: the default way a log follow waits for its next read. */
export const every = (ms: number) => (callback: () => void) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/** A log follow under way: Live or paused, and stopped for good when what it reads changes. */
export interface LogFollow {
  setLive(live: boolean): void;
  stop(): void;
}

/**
 * Reads a log's first page, then while live what came after its cursor, one request at a time. Stopping cancels a
 * request in flight and drops its answer, so a view that now reads something else (another filter, another pet)
 * never gets the old read's lines or cursor.
 */
export function followLog<P extends { cursor: string }>(
  read: (after: string | undefined, signal: AbortSignal) => Promise<P>,
  update: (page: P, first: boolean) => void,
  failed: (message: string) => void,
  { live = true, schedule }: { live?: boolean; schedule: (callback: () => void) => () => void },
): LogFollow {
  const controller = new AbortController();
  let cursor: string | undefined;
  let busy = false;
  let cancelTimer: (() => void) | undefined;
  const wait = () => {
    if (live && !busy && !cancelTimer && !controller.signal.aborted) cancelTimer = schedule(() => void next());
  };
  const next = async () => {
    cancelTimer = undefined;
    busy = true;
    try {
      const page = await read(cursor, controller.signal);
      if (controller.signal.aborted) return;
      update(page, cursor === undefined);
      cursor = page.cursor;
    } catch (error) {
      if (!controller.signal.aborted) failed(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      wait();
    }
  };
  void next();
  return {
    setLive(value) {
      live = value;
      if (live) wait();
      else {
        cancelTimer?.();
        cancelTimer = undefined;
      }
    },
    stop() {
      controller.abort();
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
