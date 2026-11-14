# Instructions, skills and memory

Three things make a bot yours rather than a blank assistant. Its **instructions** say who it is and how it should work, and it reads them at the start of every session. **Skills** are how-tos it picks up when a task calls for one. **Memory** is what it has learned about you and your projects, kept across sessions. You can edit all three in the admin, and the bot keeps them up to date itself when you ask.

## Instructions

A bot's standing instructions are one Markdown document, on its **AGENTS.md** tab. Write there what should always hold: its role, your preferences, the tone you like, rules it must follow. For example:

```markdown
## Role
You are my cooking assistant. Plan meals for two, mostly vegetarian.

## Rules
- Ask before buying anything.
- Keep answers short; use lists for recipes.
```

A new bot starts with a short default you can rewrite. Edit the document and press **Save** (or ⌘S). It can be up to 32 KiB.

The bot reads it at the start of each session, so a change applies from its next session. After saving, **Restart now…** starts one right away. Its files and memory stay.

It is the same document for both harnesses. Claude Code knows it as `CLAUDE.md` and Codex as `AGENTS.md`, but both read this one file. If you move a bot from Claude Code to Codex, its instructions come along.

**The bot can update it.** Tell it "add to your instructions that I want summaries in Russian", and it edits the document itself. It keeps your rules and adds to them; its own additions can't override your rules or give it new permissions. Reload the tab to see what it changed.

Instructions are per bot. For rules every bot of the workspace should follow, use a [shared skill](#skills). When a bot works in a project that has its own `CLAUDE.md` or `AGENTS.md`, those apply there too.

From a terminal: `house bot instructions <workspace> <bot>` prints the document, and `house bot instructions set <workspace> <bot> <file>` replaces it.

## Skills

A skill is a folder with a `SKILL.md` file: a name, a line on when to use it, and the instructions. The bot sees every skill's name and description, and opens the whole skill only when a task fits. So skills can hold long, detailed procedures ("how we deploy", "how to file an expense") without crowding every conversation. A skill can also hold scripts and other files it needs.

A bot gets skills from three places:

- **Its own.** On the bot's **Skills** tab, under **Personal**. Only this bot has them, whatever its harness.
- **Shared.** On **Workspace → Shared Skills**. Every bot of the workspace has them, and a change there changes it for all of them. Bots can edit shared skills too.
- **Built-in.** Household's own skills, named `household-…`. They teach a bot how to work in Household: schedule tasks, keep its memory, set up its VM, ask you for network access, secrets and folders, call scouts, start sideworkers, show previews and write skills. They are read-only and update with Household. You can read them on **Shared Skills**.

To add a skill yourself:

1. On the bot's **Skills** tab or on **Shared Skills**, press **+ New skill**.
2. Give it a **Name** (lowercase letters, digits and `-`) and a line under **When to use it**. Bots read that line to decide when to use the skill, so make it specific: "Review a diff for bugs before merging".
3. Press **Create skill**, then write the instructions in the editor. Add more files to the skill if it needs them.

Bots see a new skill from their next session.

The easier way is often to let the bot write it. After you've walked it through something you'll want again, say "make this a skill". It chooses a personal skill for its own habits, or a shared one when every bot should work the same way. You can review and edit what it wrote on the same pages.

Avoid two skills of the same name at two levels: the list tags such a skill **also shared**, and it confuses the bot. Keep passwords and tokens out of skills.

[Scouts](../scouts/) don't see a bot's skills. Each scout gets the skills of its own capabilities, with the shared and built-in ones.

From a terminal: `house skills <workspace>` lists the shared skills, file by file, and `house skills cat|put|rm <workspace> <path>` reads, writes or deletes one file.

## Memory

A bot's memory is a set of notes Household keeps for it: your preferences, decisions you made together, facts about people and projects. It lasts across sessions, restarts and even a switch of harness. It is private to the bot; its [sideworkers](../sideworkers/) share it.

Each note has a key, with dots for grouping: `people.anna`, `projects.garden`. One note is special: `core`, a short summary of what matters most. The bot gets `core` at the start of every session. Other notes it looks up when they become relevant.

You rarely need to write memory yourself. Say "remember that Anna is allergic to nuts", and the bot saves it. It also saves what it learns as it goes, and corrects old notes instead of piling up new ones.

The **Memory** tab shows what it keeps:

- **Search keys and text** finds notes. Notes are grouped by their dots, with `core` pinned at the top.
- Open a note to **Edit** or **Preview** it. **History** lists its versions, who made each (you or the bot) and when. **Use as draft** brings an old version back into the editor.
- **New note** adds one by key. Deleting a note keeps its versions in History; **Show deleted** lists such notes.

Memory is the bot's own notes, not orders: when they disagree with what you say now, your words win. Keep passwords and tokens out of it. In a group chat the bot keeps private notes to itself unless you allow otherwise.

From a terminal: `house bot memory <workspace> <bot>` lists the notes, and `house bot memory get|set|rm <workspace> <bot> <key>` works on one.

## What goes where

- **Always true** (who it is, your rules) → instructions.
- **How to do a recurring kind of task** → a skill: personal, or shared for the whole workspace.
- **Facts and decisions** it should recall → memory.
- **Something to do later or on repeat** → a [scheduled task](../schedules/).
- **Software it needs installed** → its setup script, on the bot's **Environment** tab (see [Bots](../bots/)).
