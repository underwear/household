import { z } from "zod";

/**
 * A pet's lifecycle: Household restarts its VM (and so its agent's session) on a schedule, in the household's
 * timezone. `notice` minutes before, the agent gets the shutdown message and a grace period to wrap up; the restart
 * comes when it finishes that turn or the grace period ends. After the restart it gets the wake-up message. A message
 * left out is the default one.
 */
export const LIFECYCLE_EVERY = ["daily", "weekly", "monthly"] as const;
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type LifecycleEvery = (typeof LIFECYCLE_EVERY)[number];
export type Weekday = (typeof WEEKDAYS)[number];

export const DEFAULT_WAKE_UP_MESSAGE =
  "Hi! Household has just restarted your session on schedule. If ~/work/HANDOFF.md exists, read it first: it is the note you wrote yourself before the restart. If anything in it is unfinished, carry on with it.";
export const DEFAULT_SHUTDOWN_MESSAGE =
  "Household will restart your session in a few minutes, on schedule. Wrap up: finish or pause what you are doing, then write a handoff for your next session to ~/work/HANDOFF.md (update it if it already exists): what you were doing, what is unfinished and what to do next. Do not start new work.";

export const lifecycleSchema = z.strictObject({
  enabled: z.boolean(),
  every: z.enum(LIFECYCLE_EVERY),
  /** "HH:MM", 24-hour, in the household's timezone. */
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a time HH:MM"),
  /** Weekly: which day (Monday when absent). */
  weekday: z.enum(WEEKDAYS).optional(),
  /** Monthly: which day of the month (1 when absent; up to 28, so every month has it). */
  day: z.number().int().min(1).max(28).optional(),
  /** Minutes between the shutdown message and the restart, at most. */
  notice: z.number().int().min(1).max(60),
  wakeUp: z.string().trim().min(1).max(4000).optional(),
  shutdown: z.string().trim().min(1).max(4000).optional(),
});
export type PetLifecycle = z.infer<typeof lifecycleSchema>;

/** What a new pet gets: a restart every night at 04:00, five minutes' notice, the default messages. */
export const DEFAULT_LIFECYCLE: PetLifecycle = { enabled: true, every: "daily", at: "04:00", notice: 5 };

/** The schedule as a five-field cron expression (minute hour day month weekday). */
export function lifecycleCron(lifecycle: PetLifecycle): string {
  const [hour, minute] = lifecycle.at.split(":").map(Number) as [number, number];
  if (lifecycle.every === "weekly") return `${minute} ${hour} * * ${WEEKDAYS.indexOf(lifecycle.weekday ?? "monday")}`;
  if (lifecycle.every === "monthly") return `${minute} ${hour} ${lifecycle.day ?? 1} * *`;
  return `${minute} ${hour} * * *`;
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "every day at 04:00", "every Monday at 04:00", "on the 1st of every month at 04:00". */
export function describeLifecycle(lifecycle: PetLifecycle): string {
  if (lifecycle.every === "weekly") return `every ${capital(lifecycle.weekday ?? "monday")} at ${lifecycle.at}`;
  if (lifecycle.every === "monthly") return `on the ${ordinal(lifecycle.day ?? 1)} of every month at ${lifecycle.at}`;
  return `every day at ${lifecycle.at}`;
}

export const wakeUpMessage = (lifecycle: PetLifecycle) => lifecycle.wakeUp ?? DEFAULT_WAKE_UP_MESSAGE;
export const shutdownMessage = (lifecycle: PetLifecycle) => lifecycle.shutdown ?? DEFAULT_SHUTDOWN_MESSAGE;

/** The lifecycle as written: a message equal to the default is left out, and so is a day the schedule does not use. */
export function normalLifecycle(lifecycle: PetLifecycle): PetLifecycle {
  const { wakeUp, shutdown, weekday, day, ...rest } = lifecycle;
  return {
    ...rest,
    ...(rest.every === "weekly" ? { weekday: weekday ?? "monday" } : {}),
    ...(rest.every === "monthly" ? { day: day ?? 1 } : {}),
    ...(wakeUp !== undefined && wakeUp.trim() !== DEFAULT_WAKE_UP_MESSAGE ? { wakeUp: wakeUp.trim() } : {}),
    ...(shutdown !== undefined && shutdown.trim() !== DEFAULT_SHUTDOWN_MESSAGE ? { shutdown: shutdown.trim() } : {}),
  };
}
