import { z } from "zod";
import { block, carriesHouseholdTag, CONTENT_TAG, HEADER_TAG, TASK_TAG, tagFreeJson } from "./tags";

/**
 * A task's limits. Its body reaches the pet's session as one prompt, typed into the agent's terminal together
 * with Household's own blocks (the clock, the memory core): kept short enough to arrive whole and be read.
 */
export const CRON_NAME_MAX = 100;
export const CRON_BODY_MAX = 4000;
const noTags = (value: string) => !carriesHouseholdTag(value);
const NO_TAGS = "must not contain Household's tags";
export const cronFields = z.strictObject({
  name: z.string().trim().min(1).max(CRON_NAME_MAX).refine(noTags, NO_TAGS),
  body: z.string().trim().min(1).max(CRON_BODY_MAX).refine(noTags, NO_TAGS),
  at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/,
      "Local datetime in the Household timezone",
    )
    .optional(),
  cron: z.string().trim().max(120).optional(),
});
export type CronFields = z.infer<typeof cronFields>;
export interface CronJob extends Omit<CronFields, "at" | "cron"> {
  at: string;
  cron: string | null;
  localAt: string | null;
  id: string;
  house: string;
  pet: string;
  revision: number;
  state: "scheduled" | "fired" | "deleted";
  created: string;
  updated: string;
}
export interface CronRun {
  id: number;
  job: string;
  name: string;
  body: string;
  scheduled: string;
  queued: string;
  message: number;
  status: "received" | "dispatching" | "delivered" | "answered" | "failed";
  started: string | null;
  delivered: string | null;
  finished: string | null;
  result: string | null;
  error: string | null;
}
export interface CronEvent {
  id: number;
  job: string;
  at: string;
  kind: string;
  detail: string;
}
export interface CronView {
  timezone: string;
  jobs: CronJob[];
  runs: CronRun[];
  events: CronEvent[];
}
export class CronError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface TaskPrompt { id: string; name: string; body: string; scheduled: string; timezone: string; repeat: string | null; now: number }
/**
 * A firing task as the pet gets it: a \`household-task\` block, its header (what fires, when it was due, in UTC and
 * in Household's time, whether it repeats) and its body in \`household-content\`, like a message. A body over the
 * limit (a task saved before there was one) is cut, saying where the rest is; one carrying our tags (saved
 * before they were refused) is withheld whole, since no defusing catches every disguise the guard does.
 */
/** The first `max` characters, never ending in half an emoji (a lone high surrogate). */
const cut = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");

export function taskPrompt({ id, name, body, scheduled, timezone, repeat, now }: TaskPrompt): string {
  const local = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(Date.parse(scheduled));
  const late = now - Date.parse(scheduled) > 120_000;
  const text = carriesHouseholdTag(body)
    ? "[withheld: this task's body carries Household's tags; read it with cron_get and rewrite it without them with cron_update]"
    : body.length > CRON_BODY_MAX
      ? `${cut(body, CRON_BODY_MAX)}\n[cut: ${body.length - CRON_BODY_MAX} more characters; read the whole task with cron_get and shorten it with cron_update]`
      : body;
  const title = carriesHouseholdTag(name) ? "[withheld: the name carries Household's tags]" : cut(name, CRON_NAME_MAX);
  const header = { event: { kind: "scheduled" }, task: { id, name: title, scheduled, local, repeat, ...(late ? { late: true } : {}) } };
  return block(TASK_TAG, [block(HEADER_TAG, [tagFreeJson(header)]), block(CONTENT_TAG, [text])], { id });
}
