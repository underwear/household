import type { AgentEvent } from "../core/agent-events";
import { CronExpressionParser, CronDate } from "cron-parser";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  CronError,
  cronFields,
  type CronJob,
  type CronView,
} from "../core/cron";
import type { Message } from "../core/message";

/** Uses the daemon's SQLite connection: firing and its durable inbox entry are one transaction. */
export class CronStore {
  private timezone: string;
  constructor(private readonly db: Database) {
    this.timezone =
      db
        .query<{ value: string }, [string]>(
          "SELECT value FROM state WHERE key=?",
        )
        .get("cron.timezone")?.value ?? "UTC";
  }
  setTimezone(timezone: string, now: number): void {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    if (timezone === this.timezone) return;
    this.db.transaction(() => {
      const jobs = this.db
        .query<CronJob, []>("SELECT * FROM cron_jobs WHERE state='scheduled'")
        .all();
      for (const job of jobs) {
        const at = job.cron
          ? this.next(job.cron, timezone, now)
          : new CronDate(job.localAt!, timezone).toISOString()!;
        this.db.run(
          "UPDATE cron_jobs SET at=?,revision=revision+1,updated=? WHERE id=?",
          [at, new Date(now).toISOString(), job.id],
        );
        this.audit(
          job.id,
          "timezone",
          `Household timezone changed to ${timezone}; next due ${at}`,
          now,
        );
      }
      this.db.run(
        "INSERT OR REPLACE INTO state(key,value) VALUES ('cron.timezone',?)",
        [timezone],
      );
    })();
    this.timezone = timezone;
  }
  view(house: string, pet: string): CronView {
    return {
      timezone: this.timezone,
      jobs: this.db
        .query<CronJob, [string, string]>(
          "SELECT * FROM cron_jobs WHERE house=? AND pet=? ORDER BY (state='scheduled') DESC,created DESC LIMIT 500",
        )
        .all(house, pet),
      runs: this.db
        .query<CronView["runs"][number], [string, string]>(
          "SELECT r.* FROM cron_runs r JOIN cron_jobs j ON j.id=r.job WHERE j.house=? AND j.pet=? ORDER BY r.id DESC LIMIT 200",
        )
        .all(house, pet),
      events: this.db
        .query<CronView["events"][number], [string, string]>(
          "SELECT e.* FROM cron_events e JOIN cron_jobs j ON j.id=e.job WHERE j.house=? AND j.pet=? ORDER BY e.id DESC LIMIT 300",
        )
        .all(house, pet),
    };
  }
  get(house: string, pet: string, id: string): CronJob {
    const job = this.db
      .query<CronJob, [string, string, string]>(
        "SELECT * FROM cron_jobs WHERE house=? AND pet=? AND id=?",
      )
      .get(house, pet, id);
    if (!job) throw new CronError("Scheduled task not found", 404);
    return job;
  }
  private fields(
    input: unknown,
    now: number,
  ): Pick<CronJob, "name" | "body" | "at" | "cron" | "localAt"> {
    const parsed = cronFields.safeParse(input);
    if (!parsed.success)
      throw new CronError(
        "Expected name (1–200 chars), body (1–32000 chars), and either a local datetime in at or a cron expression",
      );
    const { name, body, at, cron } = parsed.data;
    if (cron !== undefined) {
      if (at !== undefined) throw new CronError("Use either at or cron");
      return {
        name,
        body,
        at: this.next(cron, this.timezone, now),
        cron,
        localAt: null,
      };
    }
    if (!at) throw new CronError("Use either at or cron");
    let date: number;
    try {
      date = new CronDate(at, this.timezone).getTime();
    } catch {
      throw new CronError("Invalid local date");
    }
    if (!Number.isFinite(date) || date <= now)
      throw new CronError("at must be in the future");
    return {
      name,
      body,
      at: new Date(date).toISOString(),
      cron: null,
      localAt: at,
    };
  }
  private next(cron: string, timezone: string, now: number): string {
    if (cron.includes("H") || cron.trim().split(/\s+/).length !== 5)
      throw new CronError(
        "cron must have five fields: minute hour day-of-month month day-of-week",
      );
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
      return CronExpressionParser.parse(cron, {
        tz: timezone,
        currentDate: now,
      })
        .next()
        .toISOString()!;
    } catch {
      throw new CronError(
        "Invalid cron schedule or IANA timezone (e.g. Europe/Madrid)",
      );
    }
  }

  private audit(id: string, kind: string, detail: string, now: number) {
    this.db.run(
      "INSERT INTO cron_events (job, at, kind, detail) VALUES (?,?,?,?)",
      [id, new Date(now).toISOString(), kind, detail],
    );
  }
  create(house: string, pet: string, input: unknown, now: number): CronJob {
    const fields = this.fields(input, now);
    return this.db.transaction(() => {
      const count = this.db
        .query<{ n: number }, [string, string]>(
          "SELECT count(*) AS n FROM cron_jobs WHERE house=? AND pet=? AND state='scheduled'",
        )
        .get(house, pet)!.n;
      if (count >= 100)
        throw new CronError("At most 100 pending tasks per bot", 409);
      const id = randomUUID();
      const date = new Date(now).toISOString();
      this.db.run(
        "INSERT INTO cron_jobs (id,house,pet,name,body,at,cron,localAt,revision,state,created,updated) VALUES (?,?,?,?,?,?,?,?,1,'scheduled',?,?)",
        [
          id,
          house,
          pet,
          fields.name,
          fields.body,
          fields.at,
          fields.cron,
          fields.localAt,
          date,
          date,
        ],
      );
      this.audit(id, "created", JSON.stringify(fields), now);
      return this.get(house, pet, id);
    })();
  }
  update(
    house: string,
    pet: string,
    id: string,
    revision: number,
    input: unknown,
    now: number,
  ): CronJob {
    const fields = this.fields(input, now);
    return this.db.transaction(() => {
      this.editable(house, pet, id, revision);
      this.db.run(
        "UPDATE cron_jobs SET name=?,body=?,at=?,cron=?,localAt=?,revision=revision+1,updated=? WHERE id=?",
        [
          fields.name,
          fields.body,
          fields.at,
          fields.cron,
          fields.localAt,
          new Date(now).toISOString(),
          id,
        ],
      );
      this.audit(id, "updated", JSON.stringify(fields), now);
      return this.get(house, pet, id);
    })();
  }
  private editable(house: string, pet: string, id: string, revision: number) {
    const job = this.get(house, pet, id);
    if (job.state !== "scheduled")
      throw new CronError(
        "Task has already fired or been deleted; create a new task",
        409,
      );
    if (!Number.isInteger(revision) || revision !== job.revision)
      throw new CronError("Task changed; read it again before editing", 409);
  }
  delete(
    house: string,
    pet: string,
    id: string,
    revision: number,
    now: number,
  ) {
    return this.db.transaction(() => {
      this.editable(house, pet, id, revision);
      this.db.run(
        "UPDATE cron_jobs SET state='deleted',revision=revision+1,updated=? WHERE id=?",
        [new Date(now).toISOString(), id],
      );
      this.audit(
        id,
        "deleted",
        "Future dispatch cancelled; in-flight runs are unaffected; history retained",
        now,
      );
      return this.get(house, pet, id);
    })();
  }
  event(ids: number[], event: AgentEvent): void {
    for (const id of ids) {
      if (event.kind === "prompt-accepted") {
        this.db.run(
          "UPDATE cron_runs SET started=COALESCE(started,strftime('%Y-%m-%dT%H:%M:%fZ')) WHERE message=?",
          [id],
        );
        this.db.run(
          "INSERT INTO cron_events (job,at,kind,detail) SELECT job,strftime('%Y-%m-%dT%H:%M:%fZ'),'started','Agent accepted message ' || message FROM cron_runs WHERE message=?",
          [id],
        );
      } else if (event.kind === "turn-finished") {
        this.db.run("UPDATE cron_runs SET result=? WHERE message=?", [
          event.text.slice(0, 32_000),
          id,
        ]);
      } else if (event.kind === "turn-failed") {
        this.db.run("UPDATE cron_runs SET error=? WHERE message=?", [
          event.error.slice(0, 4000),
          id,
        ]);
      }
    }
  }
  due(now: number): CronJob[] {
    return this.db
      .query<CronJob, [string]>(
        "SELECT * FROM cron_jobs WHERE state='scheduled' AND at<=? ORDER BY at,id",
      )
      .all(new Date(now).toISOString());
  }
  fire(job: CronJob, now: number): Message | undefined {
    return this.db.transaction(() => {
      const current = this.get(job.house, job.pet, job.id);
      if (
        current.state !== "scheduled" ||
        current.revision !== job.revision ||
        Date.parse(current.at) > now
      )
        return;
      const date = new Date(now).toISOString();
      const next = current.cron
        ? this.next(current.cron, this.timezone, now)
        : undefined;
      // Keep at most one unfinished run of a recurring task. Missed occurrences are coalesced.
      const active = this.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM cron_runs WHERE job=? AND status IN ('received','dispatching','delivered')",
        )
        .get(job.id)!.n;
      if (next && active) {
        this.db.run(
          "UPDATE cron_jobs SET at=?,revision=revision+1,updated=? WHERE id=?",
          [next, date, job.id],
        );
        this.audit(
          job.id,
          "skipped",
          "Previous run still queued or delivered; next due " + next,
          now,
        );
        return;
      }
      // The body is the pet's own prose, not a command executed by the scheduler.
      const text = `Household scheduled task: ${current.name}\nScheduled for: ${current.at}\nThis is an internal task, not a message from Telegram. Do not send a chat acknowledgement; use reply only if the task calls for notifying your human.\n\n${current.body}`;
      const row = this.db
        .query<{ id: number }, [string, string, string]>(
          "INSERT INTO messages (house,pet,text,status,origin) VALUES (?,?,?,'received','cron') RETURNING id",
        )
        .get(job.house, job.pet, text)!;
      this.db.run(
        "INSERT INTO cron_runs (job,name,body,scheduled,queued,message,status) VALUES (?,?,?,?,?,?,'received')",
        [job.id, current.name, current.body, current.at, date, row.id],
      );
      this.db.run(
        "UPDATE cron_jobs SET state=?,at=?,revision=revision+1,updated=? WHERE id=?",
        [next ? "scheduled" : "fired", next ?? current.at, date, job.id],
      );
      this.audit(
        job.id,
        "queued",
        `Message ${row.id}; scheduled for ${current.at}`,
        now,
      );
      return {
        id: row.id,
        text,
        status: "received",
        origin: "cron",
      } satisfies Message;
    })();
  }
}
