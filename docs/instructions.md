# Instructions, skills and memory

Three things make a bot yours rather than a blank assistant. Its **instructions** say who it is and how it works. **Skills** are how-tos it opens when a task calls for one. **Memory** is what it has learned about you and your projects. A cooking bot's instructions say "plan meals for two, mostly vegetarian"; a skill lays out the weekly shopping list your way; memory knows Anna is allergic to nuts.

## What you'd use it for

- **Give a bot a role and rules**: "You are my cooking assistant. Ask before buying anything."
- **Teach a procedure once**: how you deploy, how to file an expense, how to write the weekly report.
- **Make every bot of a workspace work the same way** with a shared skill.
- **Let it remember** people, decisions and preferences across sessions.

## How it works

### Instructions

One Markdown document per bot, on its **AGENTS.md** tab, read at the start of every session. Each harness reads the same file under its own name, such as `CLAUDE.md` for Claude Code or `AGENTS.md` for Codex, so the instructions survive a switch of harness. A change applies from the next session; restart the bot to apply it now. A project's own instruction file applies too, while the bot works there.

### Skills

A skill is a folder with a `SKILL.md` (a name, a line on when to use it, the instructions) and any files it needs. The bot sees every skill's name and line and opens one only when a task fits, so long procedures don't crowd every conversation. Skills come from three places:

- **Its own**, on the bot's **Skills** tab. Only this bot has them, whatever its harness.
- **Shared**, on **Workspace → Shared Skills**. Every bot of the workspace has them; a change there changes it for all.
- **Built-in**, named `household-…`. They teach a bot how to work in Household: schedule tasks, keep memory, set up its VM, ask for hosts, secrets and folders, call scouts, start sideworkers. They are read-only and update with Household.

[Scouts](../scouts/) don't get a bot's own skills. Each gets the skills of its capabilities, with the shared and built-in ones.

### Memory

Notes Household keeps for the bot outside its VM, so they survive restarts, new VMs and a switch of harness. Each has a key, with dots for grouping (`people.anna`). One note, `core`, sums up what matters most: the bot gets it at the start of every session and looks up the rest when relevant. Memory is private to the bot and its [sideworkers](../sideworkers/). It is notes, not orders: when one disagrees with what you say now, your words win. In a group chat the bot keeps private notes to itself unless you allow otherwise.

### When the bot edits itself

The bot can change its own instructions, its own skills, the shared skills, its memory and its [environment scripts](../bots/), without asking you. What limits it:

- **None of it grants access.** Hosts, secrets, folders, connectors and scout runs are Household settings the bot can only ask for, and only an owner approves. Environment scripts run inside its own VM, not on your machine.
- **Your rules are kept by request, not by lock.** The bot is told to keep your instructions and that its own additions can't override them. A bot talked into it by hostile content could still rewrite them.
- ⚠️ **A shared skill reaches every bot.** A bad edit by one bot shows up in all the workspace's bots from their next session.
- **Only memory keeps versions**, with who wrote each (you or the bot). Instructions and skills keep no history. Look at what changed now and then, and keep your own copy of instructions you care about.

## What goes where

- **Always true** (who it is, your rules) → instructions.
- **How to do a recurring kind of task** → a skill: its own, or shared for the whole workspace.
- **Rules every bot should follow** → a shared skill, since instructions are per bot.
- **Facts and decisions** it should recall → memory.
- **Something to do later or on repeat** → a [scheduled task](../schedules/).
- **Software it needs installed** → its **Setup** script on the **Environment** tab (see [Bots](../bots/)).

## Set it up

Usually you just say it: "add to your instructions…", "make this a skill", "remember that…". Review what the bot wrote on the same tabs. To write them yourself: the **AGENTS.md**, **Skills** and **Memory** tabs, and **Shared Skills**. For a skill, the line under **When to use it** decides when the bot opens it, so make it specific: "Review a diff for bugs before merging", not "Code review".

From the terminal: `house bot instructions [set] <workspace> <bot>`, `house skills <workspace>` and `house skills cat|put|rm <workspace> <path>`, `house bot memory <workspace> <bot>` and `house bot memory get|set|rm <workspace> <bot> <key>`.

## Limits and good to know

- Instructions: up to 32 KiB. A memory note: up to 32,000 characters.
- Bots see a new skill from their next session.
- Avoid two skills of one name at two levels: the list tags such a skill **also shared**, and it confuses the bot.
- Keep passwords and tokens out of all three: they are stored as plain text and read into the bot's conversation. Give the bot a [secret](../network/) instead.

## Put it to use

A morning brief that stays the same in every session: write a skill `morning-brief` ("When to use it: the 9:00 scheduled brief") that says which mails count, how to group them and to keep it under ten lines. Then add a [scheduled task](../schedules/) on weekdays at 9:00 that just says "Run your morning brief and send it to me here". Changing the brief is now an edit to one skill, not to the schedule.

## Related

[Bots](../bots/) · [Scheduled tasks](../schedules/) · [Sideworkers](../sideworkers/)
