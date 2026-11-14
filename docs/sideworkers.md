# Sideworkers

A sideworker is extra hands a bot starts for one job. It runs in a VM of its own, works on the bot's files and has its own chat thread, so the bot stays free to talk to you. Ask your coding bot to "get a sideworker to fix the failing tests in the site project": a worker fixes them on its own branch, and the bot merges the branch and closes the worker.

## When it helps

- **Work in another project.** Started in a folder with its own `CLAUDE.md` or `AGENTS.md`, it works as that project's developer, without the bot's long conversation in the way.
- **A long or parallel job.** A refactor, a test run, an investigation, while the bot keeps answering you.
- **A clean start.** Work that should not carry everything the bot has talked about.
- **Another model.** A second opinion, or a job another model does better.
- **Someone you can talk to.** Unlike a subagent hidden inside a session, a sideworker has a thread where you watch it and tell it what you want.

## How it works

- **The bot starts it.** You ask the bot, or it decides on its own. It gives the worker a folder in its home, a written brief (the worker does not know the conversation) and a CPU and memory size from what the workspace has free.
- **In a git repository, it gets its own branch.** By default the worker has a separate checkout on a branch of its own, from the bot's last commit, so the two never edit the same files and their builds never meet. What the bot has not committed is not in it. The bot can instead share its live folder; then both edit the same files.
- **It works with the bot's things:** its home, memory and shared folders, and the workspace's allowed hosts and secrets (as placeholders). It has its own session and its own Docker.
- **It has a thread** in the bot's channel. What you write there goes to the worker, and the bot is told. The worker reports to the bot.
- **It answers to its bot.** It cannot start sideworkers, call scouts, have scheduled tasks or ask for new shared folders: those stay with the bot that answers to you.
- **The bot closes it.** Its VM is removed; its branch and files stay. On Telegram its thread is deleted with its messages, so the bot tells you first if anything there is worth keeping. There is no time limit; an idle worker reminds its bot every 30 minutes.

## What you decide

**Sideworker, scout, or another bot?**

- **A sideworker** does the bot's own work in parallel, with the bot's files and access, for one job.
- **A [scout](../scouts/)** does what the bot should not: untrusted sites, a production key, a closed network. It sees nothing of the bot.
- **Another [bot](../bots/)** fits a standing job with its own instructions, memory and schedule.

**On or off.** Sideworkers are on in a new workspace; switch them under **Workspace → Settings → Features**. Off pauses the running ones and stops new ones.

**Which models they may use.** A worker runs on its bot's harness, key and model unless the bot picks a profile you added under **Workspace → Sideworkers → Profiles**: a harness, key, model, effort and permission mode under a name like `code-review`. Add one for a second opinion from another model, or for a project whose instruction file only another harness reads (Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`). Its key decides whose allowance or bill the job spends. A running worker keeps the settings it started with.

## A worked example

Your bot *Dev* keeps your site's repository at `~/projects/site`. You write:

> The site's tests fail since the framework upgrade. Get a sideworker on it, and don't touch the snapshot files.

1. Dev commits its work, then starts `sw-fix-tests` in `~/projects/site` with 2 vCPU and 2 GiB and a brief: the failing suite, what it ruled out, your rule, what done looks like.
2. The worker gets a checkout at `.worktrees/sw-fix-tests` on the branch `sideworker/sw-fix-tests` and reads the project's own instructions.
3. Its thread opens in Dev's channel. You add: "the date tests fail only in CI, use UTC". The worker gets it, and Dev is told.
4. Meanwhile Dev answers your other questions.
5. The worker reports a green branch. Dev reviews and merges it, and closes the worker.

## Put it to use

**Weekly dependency updates.** Give Dev a [scheduled task](../schedules/): "Every Monday at 8:00, start a sideworker on the `code-review` profile to update the site's dependencies and run the tests." The result waits in its thread, the branch for Dev to merge.

## Good to know

- **Workspace → Sideworkers** lists the running ones; you can close one there.
- Each worker holds its full VM size from the workspace's budget until closed. There is no count limit, only the total. See [Resources](../resources/).
- When a worker shares the bot's live folder, never let both bind-mount one directory into containers: two databases on one data directory corrupt it.
- `house export` refuses to run while a sideworker is open. See [Back up and move](../backup/).
- From the terminal: `house features <workspace> sideworkers=on|off`.

## Related

- [Bots](../bots/): bots, sideworkers and scouts compared.
- [Scouts](../scouts/): for access the bot should not hold.
- [Resources](../resources/): the budget workers draw from.
