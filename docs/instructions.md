# Instructions, skills and memory

Three things make a bot yours rather than a blank assistant. A cooking bot's instructions say "plan meals for two, mostly vegetarian"; a skill lays out the weekly shopping list your way; memory knows Anna is allergic to nuts.

## What goes where

- **Always true** (who it is, your rules) → instructions.
- **How to do a recurring kind of task** → a skill.
- **Rules every bot should follow** → a shared skill, since instructions are per bot.
- **Facts and decisions** it should recall → memory.
- **Something to do later or on repeat** → a [scheduled task](../schedules/).
- **Software it needs installed** → its **Setup** script (see [Bots](../bots/)).

Usually you just say it: "add to your instructions…", "make this a skill", "remember that…". Review or edit the result on the bot's page and under **Workspace → Shared Skills**. Keep passwords out of all three: they are plain text. Give the bot a [secret](../network/) instead.

### Instructions

One Markdown document per bot, read at the start of every session. Each harness reads it under its own name (`CLAUDE.md`, `AGENTS.md`), so it survives a harness switch. A change applies from the next session; a project's own instruction file applies too while the bot works there.

### Skills

A skill is a folder with a `SKILL.md` (a name, a line on when to use it, the instructions) and any files it needs. The bot opens one only when a task fits that line, so make it specific: "Review a diff for bugs before merging", not "Code review". A bot has its own skills, the workspace's shared ones, and read-only built-in `household-…` skills that teach it how to work in Household. [Scouts](../scouts/) don't get the bot's own.

### Memory

Notes Household keeps for the bot outside its VM, so they [survive](../bots/#what-survives-what) restarts, new VMs and harness switches. One note, `core`, comes with every session; the bot looks up the rest when relevant. Memory is private to the bot and its [sideworkers](../sideworkers/), and it is notes, not orders: when one disagrees with what you say now, your words win.

## When the bot edits itself

The bot can change its instructions, skills, shared skills, memory and environment scripts without asking. What limits it:

- **None of it grants access.** Hosts, secrets, folders, connectors and scout runs are Household settings the bot can only ask for, and only an owner approves. Environment scripts run inside its own VM, not on your machine.
- **Your rules are kept by request, not by lock.** The bot is told its additions can't override your instructions, but one talked into it by hostile content could still rewrite them.
- ⚠️ **A shared skill reaches every bot.** A bad edit by one bot shows up in all the workspace's bots from their next session.
- **Only memory keeps versions.** Check instructions and skills now and then, and keep your own copy of instructions you care about.
