# Sideworkers

A sideworker is extra hands a bot starts for one job: a refactor, a test run, work in another project, or a second opinion from another model. It runs in a VM of its own, works on the bot's files and has its own chat thread, so the bot stays free to talk to you. For a standing job or access the bot should not hold, see [bots, sideworkers and scouts](../bots/) compared.

## How it works

Say you ask your coding bot: "The site's tests fail since the framework upgrade. Get a sideworker on it, and don't touch the snapshot files."

1. **Brief.** The bot commits its work and starts a worker in the project folder with a written brief (the failing suite, what it ruled out, your rule, what done looks like), since the worker does not know the conversation.
2. **Branch.** In a git repository the worker gets its own checkout on its own branch, from the bot's last commit, so the two never edit the same files. What the bot has not committed is not in it. The bot can instead share its live folder; then both edit the same files.
3. **Review.** The worker's thread opens in the bot's channel. What you write there goes to the worker, and the bot is told; meanwhile the bot answers you. The worker reports a green branch; the bot reviews and merges it.
4. **Close.** The bot closes the worker: its VM is removed, its branch and files stay. On Telegram its thread is deleted with its messages, so the bot tells you first if anything there is worth keeping.

The worker has its bot's home, memory, shared folders, and the workspace's hosts and secrets, with its own session and Docker. It cannot start sideworkers, call scouts, have scheduled tasks or ask for new folders: those stay with the bot that answers to you.

## What you decide

- **On or off.** On by default; switch them under **Workspace → Settings → Features**. Off pauses the running ones and stops new ones.
- **Which models they may use.** A worker runs on its bot's harness, key and model unless the bot picks a profile you added under **Workspace → Sideworkers → Profiles**, such as `code-review` on another model. Its key decides whose allowance or bill the job spends.

## Good to know

- Each worker holds its full VM size from the workspace's [resources](../resources/) until closed.
- When a worker shares the bot's live folder, never let both bind-mount one directory into containers: two databases on one data directory corrupt it.
- `house export` refuses to run while a sideworker is open. See [Back up and move](../backup/).
