# Quick start

This page takes you from a bare machine to a bot that answers you in your messenger. You install Household, connect a model account and a chat, start it, and say hi.

## What you need

- **A machine to run it on.** A Mac with Apple silicon, or Linux with KVM (`/dev/kvm`): your own computer, a VM with nested virtualization, or a VPS that offers KVM. An Intel Mac works only through such a Linux VM.
- **`python3` and `openssl`** on that machine. The installer tells you if one is missing.
- **A model account** for your bots. For Claude Code: a Claude Pro, Max or Team subscription, or an Anthropic API key. For Codex: a ChatGPT Plus or Pro subscription, or an OpenAI API key.
- **A messenger.** A Telegram account, or a Slack workspace where you can install an app.

Prefer to let your coding assistant do it? Give Claude Code or Codex this prompt:

```text
Read https://agents-household.dev/llms.txt and help me set up Household on my machine.
```

## Install

Run this in a terminal:

```sh
curl -fsSL https://agents-household.dev/install.sh | sh
```

It installs the newest release into `~/.household` with everything it needs. It does not need Docker or sudo, and it touches nothing outside that folder. When it finishes, it tells you what else to do, for example how to add `~/.household/bin` to your `PATH`.

Then check that this machine can run bots:

```sh
house doctor
```

Each line starts with ✓ when all is well, or ✗ with what to fix. Fix what it says about the machine itself (microsandbox, virtualization, `python3`, `openssl`). The lines about the config and the daemon settle once you have set Household up and started it.

⚠️ On Linux, if the installer says `/dev/kvm` is missing or not usable, bots cannot start. Add yourself to the group that owns `/dev/kvm` and log in again, or pick a VM or VPS with KVM.

## Set it up

Setup asks for three things, one step at a time, and shows how to get each of them:

1. **Model**: the account your bots use. **Sign in to Claude** and **Sign in to ChatGPT** are recommended: you open a link on any device, your phone too, and sign in. You can also paste a **Claude subscription token**, an **Anthropic API key** or an **OpenAI API key**. See [Keys](../keys/) for the differences.
2. **Workspace**: a name for your bots' home (lowercase letters, digits and dashes), and how much of this machine's CPU and memory it may use.
3. **Channel**: where you talk to your bots. **Telegram group with topics** is recommended. You can also choose **Telegram, a thread per bot** (beta), **Telegram, one plain chat** or **Slack DM**, or skip this step and add a channel later.

At the end, Household makes your first bot, **Assistant**, with scouts turned on. You can change its model, size and instructions later.

You can do all of this in the web admin or in a terminal. Pick one.

### In the web admin

1. Start Household: `house start`. Leave it running in that terminal.
2. In a second terminal, run `house dashboard`. It opens the admin in your browser with a one-time sign-in link.
3. With no workspace yet, the admin opens **Set up Household** by itself. Go through **Model**, **Workspace** and **Channel**.
4. On **Review**, check what you chose and press **Set it all up**. Nothing is made before this step, and if anything fails, nothing is left half made.

Later, you can run the same setup again from **Workspaces → Guided setup**, for example for a second workspace.

### In a terminal

```sh
house onboard
```

It asks the same questions, in the same order. You can stop it with Ctrl-C at any point; what is done stays. When it is done, it offers to start Household right there. You can run `house onboard` again any time: it offers what you already have, or adds something new next to it.

### Connecting Telegram

For the recommended **Telegram group with topics**, each bot gets its own topic in a group of yours. Before you paste anything:

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and choose a name and a username. It gives you a token.
2. Create a group, or open one of yours, and turn on **Topics** in its settings.
3. Add your new bot to the group and make it an admin with **Manage topics** and **Delete messages**.

Then paste the token into setup. Household asks you to send the bot any message in a private chat (pressing **Start** works): that is how it knows you, and you become the workspace's owner. It finds the group by itself and tells you if anything is still missing there.

For the other channel kinds and for Slack, setup shows its own steps. See [Channels](../channels/) for more.

## Start it

If setup did not start Household already, start it now:

```sh
house start
```

The first start downloads the bot's VM image, so give it a minute or two. Check on it with:

```sh
house status
```

Your bot shows as `running` when it is ready. In the admin, its state shows as **Running** on **Workspace → Bots**.

`house start` runs in the foreground and stops when you close the terminal or press Ctrl-C. To keep Household running after you log out and after a reboot, run it as a background service: see [Run it in the background](../operating/#run-it-in-the-background).

## Say hi

Write to your bot where you connected it:

- **Telegram group with topics**: in the bot's own topic in your group.
- **Telegram, a thread per bot**: in your private chat with the Telegram bot, in its thread.
- **Telegram, one plain chat**: right in your private chat with the Telegram bot.
- **Slack DM**: in your direct messages with the Slack app.

Ask it something small first, like "What can you do?" It answers in the same place. Replies, files and approval cards from this bot all show up there.

## Open the admin

The web admin is where you manage everything after setup. Run:

```sh
house dashboard
```

It prints a one-time sign-in link, valid for 60 seconds, and opens it in your browser. The admin lives at `http://127.0.0.1:8780` and is reachable only from this machine.

On a remote server, forward the port first, from your own computer:

```sh
ssh -L 8780:127.0.0.1:8780 <server>
```

Then run `house dashboard --no-open` on the server, and open the link it prints in the browser on your computer.

## What to do next

- Tell your bot who it is and how to work: [Instructions, skills and memory](../instructions/).
- Let it use your mail, documents or calendar: [Connectors](../connectors/).
- Add more bots, each with its own job: [Bots](../bots/).
- Have it do things on a schedule: [Scheduled tasks](../schedules/).
- Wake it up on new mail, feeds or alerts: [Inboxes](../inboxes/).
- Keep a copy of everything: [Back up and move](../backup/).

`house --help` lists every command.
