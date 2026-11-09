# Sideworkers

A sideworker is another agent a pet starts for one job: extra hands in its own VM, working on the pet's projects while the pet goes on talking to you. When the job is done, the pet closes it. How it compares with a pet and a scout: see the table on [Pets](../pets/#pets-sideworkers-scouts).

## When it helps

- **Code in another project.** Point it at a folder with its own `CLAUDE.md` or `AGENTS.md`, and it works as that project's developer: its conventions, commands and rules, without the pet's conversation in the way.
- **Talk to it yourself.** Unlike a subagent hidden inside a session, a sideworker has its own chat thread. Open it, watch it work, and tell it what you want directly.
- **A long or parallel job.** A refactor, a test run, an investigation, while the pet stays free for you.
- **A clean start.** Work that should not carry the pet's long conversation.
- **Another model.** Run the job on a profile you allowed, say Codex next to a Claude Code pet.

## How it works

1. **The pet starts it** with a folder in its home and a brief. In a git repository the worker gets its own worktree and branch, so the two don't edit the same files.
2. **It works in its own VM** with its own session and Docker. It sees the pet's home and the pet's memory, and like the pet it reaches only the hosts the house allows, with the house's secrets.
3. **You can join in.** Its thread shows in the pet's channel. Whatever you write there goes to the worker; the pet is told.
4. **The pet closes it.** Its VM goes; its branch and files stay. Its chat thread is deleted with the messages (on Telegram). The pet is reminded every 30 minutes about a worker that sits idle.

A sideworker cannot start sideworkers or have scheduled tasks. You can close one yourself with **Close** on its page.

## Set up

- **House → Settings → Sideworkers** turns them on. Off pauses the running ones.
- **House → Sideworkers** lists what runs now, by pet. Its settings set how many may run at once in the house and the CPU and memory each new one gets.
- **Profiles** are the agent setups a pet may start a worker on, besides its own: an agent, key, model and effort. Add one when you want work done by another model.

Each worker is a VM: it takes its share of the host's CPU and memory while it runs.
