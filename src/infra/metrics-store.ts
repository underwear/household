import { Database } from "bun:sqlite";
import type { MetricSample } from "../core/metrics";

export const METRICS_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Disposable telemetry is kept out of the durable message/memory database and portable backups. */
export class MetricsStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS samples (house TEXT NOT NULL, pet TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(house,pet,at));
      CREATE INDEX IF NOT EXISTS sample_age ON samples(at);`);
  }
  put(house: string, pet: string, sample: MetricSample) {
    this.db.query("INSERT OR REPLACE INTO samples VALUES (?,?,?,?)").run(house, pet, sample.at, JSON.stringify(sample));
  }
  latest(house: string, pet: string): MetricSample | null {
    const row = this.db.query("SELECT payload FROM samples WHERE house=? AND pet=? ORDER BY at DESC LIMIT 1").get(house, pet) as {payload: string} | null;
    return row ? JSON.parse(row.payload) : null;
  }
  prune(now: number) { this.db.query("DELETE FROM samples WHERE at < ?").run(now - METRICS_RETENTION_MS); }
  history(house: string, pet: string, from: number, to: number): MetricSample[] {
    return (this.db.query("SELECT payload FROM samples WHERE house=? AND pet=? AND at>=? AND at<=? ORDER BY at").all(house, pet, from, to) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
  close() { this.db.close(); }
}
