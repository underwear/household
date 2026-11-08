import { z } from "zod";

const counter = z.number().finite().nonnegative();
const disk = z.object({ total: counter, used: counter, available: counter });
/** A guest service: whether it answers now; null in an image without it. */
const health = z.enum(["up", "down"]).nullable();
export const metricSnapshot = z.object({
  boot: z.string().uuid(),
  cpus: z.array(z.object({ id: z.string().regex(/^cpu\d*$/), total: counter, idle: counter })).min(2).max(257),
  memory: z.object({ total: counter.positive(), available: counter }),
  load: z.array(counter).length(3),
  disks: z.object({ system: disk.nullable(), docker: disk.nullable() }),
  /** Docker and the guest proxy its pulls and builds go out through. */
  services: z.object({ docker: health, proxy: health }),
});
export type MetricSnapshot = z.infer<typeof metricSnapshot>;
export interface MetricSample {
  at: number;
  status: "ok" | "unavailable" | "stopped";
  cpu: number | null;
  cores: { id: string; usage: number | null }[];
  memory: { total: number; available: number; used: number } | null;
  load: number[] | null;
  disks: MetricSnapshot["disks"] | null;
  /** Absent from samples taken before it was measured. */
  services?: MetricSnapshot["services"] | null;
}
export interface MetricsView { from: number; to: number; interval: number; samples: MetricSample[] }

/** Linux guest time is already included in user/nice; do not count it twice. */
export function metricSample(at: number, current: MetricSnapshot, previous?: MetricSnapshot): MetricSample {
  const usage = (cpu: MetricSnapshot["cpus"][number]) => {
    const old = previous?.boot === current.boot ? previous.cpus.find(item => item.id === cpu.id) : undefined;
    if (!old) return null;
    const total = cpu.total - old.total, idle = cpu.idle - old.idle;
    // iowait can decrease; invalid deltas and VM resets are gaps, never negative CPU.
    if (total <= 0 || idle < 0 || idle > total) return null;
    return Math.round((total - idle) / total * 10_000) / 100;
  };
  const available = Math.min(current.memory.total, current.memory.available);
  return { at, status: "ok", cpu: usage(current.cpus.find(cpu => cpu.id === "cpu")!),
    cores: current.cpus.filter(cpu => cpu.id !== "cpu").map(cpu => ({ id: cpu.id, usage: usage(cpu) })),
    memory: { total: current.memory.total, available, used: current.memory.total - available }, load: current.load, disks: current.disks, services: current.services };
}
export function metricGap(at: number, status: "unavailable" | "stopped"): MetricSample {
  return { at, status, cpu: null, cores: [], memory: null, load: null, disks: null, services: null };
}
