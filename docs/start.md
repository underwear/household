# Quick start

From a bare machine to a bot that answers you in your messenger.

## What you need

- **A machine:** a Mac with Apple silicon, or Linux with KVM (`/dev/kvm`), with `python3` and `openssl`.
- **A model account** your bots' harness can use: for Claude Code, a Claude subscription or an Anthropic API key; for Codex, a ChatGPT subscription or an OpenAI API key.
- **A messenger** such as Telegram (an account is enough) or Slack (a workspace where you can install an app).

Prefer to let your coding assistant do it? Give it this prompt:

```text
Read https://agents-household.dev/llms.txt and help me set up Household on my machine.
```

## Install

```sh
curl -fsSL https://agents-household.dev/install.sh | sh
house doctor
```

The installer puts Household into `~/.household`, without Docker or sudo, and tells you how to add `~/.household/bin` to your `PATH`. Fix the ✗ lines `house doctor` shows about the machine; the ones about the config and daemon settle after setup.

⚠️ On Linux, bots cannot start without a usable `/dev/kvm`. Add yourself to the group that owns it and log in again, or pick a VM or VPS with KVM.

## Set it up

Setup asks for three things:

1. **Model**: sign in to your subscription, or paste a token or an API key. See [Provider keys](../keys/).
2. **Workspace**: a name, and how much CPU and memory it may use.
3. **Channel**: a **Telegram group with topics**, or another kind from [Channels](../channels/).

At the end, Household makes your first bot, **Assistant**. Run setup one of two ways:

- **In the web admin:** run `house start` and leave it running, then `house dashboard` in a second terminal. With no workspace yet, the admin opens the guided setup.
- **In a terminal:** run `house onboard`. When it is done, it offers to start Household.

### Before you connect Telegram

For a Telegram group with topics, do this in Telegram first:

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and choose a name and a username. It gives you a token.
2. Create a group, or open one of yours, and turn on **Topics** in its settings.
3. Add your new bot to the group and make it an admin with **Manage topics** and **Delete messages**.

Then paste the token into setup. Household asks you to send the bot a private message (pressing **Start** works): that is how it learns who you are and makes you the owner. It finds the group itself and tells you if anything is missing.

## Start it

If setup did not start Household already, run `house start`. The first start downloads the bot's VM image, so give it a minute or two; `house status` shows your bot as `running` when it is ready.

`house start` stops when you close the terminal. To keep Household running after you log out and after a reboot, see [Run it in the background](../operating/#run-it-in-the-background).

## Write to your bot

Write to it where you connected it, such as its topic in your Telegram group: "What can you do?" is a good first message. Its replies, files and approval cards show up there too.

To open the admin later, run `house dashboard`; it signs you in with a one-time link. The admin is reachable only from this machine; for a remote server, see [The admin does not open](../operating/#the-admin-does-not-open).

## What to do next

- [Instructions, skills and memory](../instructions/): tell your bot who it is and how to work.
- [Connectors](../connectors/): let it use your mail, documents or calendar.
- [Inboxes](../inboxes/): subscribe it to new mail, feeds or alerts.
