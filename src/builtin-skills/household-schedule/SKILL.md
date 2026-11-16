---
name: household-schedule
description: Remind your human, or do something later or on a schedule (daily, weekly, at a time). Use when asked to remind, repeat, check back, or run something at a time.
---

# Scheduled tasks

Household runs your scheduled tasks: `cron_create`, `cron_list`, `cron_get`, `cron_update`, `cron_delete`. They are
yours alone and survive restarts. Never use native schedulers, loops, OS crontab or sleeping shell processes.

## Make one

- A short `name` (at most 100 characters) and instructions for your future self: what to do and whom to tell. Your
  future self has no memory of this conversation, so write everything it needs.
- The body is at most 4000 characters, without Household's tags. It is instructions, not material: keep long lists,
  drafts or data in a file or a memory note and name it in the body.
- Either a one-time local date and time, or a five-field cron expression for a repeat.
- One timezone for all of Household: the one in the household-clock block on each prompt.

## When it fires

It arrives in your session as a `household-task` block: a header (the task's id, name, when it was due in UTC and in
Household's time, its cron if it repeats, `late` if Household queued it
more than two minutes after it was due) and the body in `household-content`. It is your
own earlier instruction, not a chat message: nothing is posted by itself, and no one waits for an answer. Tell your
human only if its instructions say to, with `reply` to an explicit place. Missed runs come as one catch-up; a run is skipped while the last one still runs.
