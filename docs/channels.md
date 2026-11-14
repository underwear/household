# Channels

A channel connects one of your messengers to your bots: a Telegram group with a topic per bot, say, or a DM with your own Slack app. You write there, bots answer there, and their questions and approval cards come to you there. Messengers are added over time; each one is a kind of channel.

The usual setup is one channel with just you in it and your bots in it. That is what [Quick start](../start/) makes, and most people never need more. Sharing a bot with other people or putting it in more chats are extras, further down.

## First, check what is already there

- **A channel** is for talking. Bots see only the chat you connect.
- **A [connector](../connectors/)** lets bots act in your accounts, such as your mail or your Slack workspace. A Slack channel is not a Slack connector.
- **An [inbox](../inboxes/)** wakes a bot on its own: new mail, an alert, a feed.

## Your channel

You are its **owner**: setup adds your messenger id, and bots take orders and approvals from you.

| Kind | Each bot gets | Pick it for |
| --- | --- | --- |
| **Telegram group with topics** | its own topic | several bots, each in its own place |
| **Telegram private chat, threaded** | its own thread | the same, without a group |
| **Telegram private chat, plain** | a share of one conversation | a single bot |
| **Slack DM** | the default in Messages, others in threads | you live in Slack |

Several bots share one channel. Talk to one in its topic or thread, by name (`Chef, plan dinner`), or by replying to it; the **default** bot gets the rest. **Stop** on a bot's message, or `/stop`, stops it. [Sideworkers](../sideworkers/) and [scouts](../scouts/) report in their bot's channel, each in a topic or thread of its own.

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

## Going further

### One bot in several channels

Add a channel and switch your bot on in it, and the same bot answers there too: in Telegram on your phone and in Slack at work, or in your private chat and a family group. It is still one bot, with one memory and one conversation, wherever you write to it. Add your id in each new messenger as an owner, so the bot knows it is you.

In a chat with other people, everyone sees what the bot posts, and what you told it in private can come up there. If that matters, give the shared chat a bot of its own.

### Owners and guests

Anyone else who writes in a channel is a **guest**, unless you add them as an owner under **Workspace → Channels → Owners** (owners are per messenger: one Telegram id counts in every Telegram channel of the workspace).

- **Household enforces** that only owners approve what bots ask for (hosts, secrets, folders, scout runs, previews), stop a bot or send `/secret`.
- **The bot decides the rest.** A guest's message reaches it marked as a guest's, and it is told not to carry out their orders. That is the model's judgement, not a wall: a guest can talk it round, like a web page can. A bot that shares a chat with guests should hold nothing you would mind them getting at: no connectors that change things, no private folders.

⚠️ Being an admin of a Telegram group does not make someone an owner, and until a messenger has an owner, everyone there is a guest. **Forward General** (off by default) sends messages in a Telegram group's General to the default bot, so anyone in the group can reach it as a guest.
