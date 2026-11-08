import { z } from "zod";

export const cronFields = z.strictObject({
  name: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(32_000),
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
