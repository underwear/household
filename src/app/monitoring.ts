import { metricGap, metricSample, metricSnapshot, type MetricSnapshot, type MetricsView } from "../core/metrics";
import { GUEST_METRICS } from "../infra/guest-metrics";
import { MetricsStore } from "../infra/metrics-store";
import type { PetStatus } from "./pet-plane";

export const METRICS_INTERVAL_MS = 60_000;
export class Monitoring {
  private previous = new Map<string, MetricSnapshot>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  constructor(private readonly store: MetricsStore, private readonly states: () => Promise<PetStatus[]>,
    private readonly probe: (house: string, pet: string, command: string[]) => Promise<{ ok: boolean; output: string }>,
    private readonly now: () => number = Date.now) {}
  start() {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, METRICS_INTERVAL_MS);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.collect().catch(() => { this.previous.clear(); }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async collect() {
    const at = this.now();
    this.store.prune(at);
    const states = await this.states();
    const present = new Set(states.map(pet => `${pet.house}/${pet.pet}`));
    for (const key of this.previous.keys()) if (!present.has(key)) this.previous.delete(key);
    // Sequential bounded probes avoid spawning a burst of guest processes for a large house.
    for (const pet of states) {
      if (this.stopped) return;
      const key = `${pet.house}/${pet.pet}`;
      if (pet.state !== "running") {
        this.previous.delete(key);
        this.store.put(pet.house, pet.pet, metricGap(at, pet.state === "unavailable" ? "unavailable" : "stopped"));
        continue;
      }
      try {
        const result = await this.probe(pet.house, pet.pet, ["python3", "-c", GUEST_METRICS]);
        if (!result.ok || result.output.length > 128 * 1024) throw new Error("metrics unavailable");
        const snapshot = metricSnapshot.parse(JSON.parse(result.output));
        if (!snapshot.cpus.some(cpu => cpu.id === "cpu")) throw new Error("missing CPU counters");
        this.store.put(pet.house, pet.pet, metricSample(at, snapshot, this.previous.get(key)));
        this.previous.set(key, snapshot);
      } catch {
        this.previous.delete(key);
        this.store.put(pet.house, pet.pet, metricGap(at, "unavailable"));
      }
    }
  }
  latest(house: string, pet: string) {
    const sample = this.store.latest(house, pet);
    return sample && this.now() - sample.at <= METRICS_INTERVAL_MS * 2 ? sample : null;
  }
  history(house: string, pet: string, range: "1h" | "24h" | "7d"): MetricsView {
    const to = this.now(), from = to - { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 }[range];
    return { from, to, interval: METRICS_INTERVAL_MS, samples: this.store.history(house, pet, from, to) };
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    this.store.close();
  }
}
