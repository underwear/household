# Bots

A bot is a long-lived assistant: a coding-agent harness such as Claude Code or Codex, running in its own microVM on your machine and answering you in your messenger. Unlike a chat window, it stays, and remembers that Anna is allergic to nuts.

## Bots, sideworkers, scouts

| | Bot | Sideworker | Scout |
| --- | --- | --- | --- |
| What | Your long-lived assistant | Extra hands for one job | A specialist for one risky task |
| Lives | Until you remove it | Until its job is closed | One run |
| Sees | Its home, memory, folders | Its bot's | Nothing of the bot |
| Access | The workspace's | Its bot's | Only what you set |
| Starts | When you add it | When its bot decides | When you press **Run** |

Projects and long-lived context belong to a bot, a parallel job to a [sideworker](../sideworkers/), an errand on a site you don't trust, or a purchase with your card, to a [scout](../scouts/). Switch the last two under **Workspace → Settings → Features**.

## How it works

- **Its own computer.** It sees only folders you share and reaches out only through Household, holding placeholders, not your keys ([how it keeps you safe](../#how-it-keeps-you-safe)). For a new host, secret or folder it asks and waits.
- **Owners give orders.** It answers in the workspace's [channels](../channels/) and acts only for [owners](../channels/#owners-and-guests).

### What survives what

| | Restart | New VM | Harness switch |
| --- | --- | --- | --- |
| Home folder, Docker, memory, skills, tasks | Stay | Stay | Stay |
| Packages outside home (**Setup** rebuilds them) | Stay | Gone | Gone |
| Running processes (**On start** restarts them) | Gone | Gone | Gone |
| The conversation | Fresh | Depends on harness | Fresh |

A new VM comes with each Household update and each change of harness or shared folders. [MCP servers](../mcp/) the bot added don't follow a harness switch: ask it to add them again.

## What you decide

- **One bot or several.** Separate bots when jobs touch different things: each has its own VM, files, memory, connectors and inboxes, so a mail bot tricked by a hostile email cannot reach the coding bot's projects. Each reserves [resources](../resources/). Bots share their workspace's hosts and secrets; for different ones, make another workspace.
- **Harness and key.** Anything the harness can do, the bot can do; the [key](../keys/) decides whose account pays.
- **Permission mode.** How often the harness asks before acting; Household's approvals apply in every mode. Keep the default, or go stricter for a bot with read-write folders you can't afford to lose.
- **Nightly restart.** Each night it writes a handoff note and resumes in a fresh session, staying sharp. Set it on the **Lifecycle** tab.

<details>
<summary>Why let a harness run without asking?</summary>

A harness that stops for every command is no use from a phone, and its prompts guard your own computer, which a bot does not run on. The VM is the boundary instead: a bot can break only its VM and what you shared with it, and reach only what the workspace allows. What crosses that boundary (a host, a secret, a folder, a scout run) still waits for you.

</details>

## Set it up

Add a bot under **Workspace → Bots** with a [key](../keys/) and usually a [channel](../channels/). Mind three fields:

- **Name** is permanent; the display name isn't.
- **Channels**: a bot in no channel hears no one.
- **Size**: under 1 GiB a harness may run out of memory.

Its **Setup** script runs once per new VM, **On start** on every boot; failures show in **Logs**. Keep secrets out of both.

**Restart** gives a fresh session; **Disable** stops the VM; **Remove** deletes the VM and Docker disk but keeps its home.
