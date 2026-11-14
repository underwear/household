# Channels

A channel connects a workspace's bots to a messenger, such as a Telegram group with a topic per bot, or your Slack DM with an app of your own. You write there; bots answer and ask for approvals there. One channel can hold several bots, and one bot can be in several channels.

## First, check what is already there

- **A channel** is for talking. It sees only the chat you connect.
- **A [connector](../connectors/)** lets bots act in your accounts, such as mail or your Slack workspace. A Slack channel is not a Slack connector.
- **An [inbox](../inboxes/)** wakes a bot on its own: new mail, an alert, a feed.

## Owners and guests

Bots obey owners only: people listed for the workspace by their messenger id (a Telegram user id, a Slack member ID). Everyone else who writes in a channel is a guest.

**What Household enforces.** Only an owner can approve a bot's requests (network, secrets, shared folders, scout runs, previews), stop a bot, or hand over a secret with `/secret`.

**What the bot decides.** A guest's message still reaches the bot, marked as a guest's. The bot is told never to carry out their orders as yours. That is the model's judgement, not a wall: a guest's message is untrusted text, like a web page, and can talk the bot round. So a bot that shares a chat with guests should hold nothing you would mind a guest getting at: no write connectors, no private folders.

- **Everyone in a group sees what bots post there.**
- **A bot is one bot in every channel.** It carries one memory and one conversation, so what you told it in your private chat can come up in a group. Give a group its own bot.
- **Owners are per platform.** One Telegram user id makes you an owner in every Telegram channel of the workspace.

⚠️ Being an admin of a Telegram group does not make someone an owner. Only the ids under **Workspace → Channels → Owners** count, and until a platform has an owner, everyone there is a guest.

## How a channel works

- **Bots share it.** Address one by name (`Chef, plan dinner`), by replying to it, or in its own topic or thread. The **default** bot you choose gets the rest.
- **Stop a bot** with **Stop** on its message, or `/stop`.
- **[Sideworkers](../sideworkers/) and [scouts](../scouts/)** report in their bot's channel, in their own topic or thread.
- **Forward General** (Telegram topics and threads) is off by default. On, messages in General go to the default bot; in a group, anyone can then reach it as a guest.

## Choose a channel

| Kind | Who is in it | Each bot gets | Pick it for |
| --- | --- | --- | --- |
| **Telegram group with topics** (recommended) | you, and anyone you add | its own topic | several bots, or other people |
| **Telegram private chat, threaded** (beta) | you | its own thread | several bots, just you |
| **Telegram private chat, plain** | you | a share of one conversation | one bot |
| **Slack DM** | you | the default in Messages, others in threads | you live in Slack |

## Telegram

One Telegram bot from [@BotFather](https://t.me/BotFather) speaks for all the workspace's bots, in that workspace only. For a group, see [Before you connect Telegram](../start/#before-you-connect-telegram). For a threaded chat, turn on **Threaded Mode** in BotFather's Mini App and stop users from creating threads. For a plain chat, press **Start**.

Bots send formatting, buttons and files up to 20 MB. In private chats they also send small widgets, such as a checklist you tap; a tap is never your approval. To revoke, remove the channel and `/revoke` the token in BotFather.

## Slack

Bots see only your DM with the app, not your Slack channels, and the app's tokens never reach a bot. Slack keeps slash commands, so type `!stop` and `!secret`, and delete your `!secret` message yourself.

<details>
<summary>Set up the Slack app</summary>

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app from Household's [manifest](https://github.com/underwear/household/blob/main/src/channel-adapters/slack/manifest.json) and install it.
2. Copy the **Bot User OAuth Token** (`xoxb-…`) and create an app-level token (`xapp-…`) with only `connections:write`.
3. Copy your member ID (profile → **More** → **Copy member ID**); it becomes an owner.

Then add the channel as **Slack Bot DM**. To revoke, remove the channel and delete the app.

</details>
