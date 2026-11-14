# Quick start

From a bare machine to a bot that answers you in your messenger: install Household, connect a model account and a chat, start it, and write to your first bot.

## What you need

- **A machine to run it on.** A Mac with Apple silicon, or Linux with KVM (`/dev/kvm`): your own computer, a VM with nested virtualization, or a VPS that offers KVM. An Intel Mac works only through such a Linux VM.
- **`python3` and `openssl`** on that machine. The installer tells you if one is missing.
- **A model account** your bots' harness can use. For Claude Code: a Claude Pro, Max or Team subscription, or an Anthropic API key. For Codex: a ChatGPT Plus or Pro subscription, or an OpenAI API key.
- **A messenger** such as Telegram (an account is enough) or Slack (a workspace where you can install an app).

Prefer to let your coding assistant do it? Give it this prompt:

```text
Read https://agents-household.dev/llms.txt and help me set up Household on my machine.
```

## Install

```sh
curl -fsSL https://agents-household.dev/install.sh | sh
```

It installs the newest release into `~/.household` with everything it needs, without Docker or sudo, and touches nothing outside that folder. When it finishes, it tells you what else to do, for example how to add `~/.household/bin` to your `PATH`.

Then check that this machine can run bots:

```sh
house doctor
```

Fix the ✗ lines about the machine itself (microsandbox, virtualization, `python3`, `openssl`). The lines about the config and the daemon settle once you have set Household up and started it.

⚠️ On Linux, if `/dev/kvm` is missing or not usable, bots cannot start. Add yourself to the group that owns `/dev/kvm` and log in again, or pick a VM or VPS with KVM.

## Set it up

Setup asks for three things, one step at a time:

1. **Model**: the account your bots use. Signing in to your subscription is recommended: you open a link on any device, your phone too, and sign in. You can also paste a token or an API key. See [Keys](../keys/) for the differences.
2. **Workspace**: a name for your bots' home (lowercase letters, digits and dashes), and how much of this machine's CPU and memory it may use.
3. **Channel**: where you talk to your bots. A **Telegram group with topics** is recommended; you can also skip this and add a channel later. See [Channels](../channels/) to compare the kinds.

At the end, Household makes your first bot, **Assistant**, with scouts turned on. You can change its model, size and instructions later.

Do it in the web admin or in a terminal; pick one.

**In the web admin:** run `house start` and leave it running. In a second terminal, run `house dashboard`: it opens the admin with a one-time sign-in link, and with no workspace yet it opens the guided setup. Nothing is made until the last step, and if anything fails, nothing is left half made. To run it again later, for a second workspace say, use **Workspaces → Guided setup**.

**In a terminal:**

```sh
house onboard
```

It asks the same questions in the same order. Ctrl-C stops it at any point; what is done stays. When it is done, it offers to start Household. You can run it again any time to add something next to what you have.

### Before you connect Telegram

For a Telegram group with topics, do this in Telegram first:

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and choose a name and a username. It gives you a token.
2. Create a group, or open one of yours, and turn on **Topics** in its settings.
3. Add your new bot to the group and make it an admin with **Manage topics** and **Delete messages**.

Then paste the token into setup. Household asks you to send the bot a message in a private chat (pressing **Start** works): that is how it learns who you are and makes you the workspace's owner. It finds the group by itself and tells you if anything is still missing. Other channel kinds show their own steps in setup.

## Start it

If setup did not start Household already:

```sh
house start
```

The first start downloads the bot's VM image, so give it a minute or two. `house status` shows your bot as `running` when it is ready.

`house start` runs in the foreground and stops when you close the terminal or press Ctrl-C. To keep Household running after you log out and after a reboot, run it as a service: see [Run it in the background](../operating/#run-it-in-the-background).

## Write to your bot

Write to it where you connected it, such as its own topic in your Telegram group. Ask something small first, like "What can you do?" Its replies, files and approval cards all show up in that same place.

## Open the admin

```sh
house dashboard
```

It prints a one-time sign-in link, valid for 60 seconds, and opens it in your browser. The admin lives at `http://127.0.0.1:8780` and is reachable only from this machine.

On a remote server, forward the port from your own computer first:

```sh
ssh -L 8780:127.0.0.1:8780 <server>
```

Then run `house dashboard --no-open` on the server and open the link it prints in your computer's browser.

## What to do next

- Tell your bot who it is and how to work: [Instructions, skills and memory](../instructions/).
- Let it use your mail, documents or calendar: [Connectors](../connectors/).
- Wake it on new mail, feeds or alerts: [Inboxes](../inboxes/).
- Keep a copy of everything: [Back up and move](../backup/).

`house --help` lists every command.
