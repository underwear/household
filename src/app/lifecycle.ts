import { CronExpressionParser } from "cron-parser";
import { CLOCK, type Clock } from "../core/clock";
import { lifecycleCron, shutdownMessage, wakeUpMessage, type PetLifecycle } from "../core/lifecycle";
import type { RestartNotice } from "./environment";

/** A pet whose lifecycle is on, as the applied config has it. */
export interface LifecyclePet {
  house: string;
  pet: string;
  lifecycle: PetLifecycle;
}

export interface LifecycleOptions {
  /** The pets to restart on schedule: enabled, applied, lifecycle on. */
  pets: () => LifecyclePet[];
  timezone: () => string;
  /** The graceful restart: the notice is sent, the VM restarts when the turn ends or the time is up. */
  restart: (house: string, pet: string, notice: RestartNotice) => Promise<unknown>;
  /** Sends the wake-up message to the restarted pet. */
  wakeUp: (house: string, pet: string, text: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  clock?: Clock;
}

/** The shortest grace period a scheduled restart gives, even when the daemon came up just before it. */
const MIN_GRACE_MS = 30_000;

/** The first time the schedule fires after `after`. */
export function nextRestart(lifecycle: PetLifecycle, timezone: string, after: number): number {
  return CronExpressionParser.parse(lifecycleCron(lifecycle), { tz: timezone, currentDate: new Date(after) }).next().getTime();
}

/**
 * Restarts pets on their schedules. Each pet's next restart is planned from when the scheduler first sees its
 * schedule, so one missed while the daemon was down is not caught up. `notice` minutes before it, the restart starts:
 * the shutdown message, the grace period up to the planned time, the restart, then the wake-up message.
 */
export class Lifecycles {
  private readonly plans = new Map<string, { signature: string; at: number }>();
  private readonly busy = new Set<string>();
  private readonly clock: Clock;
  private running = false;
  private cancel?: () => void;

  constructor(private readonly options: LifecycleOptions) {
    this.clock = options.clock ?? CLOCK;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    this.cancel?.();
  }

  /** When each pet restarts next (for the web UI and tests). */
  next(house: string, pet: string): number | undefined {
    return this.plans.get(`${house}/${pet}`)?.at;
  }

  tick(): void {
    const now = this.clock.now();
    const timezone = this.options.timezone();
    const seen = new Set<string>();
    for (const { house, pet, lifecycle } of this.options.pets()) {
      if (!lifecycle.enabled) continue;
      const name = `${house}/${pet}`;
      seen.add(name);
      const signature = JSON.stringify([lifecycleCron(lifecycle), lifecycle.notice, timezone]);
      let plan = this.plans.get(name);
      if (!plan || plan.signature !== signature) {
        plan = { signature, at: nextRestart(lifecycle, timezone, now) };
        this.plans.set(name, plan);
      }
      if (now < plan.at - lifecycle.notice * 60_000) continue;
      const due = plan.at;
      plan.at = nextRestart(lifecycle, timezone, Math.max(now, due));
      if (this.busy.has(name)) continue;
      void this.restart(house, pet, lifecycle, Math.max(due - now, MIN_GRACE_MS));
    }
    for (const name of this.plans.keys()) if (!seen.has(name)) this.plans.delete(name);
  }

  private async restart(house: string, pet: string, lifecycle: PetLifecycle, timeoutMs: number): Promise<void> {
    const name = `${house}/${pet}`;
    this.busy.add(name);
    try {
      this.options.log(`pet ${name}: scheduled restart, sending the shutdown notice`);
      await this.options.restart(house, pet, { text: shutdownMessage(lifecycle), timeoutMs });
      this.options.wakeUp(house, pet, wakeUpMessage(lifecycle));
      this.options.log(`pet ${name}: scheduled restart done, wake-up message sent`);
    } catch (error) {
      this.options.error(`pet ${name}: scheduled restart failed: ${(error as Error).message}`);
    } finally {
      this.busy.delete(name);
    }
  }

  private poll(): void {
    try {
      this.tick();
    } catch (error) {
      this.options.error(`lifecycle scheduler error: ${(error as Error).message}`);
    }
    if (this.running) this.cancel = this.clock.after(15_000, () => this.poll());
  }
}
