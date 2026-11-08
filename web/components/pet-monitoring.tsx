import { useEffect, useState } from "react";
import { ChevronRight, Cpu, HardDrive, MemoryStick, type LucideIcon } from "lucide-react";
import type { MetricSample, MetricsView } from "../../src/core/metrics";
import { api } from "../api";
import { Section } from "./layout";

type Range = "1h" | "24h" | "7d";
const RANGES: { value: Range; label: string; since: string }[] = [
  { value: "1h", label: "1 hour", since: "1 h ago" },
  { value: "24h", label: "24 hours", since: "24 h ago" },
  { value: "7d", label: "7 days", since: "7 days ago" },
];

/** «1.24 GiB»; «—» for no measurement. */
export const bytes = (value: number | null | undefined) => {
  if (value == null) return "—";
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : 1;
  return `${(value / 1024 ** power).toFixed(power === 3 ? 2 : 0)} ${["B", "KiB", "MiB", "GiB"][power]}`;
};
const percent = (value: number | null | undefined) => (value == null ? "—" : `${value.toFixed(value < 10 ? 1 : 0)}%`);
const share = (used: number | undefined, total: number | undefined) => (used == null || !total ? null : (used / total) * 100);

const DISKS = [
  ["system", "Disk"],
  ["docker", "Docker disk"],
] as const;

/** The guest services Household keeps running in the VM; one that is down comes back by itself. */
const SERVICES = [
  ["docker", "Docker"],
  ["proxy", "Docker's network proxy"],
] as const;

/**
 * A pet's VM, sampled every minute (seven days kept): what it uses now, a compact tile each (CPU, memory, its disks)
 * with how it went over the chosen range; each core on demand. No agent turns are spent on it.
 */
export function PetUsage({ house, pet }: { house: string; pet: string }) {
  const [range, setRange] = useState<Range>("1h");
  const [cores, setCores] = useState(false);
  const [view, setView] = useState<MetricsView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    setView(undefined);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api.metrics(house, pet, range);
        if (!cancelled) {
          setView(result);
          setError(undefined);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [house, pet, range]);
  const latest = view?.samples.at(-1);
  const stale = !!latest && Date.now() - latest.at > 120_000;
  const current = stale || error ? undefined : latest;
  const state = !view
    ? { tone: "off", text: error ? "Not loaded" : "Loading…" }
    : !latest
      ? { tone: "off", text: "Waiting for the first sample" }
      : latest.status === "stopped"
        ? { tone: "off", text: "VM not running" }
        : stale || latest.status !== "ok"
          ? { tone: "busy", text: `No fresh sample · last at ${new Date(latest.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` }
          : { tone: "idle", text: `Live · updated ${new Date(latest.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` };
  const since = RANGES.find(({ value }) => value === range)!.since;
  return (
    <Section
      title="Usage"
      hint="Sampled every minute, kept for 7 days."
      actions={
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map(({ value, label }) => (
            <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>
              {label}
            </button>
          ))}
        </div>
      }
    >
      <span className="pet-state monitor-state">
        <span className={`dot ${state.tone}`} />
        {state.text}
      </span>
      {SERVICES.map(([service, title]) => {
        const health = current?.services?.[service];
        if (!health) return null; // an image without it, or no fresh sample
        return (
          <span key={service} className="pet-state monitor-state">
            <span className={`dot ${health === "up" ? "idle" : "danger"}`} />
            {health === "up" ? `${title} is up` : `${title} is down: Household restarts it (log: /var/log/household-docker.log in the VM)`}
          </span>
        );
      })}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="monitor-grid">
        <MetricChart
          title="CPU"
          icon={Cpu}
          value={percent(current?.cpu)}
          detail={current?.cores.length ? `${current.cores.length} vCPUs · load ${current.load?.map((value) => value.toFixed(2)).join(" / ") ?? "—"}` : "Needs two samples after boot"}
          view={view}
          read={(sample) => sample.cpu}
          maximum={100}
          unit="%"
          since={since}
        />
        <MetricChart
          title="Memory"
          icon={MemoryStick}
          value={bytes(current?.memory?.used)}
          detail={current?.memory ? `of ${bytes(current.memory.total)} · ${bytes(current.memory.available)} free` : "—"}
          view={view}
          read={(sample) => share(sample.memory?.used, sample.memory?.total)}
          maximum={100}
          unit="%"
          since={since}
        />
        {DISKS.map(([disk, title]) => {
          const now = current?.disks?.[disk];
          if (current && !now) return null; // a disk this VM does not have
          return (
            <MetricChart
              key={disk}
              title={title}
              icon={HardDrive}
              value={bytes(now?.used)}
              detail={now ? `of ${bytes(now.total)} · ${bytes(now.available)} free` : "—"}
              view={view}
              read={(sample) => share(sample.disks?.[disk]?.used, sample.disks?.[disk]?.total)}
              maximum={100}
              unit="%"
              since={since}
            />
          );
        })}
      </div>
      {current && current.cores.length > 0 && (
        <button type="button" className="text-btn plain monitor-toggle" aria-expanded={cores} onClick={() => setCores(!cores)}>
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
          Per core, now
        </button>
      )}
      {cores && current && current.cores.length > 0 && (
        <div className="monitor-cores">
          {current.cores.map((core) => (
            <div className="monitor-core" key={core.id}>
              <span className="mono">{core.id}</span>
              <span className="monitor-bar" aria-hidden>
                <span style={{ width: `${Math.min(100, core.usage ?? 0)}%` }} />
              </span>
              <span className="monitor-core-value">{core.usage === null ? "…" : percent(core.usage)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="hint">Memory excludes reclaimable cache. Disks exclude the pet's home, which lives on the host.</p>
    </Section>
  );
}

/**
 * A metric's tile: its name, its value now, a line on it, and its history as an area over a fixed time axis. At most
 * 180 points (each the peak of its stretch), a gap where there was no measurement.
 */
export function MetricChart({ title, icon: Icon, value, detail, view, read, maximum, unit, since = "" }: { title: string; icon?: LucideIcon; value: string; detail: string; view?: MetricsView; read: (sample: MetricSample) => number | null; maximum?: number; unit: string; since?: string }) {
  const buckets = view ? Math.min(180, Math.ceil((view.to - view.from) / view.interval)) : 180;
  const points = view ? Array.from({ length: buckets }, () => [] as number[]) : [];
  const gaps = new Set<number>();
  let previousAt: number | undefined;
  if (view)
    for (const sample of view.samples) {
      const bucket = Math.min(buckets - 1, Math.max(0, Math.floor(((sample.at - view.from) / (view.to - view.from)) * buckets)));
      if (previousAt !== undefined && sample.at - previousAt > view.interval * 1.5) {
        const first = Math.max(0, Math.floor(((previousAt - view.from) / (view.to - view.from)) * buckets));
        for (let missing = first; missing <= bucket; missing++) gaps.add(missing);
      }
      previousAt = sample.at;
      const v = read(sample);
      if (v === null) gaps.add(bucket);
      else points[bucket]!.push(v);
    }
  const values = points.map((bucket, i) => (gaps.has(i) || !bucket.length ? null : Math.max(...bucket)));
  const top = maximum ?? Math.max(0.1, ...values.filter((v): v is number => v !== null)) * 1.1;
  const x = (i: number) => (buckets > 1 ? (i / (buckets - 1)) * 600 : 300);
  const y = (v: number) => 58 - (Math.min(v, top) / top) * 54;
  // Runs of measured points: each a line and the area under it; a lone point a dot.
  const runs: { i: number; v: number }[][] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const last = runs.at(-1);
    if (last && last.at(-1)!.i === i - 1) last.push({ i, v });
    else runs.push([{ i, v }]);
  });
  return (
    <div className="monitor-card">
      <span className="monitor-label">
        {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden />}
        {title}
      </span>
      <strong className="monitor-value">{value}</strong>
      <span className="monitor-detail">{detail}</span>
      <svg viewBox="0 0 600 60" preserveAspectRatio="none" role="img" aria-label={`${title} history`} className="monitor-chart">
        <line x1="0" x2="600" y1="58" y2="58" className="monitor-base" />
        {runs.map((run, index) =>
          run.length === 1 ? (
            <circle key={index} cx={x(run[0]!.i)} cy={y(run[0]!.v)} r="2" className="monitor-dot" />
          ) : (
            <g key={index}>
              <path d={`M${x(run[0]!.i)},58 ${run.map((p) => `L${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} L${x(run.at(-1)!.i)},58Z`} className="monitor-area" />
              <path d={run.map((p, n) => `${n ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} className="monitor-line" />
            </g>
          ),
        )}
      </svg>
      <span className="monitor-axis">
        <span>{since}</span>
        <span>
          {maximum === 100 && unit === "%" ? "0–100%" : `0–${top.toFixed(1)} ${unit}`}
        </span>
        <span>now</span>
      </span>
    </div>
  );
}
