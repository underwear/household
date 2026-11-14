# Scheduled tasks

A scheduled task is a message your bot gets from you at a set time, once or on repeat. "Every weekday at 9:00, summarise my unread mail." "On Friday at 17:00, remind me to send the invoice." "Tomorrow at 8:00, check if the flight is delayed." The bot does the work in its own session when the time comes, and tells you what you asked it to. Household keeps the schedule, so it survives restarts and new sessions.

## Ask the bot

The simplest way is to say it in the chat:

> Remind me every Monday at 10:00 to water the plants.

> In two hours, check whether the build passed and tell me.

The bot creates the task itself and confirms. Ask it what it has scheduled, or to change or cancel a task, the same way. Every task it makes shows up on its **Scheduled tasks** tab, where you can edit or cancel it.

Each bot has its own tasks. Sideworkers and scouts have none; a sideworker asks the bot that started it.

## Add one yourself

1. Open the bot's page and its **Scheduled tasks** tab. Press **+ New task**.
2. **Name** it, for example "Morning digest".
3. Under **When**, choose **Once** or **Repeating**:
   - **Once**: pick the **Date and time**.
   - **Repeating**: write a **Schedule** as a cron expression (see below). Below the field you see it in words, like "Weekdays at 09:00".
4. Under **Instructions**, write what the bot should do. Say where to report, such as "and send me the result here". The bot gets this as a message from you. By then it may be in a new session that doesn't remember today's conversation, so give it everything it needs to know.
5. Press **Schedule task**.

The tab lists what is due, soonest first, with **Edit** and **Cancel** on each. Cancelling a repeating task stops future runs; a run already in progress finishes. The bot's **Overview** shows the next task and how the last one went.

From a terminal: `house bot tasks <workspace> <bot>` lists them, and `house bot tasks add <workspace> <bot> --name <name> --at 2026-12-01T09:00` (or `--cron "<expression>"`) adds one, with the instructions from `--text` or typed in.

## Repeating schedules

A repeating schedule is a cron expression: five fields for minute, hour, day of the month, month and day of the week. `*` means "any". Common ones:

| Schedule | Means |
| --- | --- |
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `30 7 * * *` | Every day at 07:30 |
| `0 10 * * 0,6` | Weekends at 10:00 |
| `0 18 * * 5` | Every Friday at 18:00 |
| `0 9 1 * *` | Monthly on day 1 at 09:00 |
| `15 * * * *` | Every hour at :15 |
| `*/30 * * * *` | Every 30 minutes |

Days of the week count from 0 (Sunday) to 6 (Saturday). Not sure? Describe it to the bot in words and let it write the expression.

## Time zone

All times are in the Household time zone, one for all workspaces and bots. Set it under **Household → Settings → Time zone** (the **Household** card in the sidebar, then **Settings**), or with `house timezone Europe/Madrid`. The **Scheduled tasks** tab names the zone it uses and links to the setting.

Bots get the current time and zone with every message, so "tomorrow at 9" in the chat means 9:00 in that zone. [Scheduled restarts](../bots/) on the **Lifecycle** tab use it too.

## When a task runs

At its time, Household sends the instructions to the bot as a message from you. The bot works on it in its own session. Nothing is posted to your chat by itself: the bot writes to you only if the instructions say so. That is why it pays to end them with whom to tell, and where.

Under **Recent runs** on the tab, each run shows its state: **Queued**, **Sending**, **Running**, **Replied** or **Failed**. Open one to see its timings, the instructions it got and **What the bot said**. The folded **Audit log** below them records what happened to each task.

A few things to know:

- **Failed runs are not retried.** If a run fails, it waits for its next time; a one-time task does not run again.
- **Missed runs happen once, late.** If Household was not running at the time (your computer was off, say), the task runs once when it is back, not once for every missed time.
- **No pile-ups.** A repeating run is skipped while the previous one still runs.
- **Write instructions that stand alone.** The bot may not remember the conversation in which you set the task up. Facts it should rely on belong in the instructions themselves or in its [memory](../instructions/#memory).
