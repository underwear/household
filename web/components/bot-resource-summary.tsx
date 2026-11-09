import { useEffect, useState } from "react";
import { api, type BotView } from "../api";
import { gib, petResources } from "../../src/core/resources";
import type { MetricSample } from "../../src/core/metrics";
import { bytes } from "./bot-monitoring";

/** One small latest-sample request for the entire bot index, never full per-bot histories. */
export function useWorkspaceMetrics(house: string) {
  const [samples, setSamples] = useState<Record<string, MetricSample | null>>({});
  useEffect(() => {
    let cancelled = false, pending = false;
    setSamples({});
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const next = await api.houseMetrics(house); if (!cancelled) setSamples(next); }
      catch { if (!cancelled) setSamples({}); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [house]);
  return samples;
}

/**
 * A bot's CPU and RAM (and, on its own page, its disk): what it uses now against what it is given, a thin bar each. The bar is the share of the
 * VM it runs in now, so it stays true while a changed allocation waits for a Restart; no measurement is «—», never zero.
 */
export function BotResourceSummary({ pet, sample, disk = false }: { pet: Pick<BotView, "cpus" | "memoryMiB" | "enabled">; sample?: MetricSample | null; /** Its system disk too: used of its size. */ disk?: boolean }) {
  const configured = petResources(pet);
  const current = pet.enabled !== false && sample?.status === "ok" && Date.now() - sample.at <= 120_000 ? sample : null;
  const cpu = current?.cpu ?? null, cores = current?.cores.length ?? 0;
  const memory = current?.memory ?? null;
  const system = current?.disks?.system ?? null;
  return (
    <span className="bot-card-resources" title="Used now / allocated">
      <Meter label="CPU" value={cpu == null ? "—" : ((cpu * cores) / 100).toFixed(2)} limit={`${configured.cpus} vCPU`} share={cpu} />
      <Meter label="RAM" value={memory ? bytes(memory.used) : "—"} limit={gib(configured.memoryMiB)} share={memory ? (memory.used / memory.total) * 100 : null} />
      {disk && <Meter label="Disk" value={system ? bytes(system.used) : "—"} limit={system ? `${Number((system.total / 1024 ** 3).toFixed(1))} GiB` : "—"} share={system && system.total ? (system.used / system.total) * 100 : null} />}
    </span>
  );
}

/** One resource on a bot card: its name, «used / allocated», and a bar that turns amber past 85%. */
function Meter({ label, value, limit, share }: { label: string; value: string; limit: string; share: number | null }) {
  return (
    <span className="bot-card-meter">
      <span className="bot-card-meter-label">{label}</span>
      <span className={`monitor-bar${share != null && share >= 85 ? " busy" : ""}`} aria-hidden>
        {share != null && <span style={{ width: `${Math.min(100, Math.max(0, share))}%` }} />}
      </span>
      <span className="bot-card-meter-value">
        {value} <span className="faint">/ {limit}</span>
      </span>
    </span>
  );
}
