# Sideworkers

A sideworker is a second harness your bot starts for a job: a full session of a coding agent such as Claude Code or Codex, in a VM of its own, working in another project. It is not a hidden sub-agent somewhere inside your bot. You see everything it does, and you can talk to it yourself.

## What makes it different

- **Its own project.** It starts in the folder the job is about and reads that project's own `AGENTS.md` or `CLAUDE.md`, skills and conventions, as if you had opened the agent there yourself.
- **Another model, if you like.** You talk to your bot on one model; it can start a worker on another, or on another harness: a cheaper one for a long refactor, a different one for a second opinion.
- **In plain sight.** Each worker gets its own topic or thread in your messenger. Watch it work as it goes, and write to it directly: it answers you, and your bot is told.
- **Your bot stays free.** It briefs the worker, keeps talking to you meanwhile, and reviews what the worker brings back.

## How a job goes

Say you ask your bot: "The site's tests fail since the framework upgrade. Get a sideworker on it, and don't touch the snapshot files."

1. **Brief.** The bot commits its work and starts a worker in the project with a written brief (what fails, what it ruled out, your rule, what done looks like), since the worker doesn't know your conversation.
2. **Branch.** In a git repository the worker gets its own checkout on its own branch, so the two never edit the same files. The bot can instead share its live folder; then both edit the same files.
3. **Review.** The worker reports in its thread; the bot reviews its branch and merges it.
4. **Close.** The bot closes the worker: its VM goes, its branch and files stay. On Telegram its thread goes too, so the bot tells you first if anything there is worth keeping.

## What you decide

- **On or off.** On by default; switch them under **Workspace → Settings → Features**.
- **Which models they may use.** A worker runs on its bot's harness, key and model unless the bot picks a profile you added under **Workspace → Sideworkers → Profiles**, such as `code-review` on another model. The profile's key decides whose allowance or bill the job spends.

## Good to know

- A worker has its bot's home, memory, shared folders, and the workspace's hosts and secrets. It cannot start sideworkers, call [scouts](../scouts/) or have scheduled tasks: those stay with the bot that answers to you.
- Each worker holds its full VM size from the workspace's [resources](../resources/) until closed.
- When a worker shares the bot's live folder, never let both bind-mount one directory into containers: two databases on one data directory corrupt it.
- `house export` refuses to run while a sideworker is open. See [Back up and move](../backup/).
