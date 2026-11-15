import { CLOCK, type Clock } from "../core/clock";

export interface LifecycleOperation {
  phase: string;
  house?: string;
  pet?: string;
  elapsedMs: number;
}

/** Diagnostic deadlines never abandon a VM mutation that is still running. Command cancellation belongs to its runtime. */
export class LifecycleProgress {
  private readonly active = new Set<{ phase: string; house?: string; pet?: string; since: number }>();
  onSlow?: (operation: LifecycleOperation) => void;

  constructor(private readonly clock: Clock = CLOCK, private readonly slowMs = 5 * 60_000) {}

  get pending(): LifecycleOperation[] {
    return [...this.active].map(({ since, ...operation }) => ({ ...operation, elapsedMs: Math.max(0, this.clock.now() - since) }));
  }

  async run<T>(phase: string, work: () => Promise<T>, pet?: { house: string; pet: string }): Promise<T> {
    const subject = pet ? { house: pet.house, pet: pet.pet } : {};
    const operation = { phase, ...subject, since: this.clock.now() };
    this.active.add(operation);
    const cancel = this.clock.after(this.slowMs, () => this.onSlow?.({ phase, ...subject, elapsedMs: Math.max(0, this.clock.now() - operation.since) }));
    try { return await work(); }
    finally { cancel(); this.active.delete(operation); }
  }
}
