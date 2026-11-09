import { CLOCK, type Clock } from "../core/clock";
import { CronError } from "../core/cron";
import type { CronStore } from "../infra/cron-store";
import type { Delivery } from "./delivery";

/** One host scheduler. Offline deadlines are caught up once; a dispatched task is never automatically rerun. */
export class Crons {
  private cancel?: () => void;
  private running = false;
  constructor(
    private readonly store: CronStore,
    private readonly delivery: Pick<Delivery, "acceptScheduled">,
    private readonly exists: (house: string, pet: string) => boolean,
    private readonly log: (message: string) => void,
    private readonly clock: Clock = CLOCK,
    private readonly enabled: (house: string, pet: string) => boolean = () => true,
  ) {}
  private check(house: string, pet: string) {
    if (!this.exists(house, pet))
      throw new CronError("Bot is not configured", 404);
  }
  setTimezone(timezone: string) {
    this.store.setTimezone(timezone, this.clock.now());
  }
  list(house: string, pet: string) {
    this.check(house, pet);
    return this.store.view(house, pet);
  }
  get(house: string, pet: string, id: string) {
    this.check(house, pet);
    return this.store.get(house, pet, id);
  }
  create(house: string, pet: string, input: unknown) {
    this.check(house, pet);
    return this.store.create(house, pet, input, this.clock.now());
  }
  update(
    house: string,
    pet: string,
    id: string,
    revision: number,
    input: unknown,
  ) {
    this.check(house, pet);
    return this.store.update(house, pet, id, revision, input, this.clock.now());
  }
  delete(house: string, pet: string, id: string, revision: number) {
    this.check(house, pet);
    return this.store.delete(house, pet, id, revision, this.clock.now());
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.poll();
  }
  stop() {
    this.running = false;
    this.cancel?.();
  }
  tick() {
    for (const job of this.store.due(this.clock.now())) {
      if (!this.exists(job.house, job.pet) || !this.enabled(job.house, job.pet)) continue;
      const message = this.store.fire(job, this.clock.now());
      if (!message) continue;
      this.log(`cron ${job.id}: queued for ${job.house}/${job.pet}`);
      this.delivery.acceptScheduled(job.house, job.pet, message);
    }
  }
  private poll() {
    try {
      this.tick();
    } catch (error) {
      this.log(`cron scheduler error: ${(error as Error).message}`);
    }
    if (this.running) this.cancel = this.clock.after(1000, () => this.poll());
  }
}
