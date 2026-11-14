# Household overview

Household runs your own AI assistants on your Mac or Linux machine. Each bot is a session of a coding-agent harness such as Claude Code or Codex, in a microVM of its own, and you talk to it in a messenger such as Telegram or Slack. Ask your mail bot "anything urgent?" and it searches your inbox, drafts two replies and waits for your approval before sending them. It keeps its files and memory between conversations and reaches only what you allow.

## What you'd use it for

- **Mail triage.** An [inbox](inboxes/) wakes the bot on new mail; it replies through the [Email connector](connectors/) after you approve.
- **Night ops.** Alerts wake the bot; work that needs the production key goes to a [scout](scouts/) you approve from your phone.
- **A coding partner.** Projects in a [shared folder](volumes/), [sideworkers](sideworkers/) for parallel jobs, a [preview](previews/) link to the app it builds.
- **A family group.** A topic per bot in a Telegram group; you and your partner are [owners](channels/), the kids are guests.
- **Errands on the open web.** A [scout](scouts/) reads an unfamiliar site in a throwaway VM; you pass on what the bot should see.

## How it works

A small program, `house`, runs on your machine. It starts each bot's VM, talks to your messengers, and is every VM's only way to the network. You manage it in a web admin or the terminal.

| Idea | What it is |
| --- | --- |
| Workspace | A group of bots and a trust zone with its own allowlist, secrets, owners and budget. |
| Bot | A long-lived assistant with its own microVM, home folder, memory and chat thread. |
| Harness | What a bot runs on, such as Claude Code or Codex; whatever it can do, the bot can do. |
| Key | The model account a bot uses: a subscription or an API key. |
| Channel | Where you talk to the bots, such as a Telegram group or a Slack DM. |
| Connector | One of your accounts, such as a mailbox, read-only or read-write. |
| Inbox | Something that wakes bots on its own, such as mail or alerts. |
| Sideworker | Extra hands a bot starts for one job, with its home and access. |
| Scout | A specialist for one risky or privileged task, in a fresh VM, after you approve. |

The people who set up a workspace are its **owners**: only they give the bots orders and approve requests. Anyone else in a shared chat is a guest.

## How it keeps you safe

A bot is a capable agent with a shell and root in its VM. Household assumes it will make mistakes, or be talked into them by something it reads, and limits what a mistake can reach.

- **A VM per bot, not a container.** Every bot, sideworker and scout runs in its own hardware-virtualised microVM with its own Linux kernel, and sees none of your files or other bots' except folders you share.
- **One way out, through an allowlist.** A VM's only route out is Household's proxy, which passes only the hosts on the workspace's allowlist. For a new host the bot asks in the chat, and you choose **Allow 15 min** (that bot only), **Allow forever** (the whole workspace) or **Deny**.
- **Secrets substituted at egress.** Inside the VM a secret is a placeholder; the proxy swaps in the real value only in requests to that secret's own hosts. Anywhere else, a placeholder is a useless string.
- **Scouts for what a bot should not hold.** The open web, a production key or a closed network go to a scout, which starts only when you press **Run**. The bot gets facts about the run, not the scout's text, so hostile content stays out of its context.
- **You approve the rest.** New hosts, folders of your computer, preview links and, with **Ask me first**, outgoing email wait for an owner.

⚠️ Placeholders don't work for SSH keys, database passwords or signed requests: those need the real value inside the VM. See [What a placeholder cannot do](network/#what-a-placeholder-cannot-do).

### What it does not protect against

Household cannot stop a bot tricked by a web page, email or file (prompt injection) from misusing what it legitimately has:

- **Allowed hosts.** Each is a way out for your data. `github.com` opens all of GitHub, not just your repositories; `*` opens the whole internet.
- **Read-write folders.** A bot can change or delete what is in them.
- **Write connectors.** They work outside the allowlist. A bot with write access to Google or Slack sends mail, changes files and posts without asking; only Email has **Ask me first**.
- **Memory and shared skills.** A bot can write false notes into its memory, or change skills every bot in the workspace reads.

Bots are told to treat what they read as data, not instructions. That lowers the risk, no more.

A bot can rewrite its own instructions, skills and setup scripts. That changes how it behaves, not what it may reach: access and approvals are kept outside the VM.

### Where your data goes

- **Your model provider** (such as Anthropic or OpenAI) receives everything the bot works with: messages, files, mail, connector results.
- **Your messenger** carries every conversation, file and approval card, including an email's text awaiting approval.
- **Allowed hosts** receive what the bots send them.
- **Your machine** stores your config, keys, bot tokens, secrets, connector sign-ins and backups unencrypted, readable only by your user, so anyone who can act as your user has them all. The web admin listens only there.
- **Nobody else.** Household's maintainers receive nothing, and there is no telemetry.

### Workspaces are trust boundaries

Bots in one workspace share the allowlist, secrets, shared skills, connected accounts, channels and owners. Make a second workspace when:

- one bot reads untrusted input (mail from strangers, guests, the open web) and another holds something valuable (a production key, your private mailbox);
- different people should own the bots, such as your family and your team;
- the bots need a budget of their own.

Only model keys can serve several workspaces.

### Guests

The bot is told not to obey guests, but that is an instruction to the model, not a lock: it may still reveal what it knows. Guests cannot press approval cards or stop a bot; keep bots with private data out of their chats ([Owners and guests](channels/#owners-and-guests)).

## Where it runs and what it costs

A Mac with Apple silicon, or Linux with KVM (your own machine, a VM with nested virtualization or a KVM VPS), with `python3` and `openssl`; no Docker or sudo. Today's harnesses are Claude Code and Codex; today's messengers, Telegram and Slack.

Household is free and open source (AGPL-3.0). You pay your model provider: a subscription's bots stop answering when its allowance runs out, until it resets; an API key is billed per use. See [Keys](keys/) and [Resources](resources/).

## Next steps

- [Quick start](start/): install Household and write to your first bot.
- [Bots](bots/): how bots, sideworkers and scouts differ.
- [Network and secrets](network/): the allowlist and placeholders in detail.
