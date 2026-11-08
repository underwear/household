import { useEffect, useId, useState } from "react";
import { api, type PetView } from "../api";
import {
  DEFAULT_LIFECYCLE, DEFAULT_SHUTDOWN_MESSAGE, DEFAULT_WAKE_UP_MESSAGE, describeLifecycle, normalLifecycle, WEEKDAYS,
  type LifecycleEvery, type PetLifecycle, type Weekday,
} from "../../src/core/lifecycle";
import { Field, SelectField, StepperField, SwitchList } from "./fields";
import { Cluster, Section } from "./layout";
import { written } from "./section";

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

interface Form {
  enabled: boolean;
  every: LifecycleEvery;
  at: string;
  weekday: Weekday;
  day: string;
  notice: string;
  shutdown: string;
  wakeUp: string;
}

/** The form for a lifecycle; a pet without one gets the defaults, switched off. */
function formOf(lifecycle: PetLifecycle | null | undefined): Form {
  const value = lifecycle ?? { ...DEFAULT_LIFECYCLE, enabled: false };
  return {
    enabled: value.enabled,
    every: value.every,
    at: value.at,
    weekday: value.weekday ?? "monday",
    day: String(value.day ?? 1),
    notice: String(value.notice),
    shutdown: value.shutdown ?? DEFAULT_SHUTDOWN_MESSAGE,
    wakeUp: value.wakeUp ?? DEFAULT_WAKE_UP_MESSAGE,
  };
}

/** What the form saves, or why it cannot. */
function lifecycleOf(form: Form): PetLifecycle | string {
  const notice = Number(form.notice);
  if (!Number.isInteger(notice) || notice < 1 || notice > 60) return "Notice is 1 to 60 minutes.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.at)) return "Pick a time.";
  if (form.shutdown.trim() === "" || form.wakeUp.trim() === "") return "Messages cannot be empty.";
  return normalLifecycle({
    enabled: form.enabled,
    every: form.every,
    at: form.at,
    weekday: form.weekday,
    day: Number(form.day),
    notice,
    shutdown: form.shutdown,
    wakeUp: form.wakeUp,
  });
}

/** The parts that go into the pet's instructions: a change to them starts it a new session. */
const scheduleOf = (lifecycle: PetLifecycle | null | undefined) =>
  lifecycle?.enabled ? JSON.stringify([lifecycle.every, lifecycle.at, lifecycle.weekday, lifecycle.day, lifecycle.notice]) : "off";

/**
 * A pet's Lifecycle tab: its scheduled restart (how often, when, how much notice), the shutdown message it gets before
 * one and the wake-up message after. Times are the household's timezone.
 */
export function PetLifecycleTab({ house, pet, refresh, notify }: { house: string; pet: PetView; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const [form, setForm] = useState(() => formOf(pet.lifecycle));
  const [timezone, setTimezone] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const timeId = useId();
  const shutdownId = useId();
  const wakeUpId = useId();
  useEffect(() => {
    let active = true;
    api.timezone().then((value) => active && setTimezone(value.timezone), () => {});
    return () => {
      active = false;
    };
  }, []);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const value = lifecycleOf(form);
  const saved = pet.lifecycle ? normalLifecycle(pet.lifecycle) : null;
  const changed = typeof value === "string" || JSON.stringify(value) !== JSON.stringify(saved);
  const restarts = typeof value !== "string" && scheduleOf(value) !== scheduleOf(saved);
  const save = async () => {
    if (typeof value === "string") return setError(value);
    setBusy(true);
    setError(undefined);
    try {
      const warning = await written(api.updatePet(house, pet.name, { lifecycle: value }));
      notify(warning ?? "Lifecycle saved", warning !== undefined);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const summary = typeof value === "string" ? undefined : value.enabled ? `Restarts ${describeLifecycle(value)}${timezone ? ` (${timezone})` : ""}.` : "Never restarted on a schedule.";
  return (
    <form
      className="stack gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void save();
      }}
    >
      <Section width="narrow" title="Scheduled restart" hint="A fresh session on a schedule: a clean context, with a handoff note to carry on from.">
        <div className="stack gap-4">
          <SwitchList
            label="Scheduled restart"
            options={[{ value: "enabled", label: "Restart on a schedule", description: summary }]}
            on={form.enabled ? ["enabled"] : []}
            onToggle={() => set("enabled", !form.enabled)}
          />
          {form.enabled && (
            <>
              <SelectField
                label="Repeat"
                value={form.every}
                onChange={(every) => set("every", every as LifecycleEvery)}
                options={[
                  { value: "daily", label: "Every day" },
                  { value: "weekly", label: "Every week" },
                  { value: "monthly", label: "Every month" },
                ]}
              />
              {form.every === "weekly" && (
                <SelectField label="Day" value={form.weekday} onChange={(weekday) => set("weekday", weekday as Weekday)} options={[...WEEKDAYS.slice(1), WEEKDAYS[0]].map((day) => ({ value: day, label: capital(day) }))} />
              )}
              {form.every === "monthly" && (
                <SelectField label="Day of the month" value={form.day} onChange={(day) => set("day", day)} options={Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} />
              )}
              <Field id={timeId} label="Time" hint={timezone ? `In the household's timezone, ${timezone}.` : "In the household's timezone."}>
                <input id={timeId} type="time" className="control" value={form.at} onChange={(event) => set("at", event.target.value)} required />
              </Field>
              <StepperField
                label="Shutdown notice"
                hint="How long before the restart the shutdown message comes. It restarts as soon as the agent finishes wrapping up, or when the time is up."
                value={form.notice}
                onChange={(notice) => set("notice", notice)}
                step={1}
                min={1}
                max={60}
                unit="min"
              />
            </>
          )}
        </div>
      </Section>
      {form.enabled && (
        <>
          <Section width="narrow" title="Shutdown message" hint="Sent to the agent before a scheduled restart." actions={form.shutdown !== DEFAULT_SHUTDOWN_MESSAGE && <button type="button" className="btn small" onClick={() => set("shutdown", DEFAULT_SHUTDOWN_MESSAGE)}>Reset to default</button>}>
            <label htmlFor={shutdownId} className="visually-hidden">Shutdown message</label>
            <textarea id={shutdownId} className="control task-instructions" rows={5} maxLength={4000} value={form.shutdown} onChange={(event) => set("shutdown", event.target.value)} />
          </Section>
          <Section width="narrow" title="Wake-up message" hint="Sent to the agent once it is back after a scheduled restart." actions={form.wakeUp !== DEFAULT_WAKE_UP_MESSAGE && <button type="button" className="btn small" onClick={() => set("wakeUp", DEFAULT_WAKE_UP_MESSAGE)}>Reset to default</button>}>
            <label htmlFor={wakeUpId} className="visually-hidden">Wake-up message</label>
            <textarea id={wakeUpId} className="control task-instructions" rows={5} maxLength={4000} value={form.wakeUp} onChange={(event) => set("wakeUp", event.target.value)} />
          </Section>
        </>
      )}
      <Section width="narrow">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Cluster gap={4} justify="end">
          <span className={restarts ? "hint busy grow" : "hint grow"} role="status">
            {restarts ? `Saving restarts ${pet.title}'s session now: its instructions mention the schedule.` : form.enabled ? "Messages apply from the next scheduled restart." : ""}
          </span>
          <button type="submit" className="btn primary" disabled={busy || !changed}>
            {busy ? "Saving…" : "Save"}
          </button>
        </Cluster>
      </Section>
    </form>
  );
}
