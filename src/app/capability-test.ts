import type { CapabilityDefinition } from "../core/scouts";
import type { KeyValueStore } from "../infra/sqlite-store";

/** A disposable VM with one capability installed, as its setup left it. */
export interface ProbeVm {
  /** The setup's outcome (its install script, as root) and the tail of its log. */
  result(): Promise<{ ok: boolean; output: string }>;
  close(): Promise<void>;
}
export interface CapabilityTestResult { at: number; ok: boolean; seconds: number; output: string }

const resultKey = (house: string, name: string) => `capabilities.tests.v1.${house}.${name}`;

/**
 * "Test install": a VM that has only this capability (its install script, network and keys), started, judged by its
 * setup, then removed. Nothing of it is kept but the outcome and the log's tail.
 */
export class CapabilityTests {
  private readonly running = new Set<string>();
  constructor(private readonly deps: { store: KeyValueStore; launch(house: string, capability: CapabilityDefinition): Promise<ProbeVm>; now?: () => number }) {}

  last(house: string, name: string): CapabilityTestResult | undefined {
    const raw = this.deps.store.get(resultKey(house, name));
    return raw ? JSON.parse(raw) : undefined;
  }
  busy(house: string, name: string) { return this.running.has(`${house}/${name}`); }

  async run(house: string, capability: CapabilityDefinition): Promise<CapabilityTestResult> {
    const key = `${house}/${capability.name}`;
    if (this.running.has(key)) throw new Error("A test of this capability is already running");
    this.running.add(key);
    const now = this.deps.now ?? Date.now;
    const started = now();
    let vm: ProbeVm | undefined;
    try {
      let result: { ok: boolean; output: string };
      try {
        vm = await this.deps.launch(house, capability);
        result = await vm.result();
      } catch (error) {
        result = { ok: false, output: error instanceof Error ? error.message : "The test VM did not start" };
      }
      const saved: CapabilityTestResult = { at: now(), ok: result.ok, seconds: Math.round((now() - started) / 1000), output: result.output.slice(-16_384) };
      this.deps.store.set(resultKey(house, capability.name), JSON.stringify(saved));
      return saved;
    } finally {
      await vm?.close().catch(() => {});
      this.running.delete(key);
    }
  }
  forget(house: string, name: string) { this.deps.store.delete(resultKey(house, name)); }
}
