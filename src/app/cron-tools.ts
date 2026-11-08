import type { McpTool } from "../infra/mcp-server";
import type { PetIdentity } from "../infra/agent-api";
import type { Crons } from "./crons";

export function cronTools(crons: Crons): McpTool<PetIdentity>[] {
  const fields = {
    name: {
      type: "string",
      description: "Short task title, at most 200 characters",
    },
    at: {
      type: "string",
      description:
        "Future local datetime in the Household timezone, e.g. 2026-11-06T09:00. Read the timezone from cron_list or the session clock.",
    },
    cron: {
      type: "string",
      description:
        "Repeating five-field cron, e.g. 0 9 * * 1-5. Use instead of at; minimum granularity one minute.",
    },
    body: {
      type: "string",
      description:
        "Instructions to your future self, in prose, at most 32000 characters. Sent to your current session when due; no shell commands are executed by the scheduler.",
    },
  };
  const id = {
    type: "string",
    description: "Task id returned by cron_create or cron_list",
  };
  const revision = {
    type: "integer",
    description: "Current revision from cron_get/list; stale edits are refused",
  };
  return [
    {
      name: "cron_list",
      description:
        "List your own Household scheduled tasks, recent runs and audit history. One Household timezone applies to all tasks; listed timestamps are UTC instants. A received run is queued, delivered means submitted, answered means the turn ended (not a guarantee the task succeeded), failed means delivery/session interrupted. No other pet's tasks are accessible.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async call({ house, pet }) {
        const view = crons.list(house, pet);
        return JSON.stringify({
          timezone: view.timezone,
          jobs: view.jobs.map(({ body, ...job }) => job),
          runs: view.runs
            .slice(0, 20)
            .map(({ body, result, error, ...run }) => ({
              ...run,
              error: error?.slice(0, 500),
            })),
          events: view.events.slice(0, 30).map(({ detail, ...event }) => event),
        });
      },
    },
    {
      name: "cron_get",
      description: "Read one of your Household scheduled tasks.",
      inputSchema: {
        type: "object",
        properties: { id },
        required: ["id"],
        additionalProperties: false,
      },
      async call({ house, pet }, args) {
        return JSON.stringify(crons.get(house, pet, String(args.id)));
      },
    },
    {
      name: "cron_create",
      description:
        "Schedule a one-time or repeating message to your own session, persisted by Household across restarts. The clock runs on the host: overdue tasks run once when it returns. No Telegram post or progress message is created. Write body as prose for your future self. Use these tools instead of native cron/loop or shell timers. Use either at, or cron. Missed occurrences coalesce into one catch-up; occurrences while a previous run is unfinished are skipped.",
      inputSchema: {
        type: "object",
        properties: fields,
        required: ["name", "body"],
        additionalProperties: false,
      },
      async call({ house, pet }, args) {
        return JSON.stringify(crons.create(house, pet, args));
      },
    },
    {
      name: "cron_update",
      description:
        "Replace all fields (name, body and either at or cron) of your pending task. One-time tasks already dispatched cannot be edited.",
      inputSchema: {
        type: "object",
        properties: { id, revision, ...fields },
        required: ["id", "revision", "name", "body"],
        additionalProperties: false,
      },
      async call({ house, pet }, { id, revision, ...fields }) {
        return JSON.stringify(
          crons.update(house, pet, String(id), revision as number, fields),
        );
      },
    },
    {
      name: "cron_delete",
      description:
        "Cancel your pending task. Audit history is retained. Already dispatched runs cannot be recalled; cancelling a repeating task stops future runs.",
      inputSchema: {
        type: "object",
        properties: { id, revision },
        required: ["id", "revision"],
        additionalProperties: false,
      },
      async call({ house, pet }, { id, revision }) {
        return JSON.stringify(
          crons.delete(house, pet, String(id), revision as number),
        );
      },
    },
  ];
}
