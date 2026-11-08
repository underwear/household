/** What time it is, and running something later (returns how to cancel it): a batch's quiet window, a live message's next edit. */
export interface Clock {
  now(): number;
  after(ms: number, run: () => void): () => void;
}

export const CLOCK: Clock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
