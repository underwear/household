# Scheduled tasks

A scheduled task is a set of instructions your bot gets at a set time, once or on repeat. Household keeps the schedule, not the VM, so it survives restarts, new VMs and a switch of harness. Each bot has its own tasks; a sideworker asks its bot.

## Write it so it lands

At its time the bot may be in a fresh session with no memory of setting the task up, and nothing reaches your chat unless the instructions say so. Say what to do, where the facts are, and whom to tell:

> Every weekday at 9:00, summarise the mail received since yesterday 9:00, newest first, five lines at most, and send it to me here.

Ask in the chat like that; the bot creates the task and confirms, and you list, change or cancel tasks the same way. They also sit on its **Scheduled tasks** tab, with each run's reply.

<details>
<summary>Cron in brief</summary>

A repeating task you add yourself takes a cron expression: minute, hour, day of the month, month, day of the week (0 is Sunday). `0 9 * * 1-5` is weekdays at 09:00; `*/30 * * * *` is every 30 minutes. Not sure? Describe it to the bot in words.

</details>

## Schedule, inbox or restart?

- **Something at a time** (a digest, a reminder) → a scheduled task.
- **Something when it happens** (new mail, a site down) → an [inbox](../inboxes/). A task every 5 minutes asking "is the site up?" spends a model turn each time; a health check inbox spends none until the site fails.
- **A clean context** → the bot's scheduled restart (see [Bots](../bots/)).

The two combine: an inbox on **Silent** collects events without waking the bot, and a task asks it to summarise them once a day.

## Good to know

- **One time zone** for the whole Household, under **Household → Settings → Time zone**. Bots get it with every message, so "tomorrow at 9" means 9:00 there.
- **Missed runs happen once, late.** If Household was down at the time, the task runs once when it is back.
- **Failed runs are not retried.** A repeating task waits for its next time.
- **No pile-ups.** A repeating run is skipped while the previous one is unfinished.
- **Every run is a model turn** on the bot's [key](../keys/).
