import { expect, test } from "bun:test";
import { join } from "node:path";
import { Monitoring } from "../../src/app/monitoring";
import { metricSample, type MetricSnapshot } from "../../src/core/metrics";
import { MetricsStore, METRICS_RETENTION_MS } from "../../src/infra/metrics-store";
import { tempDir } from "../helpers";
const boot = "00000000-0000-4000-8000-000000000001";
const snapshot = (total = 100, idle = 60): MetricSnapshot => ({ boot,
  cpus: [{ id: "cpu", total, idle }, { id: "cpu0", total, idle }], memory: { total: 1000, available: 400 }, load: [1, 2, 3],
  disks: { system: { total: 100, used: 30, available: 60 }, docker: null }, services: { docker: "up", proxy: "down" } });

test("CPU uses interval deltas, resets at boot/counter regression, memory excludes reclaimable availability", () => {
  const first = snapshot();
  expect(metricSample(0, first).cpu).toBeNull();
  const next = snapshot(200, 100);
  expect(metricSample(60_000, next, first)).toMatchObject({ cpu: 60, cores: [{ id: "cpu0", usage: 60 }], memory: { total: 1000, used: 600, available: 400 } });
  expect(metricSample(60_000, { ...next, boot: "00000000-0000-4000-8000-000000000002" }, first).cpu).toBeNull();
  expect(metricSample(60_000, snapshot(200, 40), first).cpu).toBeNull();
  expect(metricSample(60_000, snapshot(50, 20), first).cpu).toBeNull();
});

test("collector scopes history, skips stopped guests, records failures as gaps, bounds retention and persists restart", async () => {
  const path = join(tempDir(), "metrics.db");
  const store = new MetricsStore(path);
  let now = 1_000_000, probes = 0, failed = false;
  const monitoring = new Monitoring(store, async () => [
    { house: "work", pet: "a", agent: "fixture", container: "a", state: "running" },
    { house: "work", pet: "b", agent: "fixture", container: "b", state: "disabled" },
  ], async () => { probes++; return { ok: !failed, output: JSON.stringify(snapshot(100 * probes, 50 * probes)) }; }, () => now);
  await monitoring.tick(); now += 60_000; await monitoring.tick();
  expect(probes).toBe(2);
  expect(monitoring.history("work", "a", "1h").samples.at(-1)?.cpu).toBe(50);
  expect(monitoring.history("work", "b", "1h").samples.at(-1)?.status).toBe("stopped");
  expect(monitoring.history("other", "a", "7d").samples).toEqual([]);
  failed = true; now += 60_000; await monitoring.tick();
  expect(monitoring.history("work", "a", "1h").samples.at(-1)?.status).toBe("unavailable");
  failed = false; now += 60_000; await monitoring.tick();
  expect(monitoring.history("work", "a", "1h").samples.at(-1)?.cpu).toBeNull();
  now += METRICS_RETENTION_MS + 1;
  expect(monitoring.latest("work", "a")).toBeNull();
  await monitoring.tick();
  expect(monitoring.latest("work", "a")?.status).toBe("ok");
  // Docker's and its proxy's health ride along with each sample: the UI shows one that is down.
  expect(monitoring.latest("work", "a")?.services).toEqual({ docker: "up", proxy: "down" });
  expect(monitoring.history("work", "a", "7d").samples).toHaveLength(1);
  await monitoring.stop();
  const reopened = new MetricsStore(path);
  expect(reopened.history("work", "a", 0, now)).toHaveLength(1);
  reopened.close();
});

test("concurrent ticks coalesce and stop waits for the read-only probe before closing storage", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let probes = 0;
  const monitor = new Monitoring(new MetricsStore(join(tempDir(), "metrics.db")), async () => [{ house: "work", pet: "a", agent: "fixture", container: "a", state: "running" }], async () => {
    probes++; await gate; return { ok: true, output: JSON.stringify(snapshot()) };
  });
  const first = monitor.tick();
  expect(monitor.tick()).toBe(first);
  await Promise.resolve();
  const stopped = monitor.stop(); finish();
  await stopped;
  expect(probes).toBe(1);
  await monitor.tick(); expect(probes).toBe(1);
});
