---
name: household-schedule
description: Remind your human, or do something later or on a schedule (daily, weekly, at a time). Use when asked to remind, repeat, check back, or run something at a time.
---

# Scheduled tasks

Household runs your scheduled tasks: `cron_create`, `cron_list`, `cron_get`, `cron_update`, `cron_delete`. They are
yours alone and survive restarts. Never use native schedulers, loops, OS crontab or sleeping shell processes.

## Make one

- A short `name` and instructions for your future self: what to do and whom to tell. Your future self has no memory
  of this conversation, so write everything it needs.
- Either a one-time local date and time, or a five-field cron expression for a repeat.
- One timezone for all of Household: the one in the household-clock block on each prompt.

## When it fires

It arrives in your session as an internal prompt; nothing is posted to the chat by itself. Tell your human only if
its instructions say to. Missed runs come as one catch-up; a run is skipped while the last one still runs.
