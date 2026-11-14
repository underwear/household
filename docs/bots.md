# Bots

A bot is your own assistant: a Claude Code or Codex session that runs on your machine and talks to you in your messenger. Unlike a chat window, it stays. It has its own computer, remembers what you told it last week, keeps its projects between conversations, and can work on a schedule. A workspace can have several bots, each with its own name, job and instructions.

## What a bot is

- **Its own computer.** Each bot runs in its own small virtual machine (a microVM). Its home folder, with its projects and tools, survives restarts.
- **In your chats.** It answers in the workspace's [channels](../channels/): a Telegram topic or thread of its own, or a Slack DM. It takes orders only from the workspace's owners. Anyone else in the chat is a guest it may talk to but will not obey.
- **It remembers.** Its notes are kept by Household, so they survive new sessions and even a switch from Claude Code to Codex. See [Instructions, skills and memory](../instructions/).
- **Yours to shape.** Its instructions, skills, schedule and setup are on its page in the admin. The bot can change most of them itself when you ask.
- **Fenced in.** It reaches only the hosts the workspace allows, and it never holds your model key or secrets. When it needs something new (a website, a token, a folder), it asks you in the chat.

## Bots, sideworkers, scouts

A bot can bring in help of two kinds:

- A **[sideworker](../sideworkers/)** is extra hands the bot starts for one long or parallel job, like a refactor in another project. It works with the bot's files, memory and access, has its own thread you can talk in, and the bot closes it when the job is done.
- A **[scout](../scouts/)** is a specialist the bot calls for one task it should not do itself: browsing the untrusted internet, using a production key, reaching a closed network. It runs in a fresh throwaway VM with only the access you gave it, starts only when you press **Run**, and sees nothing of the bot.

Each can be switched on or off per workspace under **Workspace → Settings → Features**.

## Add a bot

You need a [key](../keys/) first, and usually a [channel](../channels/) for the bot to answer in. `house onboard` creates your first bot for you. To add another:

1. Go to **Workspace → Bots → + Add bot**.
2. On the **Bot** step:
   - **Display name** is how it signs its messages, like "Sous Chef". **Emoji** shows before it in the chat.
   - **Name** is for the config and the `house` commands. It follows the display name until you type your own, and it can't be changed later.
   - **Aliases** are other names it answers to, comma-separated.
   - Under **Channels**, switch on the chats it should be in. A bot in no channel hears no one; you can add it later.
3. Press **Next**. On the **Harness** step:
   - **Harness**: **Claude Code** (runs on a Claude subscription or an Anthropic API key) or **Codex** (a ChatGPT subscription or an OpenAI API key).
   - **Key**: which of your keys it runs on. Only keys that fit the harness and this workspace are listed. The bot never sees the key itself.
   - **Model** and **Reasoning effort**. **Default (native)** leaves the effort to the model.
   - **Permission mode**: how much the harness may do without asking. It always stays inside its own VM and the workspace's network rules.
   - Any options of the harness itself, such as Claude Code's **Subagent model** and the **Claude.ai connectors** or **ChatGPT apps** switch under **Harness options** (see [Keys](../keys/#account-connectors)).
   - **Size** (folded): CPU and RAM for its VM. The default suits most bots. Under 1 GiB a harness may run out of memory.
4. Press **Add bot**. Household starts its VM and posts a notice in its channels once it is up.

## The bot's page

Click a bot's card on **Workspace → Bots** to open its page. The buttons at the top:

- **Console** shows what its terminal shows right now, read-only. Only for Claude Code, which runs in a terminal.
- **Logs** shows what happened with it (see [Watch it work](#watch-it-work)).
- **Restart** starts it fresh (see [Restart, disable, remove](#restart-disable-remove)).
- **Edit bot** changes its display name, emoji and aliases. Everything else has its own tab.

The tabs, by what you would use them for:

**Overview** is the bot at a glance: its channels, next and last scheduled task, sideworkers, resource use, open [previews](../previews/) and what runs it. **Disable…** and **Remove** are at the bottom.

**Harness** changes what runs it: harness, key, model, reasoning effort, permission mode and harness options. If a change needs a new session, the button says **Save and restart**. Its files and memory stay.

**AGENTS.md** holds its standing instructions: who it is and how it should work. See [Instructions, skills and memory](../instructions/).

**Lifecycle** gives it a clean start on a schedule. Switch on **Restart on a schedule**, pick every day, week or month and a time. Before the restart the bot gets a **Shutdown message** so it can write a handoff note, and after it a **Wake-up message** so it picks up where it left off. Both have sensible defaults you can edit.

**Channels** has a switch per channel of the workspace: where the bot answers. In a channel shared by several bots, **Make default** gives this one the messages addressed to no one in particular.

**Inboxes** chooses which of the workspace's [inboxes](../inboxes/) (mail, feeds, alerts) reach it. **Receives** wakes the bot for each event. **Silent** only keeps events where it can look them up later.

**Scheduled tasks** lists what it will do later, once or on repeat. See [Scheduled tasks](../schedules/).

**Skills** holds its own skills, next to the workspace's shared ones. See [Instructions, skills and memory](../instructions/#skills).

**Environment** keeps two Bash scripts that rebuild what lives outside its home folder when it gets a new VM:

- **Setup** runs once per new VM: system packages and tools.
- **On start** runs at every boot, before the harness: services and background processes.

**Run now** runs the saved script in the current VM so you can check it. The bot edits and runs these itself when you ask it to "install X so it survives a new VM". Keep secrets out: the scripts are stored in plain text in Household's config.

**Volumes** lists the folders of your computer this bot can see, at `/volumes/<name>`. Switch one on or off, or **+ Share folder** for a new one. See [Shared folders](../volumes/).

**Memory** holds its notes. See [Instructions, skills and memory](../instructions/#memory).

**Resources** shows what its VM uses (CPU and memory, kept for 7 days) next to its **Allocation**. A new allocation applies on its next restart. See [Resources](../resources/).

A sideworker's page has only **Overview**, **Skills**, **Memory** and **Resources**: what runs it, its channels and its tasks belong to the bot that started it. **Close…** on its Overview removes its VM; the shared files stay.

## Watch it work

**Logs** opens a live panel. **Activity** shows the messages it got, what the harness did and what Household did with it. Switch **Network** on to see every request it made and whether it was let through. **Setup**, **On start**, **Docker** and **Kernel** are logs from inside its VM, handy when a setup script fails.

**Console** (Claude Code only) shows its terminal screen, refreshed every 2 seconds. You can watch, but not type. To type into the session yourself, run `house bot attach <workspace> <bot>` in a terminal on the Household machine. Press Ctrl-b, then d, to leave it running.

## Restart, disable, remove

**Restart** restarts its VM and starts a fresh harness session. Its files, packages and memory stay; the conversation does not. Choose **Let it save its work first** (it wraps up, for up to 3 minutes) or **Restart now** (the current turn stops and unsaved work is lost). Restart when it seems stuck or confused, or after you changed its instructions.

**Disable…** stops its VM until you turn it back on, with the same two choices. Nothing is removed. A disabled bot shows a bar with **Enable** on every tab.

**Remove** deletes the bot: its VM goes and it leaves its channels. Its files stay on disk.

From a terminal: `house bot restart|disable|enable|rm <workspace> <bot>`. Add `--now` to restart or disable without waiting.

More: [Keys](../keys/) · [Channels](../channels/) · [Shared folders](../volumes/) · [MCP servers](../mcp/) · [Back up and move](../backup/)
