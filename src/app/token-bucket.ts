/** Allows `perSecond` on average, in bursts of up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private refilled = Date.now();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  /** Takes one token; false when there is none. */
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.refilled) / 1000) * this.perSecond);
    this.refilled = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
