# Sideworkers

A sideworker is a helper a bot starts for one job. It runs in a VM of its own, works on the bot's files and has its own chat thread, so the bot stays free to talk to you while the job gets done. When the job is finished, the bot closes it. For how a sideworker differs from a bot and a scout, see [Bots](../bots/).

## When it helps

- **Work in another project.** Point it at a folder with its own `CLAUDE.md` or `AGENTS.md`, and it works as that project's developer: its conventions, commands and rules, without the bot's long conversation in the way.
- **A long or parallel job.** A refactor, a test run, an investigation, while the bot keeps answering you.
- **A clean start.** Work that should not carry everything the bot has talked about.
- **Another model.** Run the job on a different harness or model, say Codex next to a Claude Code bot. See the profiles below.
- **Someone you can talk to.** Unlike a subagent hidden inside a session, a sideworker has its own thread. Open it, watch it work and tell it what you want directly.

## Turn them on or off

Sideworkers are on in a new workspace. To change that, open **Workspace → Settings** and use the **Sideworkers** switch under **Features**, then **Save**. Turning them off pauses the ones that run and stops bots from starting new ones.

From the command line:

```sh
house features home sideworkers=off
```

You don't start sideworkers yourself. You ask your bot ("get a sideworker to fix the tests in the site project"), or it decides to start one on its own.

## What happens when a bot starts one

1. **The bot gives it a folder and a brief.** The folder is one in the bot's home. The bot also picks the CPU and memory for the worker's VM, from what the workspace has free.
2. **In a git repository, it gets its own branch.** The worker works in a separate copy of the repository on a branch of its own, starting from the bot's last commit. The two never edit the same files. Changes the bot has not committed are not in the worker's copy. When the job is done, the bot merges the branch.
3. **A thread opens in the bot's channel.** The worker posts there. Whatever you write in that thread goes to the worker, and the bot is told.
4. **The bot closes it** when the job is done. You can close it too (below).

A sideworker sees the bot's home and the bot's memory. Like the bot, it reaches only the hosts the workspace allows and uses the workspace's secrets without seeing their values. It has its own session and its own Docker.

A sideworker cannot start sideworkers, call scouts, have scheduled tasks or ask for shared folders. It sees the folders its bot has.

## Watch and close them

**Workspace → Sideworkers** lists what runs now under **Running**: each worker with its state, the bot it was **Started by**, and its **Working directory** and branch. The bot's **Overview** also shows how many sideworkers it has.

Click a worker to open its page: its working directory, branch and **Logs**, and **Close…** under **Close sideworker**. The list has a **Close…** for each worker too.

When a sideworker is closed:

- its VM is removed;
- its branch and the files it wrote stay;
- on Telegram, its thread is deleted with all its messages. The bot is asked to tell you first, so you can keep what you need.

A sideworker has no time limit. When one sits idle for 30 minutes, its bot is reminded, and again every 30 minutes after that, so it can close the worker or give it more to do.

## Run a sideworker on another model

By default a sideworker runs on its bot's own harness, key and model. To let bots use something else, add a profile in **Workspace → Sideworkers → Profiles → + Add profile**:

- **Profile name** — what a bot asks for, like `code-review`.
- **Harness**, **Key**, **Model**, **Reasoning effort** and **Permission mode** — the same choices as for a bot.

Bots see the profiles you added and may pick one when they start a worker. You can also ask for one by name: "start a sideworker on the code-review profile". A worker keeps the settings it started with: editing or removing a profile does not change the ones already running.

## Resources

Each running sideworker holds its VM's CPU and memory from the workspace's budget until it is closed. There is no limit on how many run at once, only on the total. When there is not enough free, the bot is told and can choose a smaller VM, wait, or close a worker it no longer needs. See [Resources](../resources/).

Close all sideworkers before you make a backup with `house export`: it refuses to run while any are open. See [Back up and move](../backup/).
