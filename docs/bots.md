# Bots

A bot is a long-lived assistant: a coding-agent harness such as Claude Code or Codex, running in its own microVM on your machine and answering you in your messenger. Unlike a chat window, it stays. A "Sous Chef" bot in the family group plans this week's meals, remembers that Anna is allergic to nuts, and still has last week's shopping list in its home folder.

## What you'd use it for

- **A household helper** in a family chat: meals, reminders, a shared to-do list.
- **A coding partner** for your projects in a [shared folder](../volumes/).
- **A mail or ops bot** that wakes on new mail or an alert from an [inbox](../inboxes/) and tells you only what matters.
- **A researcher** that keeps notes on a topic for weeks and sends a digest on a [schedule](../schedules/).

## Bots, sideworkers, scouts

| | Bot | Sideworker | Scout |
| --- | --- | --- | --- |
| What | Your long-lived assistant | Extra hands a bot starts for one job | A specialist a bot calls for one risky or privileged task |
| Lives | Until you remove it | Until the job is done and it is closed | One run, then its VM is deleted |
| Sees | Its own home, memory and shared folders | Its bot's home, memory and folders | Nothing of the bot: only what its capabilities bring |
| Access | The workspace's allowed hosts and secrets | Its bot's | Only its capabilities' hosts and keys, which you set |
| Starts | When you add it | When its bot decides | When you press **Run** |

Your projects and long-lived context belong to a bot. A long or parallel job in those projects goes to a [sideworker](../sideworkers/). The untrusted internet, a production key or a closed network goes to a [scout](../scouts/), so none of it sits next to your files. Sideworkers are on in a new workspace, scouts off: **Workspace → Settings → Features**.

## How it works

- **Its own computer.** A microVM with its own Linux kernel. It sees none of your files or other bots', except folders you share. Its only way out is Household, which lets through the allowed hosts and puts your keys into requests on the way out; the bot holds only placeholders.
- **Owners give orders.** It answers in the workspace's [channels](../channels/) and takes orders only from the workspace's owners. Anyone else in the chat is a guest: the bot may talk to them but is told not to act for them, and its approval cards (a host, a secret, a folder, a scout run) answer only to an owner.
- **It asks for more.** A new host, secret or folder: it asks in the chat and waits.

### What survives what

| | Restart | New VM | Harness switch |
| --- | --- | --- | --- |
| Home folder: projects, harness settings, tools installed there | Stays | Stays | Stays |
| Memory, instructions, personal skills, scheduled tasks | Stay | Stay | Stay |
| Docker images, containers and volumes | Stay | Stay | Stay |
| Packages installed outside home (`apt`, `/etc`) | Stay | Gone; **Setup** rebuilds them | Gone; **Setup** rebuilds them |
| Running processes and services | Gone; **On start** restarts them | Gone; **On start** restarts them | Gone; **On start** restarts them |
| The conversation | Fresh | Depends on the harness | Fresh |

A bot gets a new VM when Household updates, when you switch its harness, and when its shared folders change. What it must not forget belongs in [memory](../instructions/#memory). Settings in a harness's own config, such as [MCP servers](../mcp/) it added, stay with that harness: after a switch, ask the bot to add them again.

## What you decide

- **One bot or several.** One bot has one memory and one place to ask. Make separate bots when jobs differ in what they touch: each has its own VM, files, memory, folders, connectors and inboxes, so a mail bot tricked by a hostile email cannot reach the coding bot's projects. Each reserves CPU and RAM (2 vCPU and 1 GiB by default, of the workspace's 8 and 8; see [Resources](../resources/)). Bots of a workspace share its allowed hosts and secrets; when those must differ, make a second workspace.
- **Harness and key.** Anything the harness can do, the bot can do. The [key](../keys/) decides whose account it runs on and how it is billed.
- **Permission mode.** How much the harness does before asking. Household's network rules, secrets and approvals apply in every mode; the mode only governs the harness's own questions, which come to the chat as cards. Keep the default Household picks for each harness. Choose a stricter mode for a bot with read-write folders you could not bear to lose.
- **Nightly restart.** A new bot restarts every night at 04:00: 5 minutes before, it is asked to write a handoff note, and it picks up from it in a fresh session. A clean context keeps a long-lived bot sharp. Change it on the **Lifecycle** tab, or turn it off for a bot that works through the night.

<details>
<summary>Why let a harness run without asking?</summary>

A harness that stops for every command is no use from a phone, and its prompts guard your own computer, which a bot does not run on. The VM is the boundary instead: a bot can break only its VM and what you shared with it, and reach only what the workspace allows. What crosses that boundary (a host, a secret, a folder, a scout run) still waits for you.

</details>

## Set it up

You need a [key](../keys/) and usually a [channel](../channels/). `house onboard` creates your first bot; for more, **Workspace → Bots → + Add bot**. Three fields carry a trap:

- **Name** is for the config and `house` commands, and can't be changed later. The display name and emoji can.
- **Channels**: a bot in no channel hears no one.
- **Size**: the default suits most bots. Under 1 GiB a harness may run out of memory.

| Tab | What it is for |
| --- | --- |
| Overview | The bot at a glance; **Disable** and **Remove** |
| Harness | Harness, key, model, effort, permission mode, account connectors; a change that needs a new session restarts it |
| AGENTS.md | Its standing [instructions](../instructions/) |
| Lifecycle | Its scheduled restart and the handoff messages around it |
| Channels | Where it answers; default bot of a shared chat |
| Inboxes | Which [inboxes](../inboxes/) wake it, and which only keep events for it |
| Scheduled tasks | [What it does later](../schedules/), once or on repeat |
| Skills | Its own [skills](../instructions/#skills) |
| Environment | **Setup** (once per new VM) and **On start** (every boot) scripts |
| Volumes | The [shared folders](../volumes/) it sees at `/volumes/<name>` |
| Memory | Its [notes](../instructions/#memory) |
| Resources | What its VM uses against its allocation; a new allocation applies on the next restart |

## Limits and good to know

- **Restart** gives a fresh session and keeps files, packages and memory; **Let it save its work first** waits up to 3 minutes. **Disable** stops its VM and keeps everything. **Remove** deletes its VM and Docker disk; its home stays on your disk.
- **Logs** show its messages, turns, every network request and its VM's own logs, where a failing **Setup** script shows up. **Console** shows a terminal harness's screen, read-only; `house bot attach <workspace> <bot>` lets you type into it (Ctrl-b, then d, to leave).
- Environment scripts are stored in plain text in Household's config. Keep secrets out.
- From the terminal: `house bot add|set|restart|disable|enable|rm <workspace> <bot>`; `--now` skips the wait.

## Put it to use

A coding partner: share your projects folder read-write, write its role in AGENTS.md ("you maintain the site and the API; run the tests before you say done"), and put `sudo apt-get install -y postgresql-client` in its **Setup** script. Ask it to fix a bug in the API while a sideworker updates the site's dependencies on a branch of its own.

## Related

[Instructions, skills and memory](../instructions/) · [Keys](../keys/) · [Sideworkers](../sideworkers/) · [Scouts](../scouts/)
