# Sideworkers

A sideworker is another assistant a bot starts for one job: extra hands in its own VM, working on the bot's projects while the bot goes on talking to you. When the job is done, the bot closes it. How it compares with a bot and a scout: see the table on [Bots](../bots/#bots-sideworkers-scouts).

## When it helps

- **Code in another project.** Point it at a folder with its own `CLAUDE.md` or `AGENTS.md`, and it works as that project's developer: its conventions, commands and rules, without the bot's conversation in the way.
- **Talk to it yourself.** Unlike a subagent hidden inside a session, a sideworker has its own chat thread. Open it, watch it work, and tell it what you want directly.
- **A long or parallel job.** A refactor, a test run, an investigation, while the bot stays free for you.
- **A clean start.** Work that should not carry the bot's long conversation.
- **Another model.** Run the job on a profile you allowed, say Codex next to a Claude Code bot.

## How it works

1. **The bot starts it** with a folder in its home and a brief. In a git repository the worker gets its own worktree and branch, so the two don't edit the same files.
2. **It works in its own VM** with its own session and Docker. It sees the bot's home and the bot's memory, and like the bot it reaches only the hosts the workspace allows, with the workspace's secrets.
3. **You can join in.** Its thread shows in the bot's channel. Whatever you write there goes to the worker; the bot is told.
4. **The bot closes it.** Its VM goes; its branch and files stay. Its chat thread is deleted with the messages (on Telegram). The bot is reminded every 30 minutes about a worker that sits idle.

A sideworker cannot start sideworkers or have scheduled tasks. You can close one yourself with **Close** on its page.

## Set up

- **Workspace → Settings → Sideworkers** turns them on. Off pauses the running ones.
- **Workspace → Sideworkers** lists what runs now, by bot. Its settings set how many may run at once in the workspace and the CPU and memory each new one gets.
- **Profiles** are the harness setups a bot may start a worker on, besides its own: a harness, key, model and effort. Add one when you want work done by another model.

Each worker is a VM: it takes its share of the host's CPU and memory while it runs.
