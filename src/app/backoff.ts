/** A one-shot timer whose delay doubles each time it is scheduled again, up to `max`, until `reset()`. */
export class Backoff {
  private timer?: ReturnType<typeof setTimeout>;
  private delay: number;

  constructor(
    private readonly first: number,
    private readonly max: number,
  ) {
    this.delay = first;
  }

  schedule(run: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(run, this.delay);
    this.delay = Math.min(this.delay * 2, this.max);
  }

  /** Drops a pending run; the next one still waits longer. */
  cancel(): void {
    clearTimeout(this.timer);
  }

  reset(): void {
    this.cancel();
    this.delay = this.first;
  }
}
