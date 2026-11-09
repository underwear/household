# Scouts

A scout is a specialist your bots can call for one task: "buy two bus tickets", "find out why prod returns 500", "download this video". It works in its own fresh VM, with only the access you gave it, and is deleted when the task is done.

Scouts are how bots touch what is risky or valuable without holding it themselves: the open, untrusted internet, a production key, a closed network. A bot never sees a scout's keys, and a scout sees none of the bot's files or memory.

## Turn them on

In **Workspace → Settings**, switch on **Scouts**. The first time, the workspace gets ready-made capabilities (a browser, media tools, dev tools) and the **General** scout made of them: the open tools on the open internet.

## Set up a scout

**Workspace → Scouts → + New scout**. A scout is set up like a skill:

- **Name, title and description** — the description says when to call it; bots choose by it.
- **Instructions** — how it should work.
- **Access** — the **capabilities** it is made of, a setup of its own if it needs one, and optionally a repository to start in.
- **Harness and resources** — its own, or the workspace's defaults.

A **capability** is one thing a scout can do: an install script, the network it needs and the keys it uses. They live on the **Capabilities** tab, each with **Test install** and a history of changes. Keep them small (a browser; a CLI and its key): a scout combines several. Network works like this:

- A capability that needs only software (a browser, a downloader) leaves the network **open**.
- A capability that brings access to something valuable lists its **hosts**: a scout that has it reaches only the hosts of its capabilities. So a scout with a production key cannot wander off to the open internet.

You add the keys' values yourself. Bots can **draft** a capability they need; nothing changes until you apply it.

**Settings** on the Scouts page: how many scouts may run at once, and the harness, CPU and memory of scouts that set none.

## A run

1. **A bot calls a scout** by name with a short task and what counts as success.
2. **You approve.** A **Run** card shows in the chat: who calls whom, the task, the capabilities, the network, the keys inside its VM and the names of any secrets the bot passes. Nothing starts until you press **Run**; unanswered, it is cancelled after 10 minutes.
3. **It works in its own thread** (**Open thread** on the card). Talk to it there; the result — text and files — comes to you in that thread.
4. **Its bot gets facts, not text:** status, steps, how many domains, file handles. A scout's words or files reach the bot only when you pass them, one at a time. Whatever comes from a scout is treated as untrusted.
5. **It says it is done** with an outcome (success, failed, blocked). On its card, **Close** deletes its VM; **Keep** leaves it running for more. A scout has no time limit: its bot is reminded when it idles for 30 minutes and should cancel it when it is finished or stuck.

## Secrets

You decide every one:

- Keys of capabilities are yours: you set them in the admin, and the bot never sees them.
- A bot that passes a secret it knows (a card number, an email for a new account) names it on the Run card; you approve it with the run.
- A scout that asks for a secret mid-task needs your approval too, or it asks you directly in its thread.

## Threads

A scout's thread stays after the run, as history. A bot can ask to delete it: a **Delete thread / Keep** card asks you, and deleting stops the scout if it is still running and removes the thread with its messages and files. Channels that cannot delete threads keep the history.

## Run one yourself

`house scout run <workspace> <scout> --task "…"` starts a scout without a Run card; its thread opens in a bot's channel, and the bot hears nothing of it. `house --help` lists the rest: runs, status, logs, cancel.
