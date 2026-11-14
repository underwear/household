# Household overview

Household runs your own AI assistants on your Mac or Linux machine. Each bot is a session of a coding-agent harness such as Claude Code or Codex, in a microVM of its own, and you talk to it in a messenger such as Telegram or Slack. Ask your mail bot "anything urgent?" and it searches your inbox, drafts two replies and waits for your approval before sending them. It keeps its files and memory between conversations and reaches only what you allow.

## What you'd use it for

- **A mail triage bot.** A [mail inbox](inboxes/) wakes it on new mail; the [Email connector](connectors/) lets it search and reply, with **Ask me first**; a [scheduled task](schedules/) sends you a digest every weekday at 9:00.
  Nothing leaves your mailbox until you approve it.
- **A night ops bot.** A Grafana [inbox](inboxes/) wakes it on alerts, and it reads logs and dashboards itself.
  Work that needs the production key goes to a [scout](scouts/) that holds the key and reaches only its hosts. You approve each run from your phone; the bot never holds the key.
- **A coding partner.** A read-write [shared folder](volumes/) holds your projects.
  It starts [sideworkers](sideworkers/) for parallel jobs, on another harness or model if you add a profile, and shows you the web app it builds with a [preview](previews/) link.
- **A family group.** A Telegram group with a topic per bot. You and your partner are [owners](channels/) and give the orders; the kids are guests the bots chat with but don't obey.
  A read-write [Microsoft To Do](connectors/) list is the shopping list either of you can ask a bot to update.
- **Errands on the open web.** "Read the reviews on this unfamiliar shop" goes to the **General** [scout](scouts/), in a throwaway VM with none of the bot's files.
  You read what it found and pass on only what the bot should see.

## How it works

A small program, `house`, runs on your machine. It starts each bot's VM, talks to your messengers, and is every VM's only way to the network. You manage it in a web admin or from the terminal.

| Idea | What it is |
| --- | --- |
| Workspace | A group of bots and a trust zone: its own allowlist, secrets, channels, owners, connectors and CPU and memory budget. |
| Bot | A long-lived assistant: its own microVM, a home folder, memory, schedule and thread in the chat. |
| Harness | What a bot runs on, a coding agent such as Claude Code or Codex. Anything the harness can do, the bot can do. |
| Key | The model account a bot uses: a subscription you sign in to, or an API key. |
| Channel | Where you talk to the bots, such as a Telegram group with a topic per bot or a Slack DM. |
| Connector | One of your accounts (a mailbox, Google, Slack…), given to the bots you choose, read-only or read-write. |
| Inbox | Something that wakes bots on its own: mail, feeds, health checks, alerts. |
| Sideworker | Extra hands a bot starts for one job. It shares the bot's home and access. |
| Scout | A specialist a bot calls for one risky or privileged task, in a fresh VM, only after you approve. |

The people who set up a workspace are its **owners**. Only owners give the bots orders and approve what they ask for. Anyone else in a shared chat is a guest.

A bot's home folder and its memory survive restarts, a new VM and a switch to another harness. Software installed outside its home survives a new VM only if the bot's setup script installs it.

## How it keeps you safe

A bot is a capable agent with a shell and root in its VM. Household assumes it will make mistakes, or be talked into them by something it reads, and limits what a mistake can reach.

- **A VM per bot, not a container.** Every bot, sideworker and scout runs in its own hardware-virtualised microVM with its own Linux kernel: microsandbox (libkrun) on Apple's Hypervisor.framework on a Mac, KVM on Linux. It sees none of your files and none of the other bots', except folders you share on purpose. A sideworker sees its parent bot's home.
- **One way out, through an allowlist.** A VM has no direct route to the internet or your local network. Its only way out is Household's proxy, which passes only the hosts and ports on the workspace's allowlist; UDP doesn't work. A bot that needs a new host asks in the chat for one exact name, and you choose **Allow 15 min** (that bot only), **Allow forever** (the whole workspace) or **Deny**. A bot's request for a name that points into a private network is refused without asking you.
- **Secrets substituted at egress.** Model keys and your secrets stay on your machine; inside the VM a secret is a placeholder. For that secret's own hosts only, the proxy ends the TLS connection with a Household certificate authority the VM trusts, swaps the placeholder in the request header for the real value, and sends the request on over a new TLS connection. Traffic to any other host passes through encrypted and unopened, so a placeholder sent there is a useless string.
- **Scouts for what a bot should not hold.** The untrusted web, a production key or a closed network go to a scout. It starts only when you press **Run**, after you see its task, its access and the names of any secrets the bot hands it. It works in a fresh VM, deleted when you close it; a scout with a key reaches only that key's hosts. Its bot gets facts, not text: how the run went and how it ended. The scout's words and files reach the bot only when you pass them on, as untrusted input, so hostile content from a site stays out of the bot's context.
- **You approve the rest.** New hosts, folders of your computer, preview links and, with **Ask me first**, each outgoing email wait for an owner. Approval cards respond to owners only. A secret you send from the chat is deleted from it before Household reads it.

<details>
<summary>⚠️ Placeholders don't work for every secret. Which ones need the real value?</summary>

Substitution happens at egress, not inside the VM, so it works only for HTTP(S) requests that carry the secret as-is in a header. An SSH key, a database password, a request signature (such as AWS SigV4) or a key a program reads from a file needs the real value inside the VM. A bot tells you when that is the case. Give such secrets only to a bot you trust with them, or better, to a scout.

</details>

### What it does not protect against

Household limits what a bot can reach and which keys it holds. It cannot stop a bot that a web page, an email or a file has tricked (prompt injection) from misusing what it legitimately has:

- **Allowed hosts.** Every allowed host is also a way out for your data. Allowing `github.com` opens all of GitHub, not only your repositories; `*` opens the whole public internet.
- **Read-write folders.** A bot can change or delete what is in them.
- **Write connectors.** Connectors work from Household on your machine, outside the allowlist. A bot with write access to Google or Slack sends mail, changes files and posts without asking. Only Email has **Ask me first**.
- **Memory and shared skills.** A bot can write false notes into its memory, and change the workspace's shared skills, which every bot there reads.

Bots are told to treat what they read as data, not instructions. That lowers the risk; it is no guarantee.

A bot can also rewrite its own instructions, skills and setup scripts. That changes how it behaves, not what it may reach: the allowlist, secrets, folders, connectors and approvals are kept by Household outside the VM.

### Where your data goes

- **Your model provider** (such as Anthropic or OpenAI) receives everything the bot works with: your messages, the files and mail it reads, what connectors return.
- **Your messenger** carries every conversation, every file a bot sends and every approval card, including the text of an email waiting for approval.
- **Allowed hosts** receive what the bots send them.
- **Nobody else.** Household's maintainers run no service that receives your conversations, files or keys, and Household sends no telemetry.

### Workspaces are trust boundaries

Bots in one workspace share the allowlist (everything you **Allow forever**), the secrets (by default every bot gets a placeholder), the shared skills, the connected accounts, the channels and the owners. Make a second workspace when:

- one bot reads untrusted input (mail from strangers, a chat with guests, the open web) and another holds something valuable (a production key, your private mailbox);
- different people should own the bots, such as your family's and your team's;
- the bots need a budget of their own.

Model keys are the exception: one key can serve several workspaces.

### Guests

A guest's messages reach the bot marked as a guest's, and the bot is told it may answer but must not carry out what they ask. That is an instruction to the model, not a lock: a guest can ask questions, and the bot may reveal what it knows in its answer. A guest cannot press an approval card, answer a bot's question or stop a bot. Keep bots that hold private data out of chats with guests.

### At rest

Your config (with your keys and bot tokens), your secrets and your backups are stored unencrypted on your machine, readable only by your user. Connector sign-ins are kept unencrypted in Household's database there. Anyone who can act as your user on that machine has them all. The web admin listens only on that machine, at `http://127.0.0.1:8780`; you sign in with a one-time link from `house dashboard` that works for 60 seconds.

## Where it runs and what it costs

| | |
| --- | --- |
| Machine | A Mac with Apple silicon, or Linux (x86_64 or arm64) with KVM: your own machine, a VM with nested virtualization, or a VPS that offers KVM. An Intel Mac only through such a Linux VM. |
| Software | `python3` and `openssl`. The installer brings the rest. No Docker, no sudo. |
| Harnesses today | Claude Code and Codex; more will follow. |
| Messengers today | Telegram and Slack. |
| Model account | A subscription or API key your harness can use: a Claude subscription or Anthropic API key for Claude Code, a ChatGPT subscription or OpenAI API key for Codex. |
| Size | A new workspace may use 8 vCPU and 8 GiB of memory; you can change it. |

Household is free and open source (AGPL-3.0). You pay your model provider: a subscription has a usage allowance, and its bots stop getting answers when it runs out until it resets; an API key is billed per use. See [Keys](keys/) and [Resources](resources/).

## Next steps

- [Quick start](start/): install Household and write to your first bot.
- [Bots](bots/): how bots, sideworkers and scouts differ.
- [Network and secrets](network/): the allowlist and placeholders in detail.
