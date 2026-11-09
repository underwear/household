import { useEffect, useId, useState } from "react";
import { CalendarClock, Repeat } from "lucide-react";
import { api, type CronJob, type CronView } from "../api";
import { Dialog, useDialog } from "./dialog";
import { Link } from "./link";
import { Field, TextField } from "./fields";
import { Cell, List, ListRow, Section } from "./layout";

export type Run = CronView["runs"][number];

/** `at` as the value of a datetime-local field in `timezone`. */
const localInput = (at: string, timezone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

/** «Thu 6 Nov, 09:00» in `timezone`. */
export function whenIn(at: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/** «in 3 h», «in 2 days», «5 min ago». */
export function relative(at: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(at) - now) / 60_000);
  const size = Math.abs(minutes);
  const amount = size < 60 ? `${size} min` : size < 48 * 60 ? `${Math.round(size / 60)} h` : `${Math.round(size / 1440)} days`;
  if (size === 0) return "now";
  return minutes > 0 ? `in ${amount}` : `${amount} ago`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n: string) => n.padStart(2, "0");

/** A cron expression in words when it is a common one («Weekdays at 09:00»); null when it is not. */
export function cronInWords(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/;
  if (every.test(minute) && hour === "*" && day === "*" && month === "*" && weekday === "*") return `Every ${minute.match(every)![1]} minutes`;
  if (/^\d+$/.test(minute) && hour === "*" && day === "*" && month === "*" && weekday === "*") return `Every hour at :${two(minute)}`;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*") return null;
  const time = `${two(hour)}:${two(minute)}`;
  if (day === "*" && weekday === "*") return `Every day at ${time}`;
  if (day === "*" && weekday === "1-5") return `Weekdays at ${time}`;
  if (day === "*" && (weekday === "0,6" || weekday === "6,0")) return `Weekends at ${time}`;
  if (day === "*" && /^[0-7]$/.test(weekday)) return `Every ${DAYS[Number(weekday) % 7]} at ${time}`;
  if (/^\d+$/.test(day) && weekday === "*") return `Monthly on day ${day} at ${time}`;
  return null;
}

/** A run's state as people read it, and its tone (the design's state colours). */
export const RUN_STATES: Record<Run["status"], { label: string; tone: string }> = {
  received: { label: "Queued", tone: "busy" },
  dispatching: { label: "Sending", tone: "busy" },
  delivered: { label: "Running", tone: "busy" },
  answered: { label: "Replied", tone: "idle" },
  failed: { label: "Failed", tone: "danger" },
};

/** A bot's scheduler state, polled every 5 s while its page is open (its Tasks tab and the tab's count share it). */
export function useBotCrons(house: string, pet: string, enabled = true) {
  const [view, setView] = useState<CronView>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const refresh = async () => {
    try {
      setView(await api.crons(house, pet));
      setError("");
      setNow(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const poll = async () => {
      try {
        const value = await api.crons(house, pet);
        if (alive) {
          setView(value);
          setError("");
          setNow(Date.now());
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [house, pet, enabled]);
  return { view, error, now, refresh };
}

/** How many tasks are scheduled. */
export const scheduledCount = (view: CronView | undefined) => view?.jobs.filter((job) => job.state === "scheduled").length ?? 0;

/**
 * A bot's scheduled tasks: what is due and when (times in the Household time zone), each to edit or cancel; then
 * its recent runs, each opening to its timings, instructions and result; and the audit log, folded.
 */
export function BotCrons({ house, pet, crons: { view, error, now, refresh } }: { house: string; pet: string; crons: ReturnType<typeof useBotCrons> }) {
  const [editing, setEditing] = useState<CronJob | "new">();
  const dialog = useDialog();
  const timezone = view?.timezone ?? "UTC";
  const cancel = (job: CronJob) =>
    dialog.open({
      title: `Cancel “${job.name}”?`,
      body: job.cron ? "No more runs. One in progress finishes." : "It won’t run.",
      confirmLabel: "Cancel task",
      cancelLabel: "Keep it",
      danger: true,
      onConfirm: async () => {
        await api.deleteCron(house, pet, job.id, job.revision);
        await refresh();
      },
    });

  const jobs = (view?.jobs ?? []).filter((job) => job.state === "scheduled").sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <>
      <Section
        title="Scheduled tasks"
        hint={
          <>
            Instructions the bot gets on schedule, in its own session (not posted to any channel). Times in <span className="mono">{timezone}</span>.{" "}
            <Link href="/settings" className="text-link">Change time zone</Link>
          </>
        }
        actions={
          <button className="btn small" disabled={!view} onClick={() => setEditing("new")}>
            + New task
          </button>
        }
      >
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <List columns="minmax(0, 1fr) auto" empty={view ? "Nothing scheduled." : "Loading…"}>
          {jobs.map((job) => {
            const words = job.cron ? cronInWords(job.cron) : null;
            const due = Date.parse(job.at) <= now;
            const Icon = job.cron ? Repeat : CalendarClock;
            return (
              <ListRow
                key={job.id}
                actions={
                  <>
                    <button className="text-btn plain" onClick={() => setEditing(job)}>
                      Edit
                    </button>
                    <button className="text-btn" onClick={() => cancel(job)}>
                      Cancel
                    </button>
                  </>
                }
              >
                <Cell>
                  <span className="avatar task" aria-hidden>
                    <Icon size={15} strokeWidth={1.75} />
                  </span>
                  <span className="cell-lines">
                    <span className="strong ellipsis">{job.name}</span>
                    <span className="task-when">
                      {job.cron && (words ? <span>{words}</span> : <code>{job.cron}</code>)}
                      {job.cron && <span className="faint"> · next </span>}
                      <span>{whenIn(job.at, timezone)}</span>
                      {due ? <span className="tag busy">due</span> : <span className="faint"> · {relative(job.at, now)}</span>}
                    </span>
                    <span className="task-body ellipsis">{job.body}</span>
                  </span>
                </Cell>
              </ListRow>
            );
          })}
        </List>
      </Section>

      {view && view.runs.length > 0 && (
        <Section title="Recent runs" hint="Failed runs are not retried.">
          <div className="runs">
            {view.runs.map((run) => {
              const state = RUN_STATES[run.status];
              return (
                <details key={run.id} className="run">
                  <summary>
                    <span className={`dot ${state.tone}`} />
                    <span className="strong ellipsis">{run.name}</span>
                    <span className="run-state">{state.label}</span>
                    <span className="run-time">{whenIn(run.queued, timezone)}</span>
                  </summary>
                  <div className="run-detail">
                    <dl className="run-times">
                      {(
                        [
                          ["Scheduled", run.scheduled],
                          ["Queued", run.queued],
                          ["Delivered", run.delivered],
                          ["Started", run.started],
                          ["Finished", run.finished],
                        ] as const
                      ).map(([label, at]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd className={at ? undefined : "faint"}>{at ? whenIn(at, timezone) : "—"}</dd>
                        </div>
                      ))}
                    </dl>
                    {run.error && <p className="error">{run.error}</p>}
                    <span className="run-label">Instructions</span>
                    <pre className="run-text">{run.body}</pre>
                    {run.result && (
                      <>
                        <span className="run-label">What the bot said</span>
                        <pre className="run-text">{run.result}</pre>
                      </>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
          {view.events.length > 0 && (
            <details className="audit">
              <summary>Audit log · {view.events.length} recent events</summary>
              <ul>
                {view.events.map((event) => (
                  <li key={event.id}>
                    <span className="audit-time">{whenIn(event.at, timezone)}</span>
                    <span className="audit-kind">{event.kind}</span>
                    <span className="audit-job">{view.jobs.find((job) => job.id === event.job)?.name ?? event.job}</span>
                    {event.detail && <span className="audit-detail">{event.detail}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Section>
      )}
      {editing && <TaskDialog house={house} pet={pet} job={editing === "new" ? undefined : editing} timezone={timezone} onClose={() => setEditing(undefined)} saved={refresh} />}
      {dialog.element}
    </>
  );
}

/** A task's form: its name, when (once, at a local time; or repeating, by a cron expression, read back in words), what to do. */
function TaskDialog({ house, pet, job, timezone, onClose, saved }: { house: string; pet: string; job?: CronJob; timezone: string; onClose: () => void; saved: () => Promise<void> }) {
  const [name, setName] = useState(job?.name ?? "");
  const [body, setBody] = useState(job?.body ?? "");
  const [repeating, setRepeating] = useState(!!job?.cron);
  const [cron, setCron] = useState(job?.cron ?? "0 9 * * 1-5");
  const [at, setAt] = useState(job?.localAt?.slice(0, 16) ?? localInput(job?.at ?? new Date(Date.now() + 3600_000).toISOString(), timezone));
  const atId = useId();
  const bodyId = useId();
  const words = cronInWords(cron);
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: job ? `Edit “${job.name}”` : "New task",
        confirmLabel: job ? "Save task" : "Schedule task",
        onConfirm: async () => {
          const fields = { name: name.trim(), body: body.trim(), ...(repeating ? { cron: cron.trim() } : { at }) };
          if (!fields.name) throw new Error("Name the task.");
          if (!fields.body) throw new Error("Say what the bot should do.");
          if (job) await api.updateCron(house, pet, job.id, job.revision, fields);
          else await api.createCron(house, pet, fields);
          await saved();
        },
        children: (
          <>
            <TextField label="Name" value={name} onChange={setName} maxLength={200} placeholder="Morning digest" />
            <div className="field">
              <span className="field-label">When</span>
              <div className="segmented wide" role="group" aria-label="When">
                <button type="button" aria-pressed={!repeating} onClick={() => setRepeating(false)}>
                  <CalendarClock size={14} strokeWidth={1.75} aria-hidden /> Once
                </button>
                <button type="button" aria-pressed={repeating} onClick={() => setRepeating(true)}>
                  <Repeat size={14} strokeWidth={1.75} aria-hidden /> Repeating
                </button>
              </div>
            </div>
            {repeating ? (
              <TextField
                label="Schedule"
                mono
                value={cron}
                onChange={setCron}
                placeholder="0 9 * * 1-5"
                hint={
                  <>
                    {words ? <strong className="cron-words">{words}</strong> : <span>Minute · hour · day of month · month · day of week.</span>} A missed run happens once, late; one is skipped while the last still runs.
                  </>
                }
              />
            ) : (
              <Field id={atId} label="Date and time" hint={`${timezone}`}>
                <input id={atId} type="datetime-local" className="control" value={at} onChange={(event) => setAt(event.target.value)} required />
              </Field>
            )}
            <Field id={bodyId} label="Instructions" hint="Sent to the bot as your message.">
              <textarea id={bodyId} className="control task-instructions" rows={6} maxLength={32000} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Summarise yesterday’s merged PRs and post the digest to the team thread." />
            </Field>
          </>
        ),
      }}
    />
  );
}
