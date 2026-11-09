---
name: household-skills
description: Write or change a skill for yourself (personal), every bot of the workspace (shared), or a project. Use when you want to keep a reusable way of doing something as a skill.
---

# Skills

Three levels, from narrowest to widest:

- **Personal**: only you. `~/work/.agents/skills`, whatever your harness: Household links every harness's project
  skills directory there (`~/work/.claude/skills` is a link to it), so they stay yours if your harness changes. Your
  human edits them on your Skills tab. A sideworker has none: its working directory's skills are the project's.
- **Shared**: every bot in your workspace. Your harness's user skills directory, linked to `/opt/household/skills`; your
  human edits them under Shared Skills. A change there changes every bot's.
- **Built-in**: `household-*`, Household's own, read-only for everyone, updated with Household. Names starting
  with `household-` are reserved: do not create, copy or shadow them.

A skill only one project needs belongs in that project's repository (`.claude/skills`, `.agents/skills`), where
it goes with the code. Prefer personal for your own habits and shared for what every bot of the workspace should do the
same way. Two skills of one name at two levels confuse: rename one.

## Write one

- A folder named after the skill with a `SKILL.md`: frontmatter `name` and `description`, then the instructions.
  Supporting files go in the same folder.
- The description decides when a harness loads it: say what it does and when to use it, in one or two sentences.
- No credentials in skills. Do not replace the shared skills link.
- A new skill may need a new session before your harness sees it.
