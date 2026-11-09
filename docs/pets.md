# Pets

A pet is your own assistant: a real Claude Code or Codex agent that lives in its own microVM and talks to you in a messenger. It is not a chat session that forgets you — it stays.

## What a pet is

- **Its own computer.** Each pet has a microVM with a home folder that survives restarts and new VMs: its projects, sessions, tools.
- **In your chats.** It answers in the house's channels (Telegram, Slack), in its own thread or as a house's default pet. It takes orders only from the house's owners; anyone else is a guest.
- **Remembers.** Household memory keeps its notes across sessions and even across agent changes.
- **Yours to shape.** Its instructions, skills, environment, schedule and resources are set on its page, and the pet can change most of them itself.
- **Fenced in.** It reaches only the hosts the house allows, and uses your keys only as placeholders it cannot read. It asks you when it needs more.

## Pets, sideworkers, scouts

| | Pet | Sideworker | Scout |
| --- | --- | --- | --- |
| What | Your long-lived assistant | Extra hands a pet starts for one task | A specialist a pet calls for one task |
| Lives | Until you remove it | Until the task is done and it is closed | One run, then its VM is deleted |
| Sees | Its own home and memory | Its parent's home and memory | Nothing of the pet: only its own access |
| Access | The house's network and secrets | Its parent's | Only its [capabilities](../scouts/), which you set |
| Starts | When you add it | When its pet decides | When you press **Run** |

A pet uses a sideworker for a long or parallel job in its own projects, and a [scout](../scouts/) for what it should not hold itself: the untrusted internet, a production key, a closed network.

## Add a pet

**House → Pets → + Add pet**: its name, display name, emoji and the channels it joins; then the agent and key it runs on; then its CPU and memory. `house onboard` walks through the same in a terminal.

## Its page

Click a pet's card to open its page. Buttons at the top:

- **Console** — what its terminal shows right now, read-only (for agents that run in a terminal).
- **Logs** — what Household did with it: messages, turns, network requests, its VM.
- **Restart** — restarts its VM with a fresh session. Files, packages and memory stay. *Let it save its work first* (up to 3 minutes) or *Restart now*.
- **Edit pet** — display name, emoji, aliases. Everything else has its own tab.

A disabled pet shows a bar with **Enable** on every tab.

## Tabs

**Overview** — at a glance: channels, next and last scheduled task, sideworkers, resources, open previews, its settings. At the bottom: **Disable** (stops its VM, keeps everything) and **Remove** (its VM goes and it leaves its channels; files stay on disk).

**Agent** — Claude Code or Codex, the key, model, reasoning effort and permission mode. If a change needs a new session, the tab says so before you save.

**Instructions** — its `CLAUDE.md` or `AGENTS.md`: who it is and how it works. Read at the start of each session.

**Lifecycle** — a scheduled restart for a clean context: how often, when, how much notice. A shutdown message lets it write a handoff note; a wake-up message picks it up.

**Channels** — a switch per house channel: where it answers. **Make default** gives it the messages addressed to no one in a shared channel.

**Inboxes** — **Receives** to get an inbox's events, **Silent** to keep them in its history without waking it. See [Inboxes](../inboxes/).

**Scheduled tasks** — instructions it gets on a schedule, once or repeating, in its own session. Recent runs show what it answered. Times in the Household time zone; failed runs are not retried.

**Skills** — its own skills, besides the house's **Shared Skills** and the built-in ones. It writes and edits skills itself too.

**Environment** — two Bash scripts: **Setup** once per new VM (packages, tools), **On start** at every boot (services). Its home survives a new VM; these rebuild the rest. **Run now** tries the saved script.

**Memory** — its notes by key. `core` is loaded at the start of every session; the rest it looks up. Search, edit and browse a note's versions.

**Resources** — what its VM uses (CPU, memory, disk; 7 days) next to what it is given. A new allocation applies on its next Restart or Enable.

**Dreaming** — soon.

A sideworker's page has only Overview, Skills, Memory and Resources: what runs it, its channels and its tasks are its parent's. **Close** on its Overview removes its VM; the shared files stay.

More: [Adding MCP servers](../mcp/) · [Back up and move](../backup/).
