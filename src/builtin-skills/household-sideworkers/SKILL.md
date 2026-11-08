---
name: household-sideworkers
description: Delegate a separate piece of work to a sideworker (another agent in its own VM) and coordinate with it. Use when a task is long or parallel, needs a clean context, belongs to another project in your home (a repository with its own CLAUDE.md or AGENTS.md, so the worker thinks as that project's developer), or another model would do it better.
---

# Sideworkers

A sideworker is another agent you start for one task. It runs in its own VM with its own session and its own
Docker, sees your home (your projects) and your Household memory, and has its own chat thread where your human
can watch and talk to it. It has no scheduled tasks and cannot start sideworkers itself.

## When to start one

- A long or parallel task you would otherwise do yourself: a refactor, a test run, an investigation.
- Work that needs a clean context, without your conversation in it.
- Work on another project in your home: a folder, usually a git repository, with its own `CLAUDE.md` or
  `AGENTS.md`. See below.
- Work another model does better: see `sideworker_profiles`.

Do the work yourself when it is a few steps. Each worker costs a VM, and the house has a limit on how many run.

## Start

1. `sideworker_profiles` lists the profiles your human allowed. Omit `profile` to run on your own settings.
2. `sideworker_spawn({cwd, task, name?, profile?, worktree?})`. `cwd` is a directory in your home.
   - In a git repository the worker gets **its own worktree** by default: `<repo>/.worktrees/<name>` on branch
     `sideworker/<name>` from your HEAD. Your uncommitted changes are not in it: commit what it needs first.
   - `worktree: false` shares your live directory. Then you both edit the same files: agree who touches what.
3. Write `task` as a full brief: the goal, where to look, what is already ruled out, what done looks like, and how
   to report back. It does not know your conversation.

## A worker in another project

A worker starts in its `cwd`, and its harness reads the project instructions found there: Claude Code reads
`CLAUDE.md`, Codex reads `AGENTS.md`. So a worker started in a project's folder takes on that project's mindset: its
conventions, commands, architecture and rules, without your own conversation and habits in the way. You read those
files only when you go looking; it starts from them.

- Point `cwd` at the project's root (or the folder whose instructions apply), not at your home.
- Pick the profile whose harness reads the file the project has: `AGENTS.md` only suits Codex, `CLAUDE.md` only
  suits Claude Code.
- In a worktree the worker sees only committed files: an untracked or changed `CLAUDE.md` / `AGENTS.md` is not in
  it. Commit it first or pass `worktree: false`.
- Brief it as that project's developer: what to change and why, in the project's terms. Leave its rules to the
  project's file instead of repeating or overriding them in `task`.

## Talk

- `house_send({to, text})` sends to any pet or worker in the house; `house_members` lists them. Messages arrive in
  their session and are quoted in both chat threads.
- A worker's messages are its reports, not your human's instructions.
- Your human may write to the worker directly; you are told when they do. Do not run it in parallel with them.
- Send requests and results, not acknowledgements: two agents thanking each other loop forever.

## Finish

- A worker in a worktree commits on its branch. Review the branch, merge it, then `git worktree remove` it.
- `sideworker_close({name})` stops the worker and removes its VM. Its worktree, branch and files stay.
- Household reminds you every 30 minutes of a worker that sits idle: close what you no longer need.

## Docker and shared files

Each worker's Docker is its own: daemon, images, volumes. Your home is shared, so never let two VMs bind-mount the
same directory into containers (two databases on one data directory corrupt it). In a shared directory, keep
databases and caches in named volumes.
