# Scheduled tasks

A scheduled task is a set of instructions your bot gets at a set time, once or on repeat. "Every weekday at 9:00, summarise my unread mail and send it to me here." The bot does the work in its own session when the time comes. Household keeps the schedule, so it survives restarts, new VMs and a switch of harness.

## What you'd use it for

- **Digests**: unread mail at 9:00, the week's releases on Friday.
- **Reminders**: "On Friday at 17:00, remind me to send the invoice."
- **One-off checks later**: "Tomorrow at 8:00, check if the flight is delayed."
- **Routine upkeep**: a monthly review of the bot's notes, a nightly pull of the repositories it works on.

## How it works

- **Each bot has its own tasks.** Sideworkers and scouts have none; a sideworker asks the bot that started it.
- **At its time, the bot gets the instructions** and works on them in its session. Nothing is posted to your chat by itself: the bot writes to you only if the instructions say so.
- **The bot may not remember setting it up.** By then it may be in a fresh session, so the instructions must stand alone. Facts it should rely on belong in the instructions or in its [memory](../instructions/#memory).
- **Household's schedule, not the VM's.** Bots are told to use it rather than a crontab or a sleeping process inside the VM, which would not survive a new VM.
- **One time zone** for all workspaces and bots: **Household → Settings → Time zone**, or `house timezone Europe/Madrid`. Bots get the current time and zone with every message, so "tomorrow at 9" means 9:00 there. [Scheduled restarts](../bots/) use it too.

## What you decide

### Schedule, inbox or restart?

- **Something at a time** (a digest, a reminder, a weekly review) → a scheduled task.
- **Something when it happens** (new mail, a site down, an alert) → an [inbox](../inboxes/). Household checks the source itself and wakes the bot only when there is an event. A task every 5 minutes asking "is the site up?" spends a model turn each time; a health check inbox spends none until the site fails.
- **A clean context** for a long-lived bot → its scheduled restart on the **Lifecycle** tab (see [Bots](../bots/)), not a task.

The two combine: an inbox on **Silent** collects events without waking the bot, and a task asks it to summarise them once a day.

### Write it so it lands

Say what to do, where the facts are, and whom to tell: "Summarise the mail received since yesterday 9:00, newest first, five lines at most, and send it to me here." A task that does not say "send it to me" may run and stay silent.

## Set it up

The easiest way is to ask in the chat:

> Remind me every Monday at 10:00 to water the plants.

> In two hours, check whether the build passed and tell me.

The bot creates the task and confirms; ask it the same way to list, change or cancel tasks. To add one yourself: the bot's **Scheduled tasks** tab → **+ New task**. A repeating task takes a cron expression; the tab shows it in words below the field.

From the terminal: `house bot tasks <workspace> <bot>` lists them; `house bot tasks add <workspace> <bot> --name <name> --at 2026-12-01T09:00` (or `--cron "<expression>"`) adds one, with the instructions from `--text` or typed in; `house bot tasks set|rm` changes or removes one.

### Cron in brief

Five fields: minute, hour, day of the month, month, day of the week (0 is Sunday). `*` means "any".

| Schedule | Means |
| --- | --- |
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `30 7 * * *` | Every day at 07:30 |
| `0 10 * * 0,6` | Weekends at 10:00 |
| `0 9 1 * *` | Monthly on day 1 at 09:00 |
| `*/30 * * * *` | Every 30 minutes |

Not sure? Describe it to the bot in words and let it write the expression.

## Limits and good to know

- **Failed runs are not retried.** A repeating task waits for its next time; a one-time task does not run again.
- **Missed runs happen once, late.** If Household was not running at the time, the task runs once when it is back, not once per missed time.
- **No pile-ups.** A repeating run is skipped while the previous one is still unfinished.
- **Cancelling** a repeating task stops future runs; one in progress finishes.
- **Every run is a model turn** on the bot's [key](../keys/): a task every few minutes costs allowance or money.
- Instructions: up to 32,000 characters. **Recent runs** on the tab show what the bot said for each run.

## Put it to use

A mail triage bot: give it your mailbox as an [inbox](../inboxes/) on **Silent** and the Email [connector](../connectors/) with **Ask me first** for sending. Add a task on weekdays at 9:00: "Go through the mail since yesterday 9:00, draft replies to anything that needs one, and send me a list here." It reads all night without waking anyone, and nothing leaves your mailbox until you approve it.

## Related

[Inboxes](../inboxes/) · [Instructions, skills and memory](../instructions/) · [Bots](../bots/)
