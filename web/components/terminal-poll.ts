/** One request at a time; stopping also cancels a request already in flight. */
export function pollTerminal(
  read: (signal: AbortSignal) => Promise<{ text: string }>,
  update: (text: string) => void,
  failed: (message: string) => void,
  schedule: (callback: () => void) => () => void = (callback) => {
    const timer = setTimeout(callback, 2000);
    return () => clearTimeout(timer);
  },
): () => void {
  const controller = new AbortController();
  let cancelTimer: (() => void) | undefined;
  const next = async () => {
    try {
      const result = await read(controller.signal);
      if (!controller.signal.aborted) update(result.text);
    } catch (error) {
      if (!controller.signal.aborted) failed(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) cancelTimer = schedule(() => void next());
    }
  };
  void next();
  return () => {
    controller.abort();
    cancelTimer?.();
  };
}
