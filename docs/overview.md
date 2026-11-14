# Household overview

Household gives you your own AI assistants. Each one is a bot running Claude Code or Codex, in its own microVM on your Mac or Linux machine, and you talk to it in your messenger: Telegram or Slack. A bot keeps its files and memory between conversations, works on its own schedule, and reaches only what you allow. Your keys stay on your machine, and the bots never see them.

## What you can do with it

- **Talk to your assistants from anywhere.** Each bot has its own thread or topic in your chat. Write to it from your phone or your laptop, like to anyone else.
- **Give each one a job.** A household helper, a coding partner for your projects, an ops bot that watches your alerts at night. Each has its own instructions, skills and memory.
- **Let them act on their own.** Bots can wake up on new mail, feeds or alerts, and run tasks on a schedule: a digest every weekday at 9:00, or a reminder at 18:00 today.
- **Connect your accounts with care.** Give chosen bots access to mail, documents, calendars, chats or tasks, read-only or read-write.
- **Hand risky work to a throwaway VM.** "Read the reviews on this unfamiliar site" or "buy two bus tickets" goes to a scout that you approve, not to the bot that holds your files.

## Core ideas

| Idea | What it is |
| --- | --- |
| Workspace | A home for a group of bots, and a trust zone. It has its own allowlist of hosts, secrets, channels, owners and CPU and memory budget. |
| Bot | A long-lived assistant in a workspace. It has its own microVM with a home folder that survives restarts, its own memory, and its own thread in the chat. |
| Harness | What a bot runs on: Claude Code or Codex. Anything the harness can do, the bot can do. |
| Key | The model account a bot uses: a Claude or ChatGPT subscription you sign in to, or an API key. |
| Channel | Where you talk to the bots: a Telegram group with a topic per bot, a private Telegram chat, or a Slack DM. |
| Connectors | Your accounts (mail, Google, Slack, Microsoft To Do and more), connected to the workspace and given to the bots you choose. |
| Sideworker | Extra hands a bot starts for one long or parallel job. It shares the bot's home and access, and is closed when the job is done. |
| Scout | A specialist a bot calls for one risky or privileged task. It runs in a fresh VM with only the access you gave it, and only after you approve. |

The people who set up a workspace are its **owners**. Only owners can give the bots orders and approve what they ask for. Anyone else in a shared chat is a guest.

## How it works

A small program, `house`, runs on your machine. It starts each bot's VM, talks to your messenger, and stands between every bot and the internet.

1. **Install Household** on your Mac or Linux machine.
2. **Set it up**, in the web admin or with `house onboard` in a terminal: a key, a workspace, a channel, and a first bot.
3. **Start it.** The first start downloads the bot's VM image.
4. **Write to your bot** in its thread. It answers there, and it can start sideworkers or ask for a scout when the job needs one.
5. **Shape it over time** in the web admin: its instructions, skills, schedule, connectors, the hosts it may reach and the folders it may see.

Household is open source and self-hosted. Nobody but you receives your conversations, files or keys, and Household sends no telemetry. The models themselves run at your provider, Anthropic or OpenAI. The web admin listens only on your machine, at `http://127.0.0.1:8780`.

## How it keeps you safe

A bot is a capable agent with a shell. Household assumes it can make mistakes, or be talked into them by something it reads, and limits what a mistake can reach.

- **One VM per bot.** Every bot, sideworker and scout runs in its own microVM, with its own Linux kernel. It sees none of your files and none of the other bots' files, except folders you share on purpose. A sideworker sees its parent bot's home.
- **An allowlist for the network.** Each workspace lists the hosts its bots may reach. Everything else is blocked. When a bot needs a new host, it asks in the chat, and you choose **Allow 15 min**, **Allow forever** or **Deny**.
- **Secrets as placeholders.** A bot never holds your real API keys or secrets. It gets a placeholder instead. When the bot sends a request to that secret's own hosts, Household puts the real value into the request on its way out. Sent anywhere else, the placeholder is useless.
- **Scouts need your approval.** A scout starts only when you press **Run** on its card, after you see the task, its access and any secret the bot wants to pass. It works in a fresh VM with none of the bot's files, and its VM is deleted when you close it. What it finds reaches you first. The bot gets its words and files only when you pass them on.
- **You approve the rest too.** When a bot asks for a folder of your computer or for a link to a web app it runs, it waits for your answer in the chat. Sending mail through a connector waits for you too, unless you allowed it in advance.

⚠️ The placeholder trick works only for HTTP(S) requests that carry the secret as-is in a header. An SSH key, a database password, a request signature (such as AWS) or a key read from a file needs the real value inside the VM. A bot will tell you when that is the case. Put such secrets only into a bot or a scout you trust with them.

## Where it runs

| | |
| --- | --- |
| Machine | A Mac with Apple silicon, or Linux (x86_64 or arm64) with KVM: your own machine, a VM with nested virtualization, or a VPS that offers KVM. An Intel Mac works only through such a Linux VM. |
| Software | `python3` and `openssl`. The installer brings everything else. No Docker, no sudo. |
| Harnesses | Claude Code, Codex |
| Messengers | Telegram, Slack |
| A model account | A Claude subscription or Anthropic API key for Claude Code; a ChatGPT subscription or OpenAI API key for Codex. |

## Next steps

- [Quick start](start/): install Household and say hi to your first bot.
- [Bots](bots/): everything on a bot's page.
- [Keys](keys/): which account your bots run on, and how to sign in.
- [Channels](channels/): where you talk to your bots, and who else can.
- [Network and secrets](network/): the allowlist, temporary access and placeholders.
- [Scouts](scouts/): give bots risky jobs without risking their files.
