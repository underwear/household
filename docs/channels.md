# Channels

A channel is where you talk to a workspace's bots: its connection to a messenger, such as a Telegram group with a topic per bot, or your Slack DM with an app of your own. You write there, bots answer there, and that is where they ask you to approve things. One channel can hold several bots, and one bot can be in several channels.

## When it helps

- **One topic per bot.** In a Telegram group, the cooking bot's menus and the coding bot's builds stay in topics of their own.
- **A bot for the family.** You and your partner give it orders; the rest of the family can talk to it as guests.
- **Where you already are.** Work bots in Slack, personal ones in Telegram.

## First, check what is already there

- **A channel** is for talking. It sees only the chat you connect.
- **A [connector](../connectors/)** lets bots read and act in your accounts: mail, calendar, documents, your Slack workspace. A Slack channel is not a Slack connector: the channel's app sees only its DM with you.
- **An [inbox](../inboxes/)** wakes a bot on its own: new mail, an alert, a feed.

## Owners and guests

Bots obey owners only: people listed for the workspace by their messenger id (a Telegram user id, a Slack member ID). Everyone else who writes in a channel is a guest.

**What Household enforces.** Only an owner can approve a bot's requests (network, secrets, shared folders, scout runs, previews), stop a bot, or hand over a secret with `/secret`.

**What the bot decides.** A guest's message still reaches the bot, marked as a guest's. The bot is told to answer guests or ask you, never to carry out their orders as yours. That is the model's judgement, not a wall: a guest's message is untrusted text, like a web page, and can talk the bot round the same way. So a bot that shares a chat with guests should hold nothing you would mind a guest getting at: no write connectors, no private folders.

Also keep in mind:

- **Everyone in a group sees what bots post there.** Bots are told the chat is a group.
- **A bot is one bot in every channel.** It carries one memory and one conversation, so what you told it in your private chat can come up in a group. Give a group its own bot.
- **Owners are per platform, not per channel.** One Telegram user id makes you an owner in every Telegram channel of the workspace. A person on two messengers is two entries.
- **Private chats and Slack DMs hold only you.** Guests appear in Telegram groups. Someone who finds your Telegram bot and writes to it privately reaches no bot: only the chats you connect do.

⚠️ Being an admin of a Telegram group does not make someone an owner. Only the ids under **Owners** count, and until a platform has an owner, everyone there is a guest.

Owners live under **Workspace → Channels → Owners**. The guided and Slack setups add you; add yourself when you add a Telegram channel by hand.

## How a channel works

- **It belongs to one workspace.** The Telegram bot or Slack app you connect serves that workspace only.
- **Bots share it,** each signing its replies. The **default** bot gets every message not addressed to another; a bot alone is its channel's default.
- **Address a bot by name.** Start with its name or alias (`Chef, plan dinner`) or reply to its message. Where bots have their own topics or threads, write there.
- **Stop a bot** with **Stop** on its progress message, or `/stop` (`!stop` in Slack).
- **Helpers follow.** [Sideworkers](../sideworkers/) and [scouts](../scouts/) a bot starts from a channel report there, in their own topic or thread.
- **The messenger carries everything.** Telegram, Slack or whichever messenger you use holds every message, as with any chat.

## Choose a channel

| Kind | Who is in it | Each bot gets | Outside Household | Pick it for |
| --- | --- | --- | --- | --- |
| **Telegram group with topics** (recommended) | you, and anyone you add | its own topic | a group with Topics, your bot as admin | several bots, or other people |
| **Telegram private chat, threaded** (beta) | you | its own thread | Threaded Mode in BotFather | several bots, just you |
| **Telegram private chat, plain** | you | a share of one conversation | nothing beyond the bot | one bot, or one stream for all |
| **Slack DM** | you | the default in Messages, others in threads | a Slack app from the manifest | you live in Slack |

Start with a group with topics, even alone: every bot and helper gets a topic, helpers' topics go when they finish, and you can add people later. One Telegram bot can serve a private chat and a group in one workspace; connect each chat in one mode only.

## What you decide

- **Which bots, and the default.** Set it on the channel or on the bot's **Channels** tab. Put a bot only where its audience fits; a bot in no channel hears no one.
- **Forward General** (Telegram groups and threaded chats). Off by default, and General is ignored. On, each message in General goes to the default bot's topic, or to the bot it names. In a group, everyone can then reach the bot from General, as a guest.

## Add a channel

**Workspace → Channels → + Add channel.** The first one usually comes with the guided setup (`house onboard`, or **/setup** in the admin), which also makes you an owner; see [Quick start](../start/). A channel's chat cannot change: another chat is another channel.

## Telegram

**What bots can do.** Each bot reads what is written in its own topic or thread, or, in a plain chat, what is addressed to it (the default bot gets the rest); topics you create yourself belong to the default bot, which can also open new ones. Bots reply with formatting, buttons and files. In private chats they also send longer reports with headings, lists and tables, and small interactive widgets, such as a checklist you tap. A widget has no internet access, and a tap reaches the bot as an action, never as your approval.

**Set it up in Telegram:**

1. In [@BotFather](https://t.me/BotFather), send `/newbot`, choose a name and username, and copy the token. This one Telegram bot speaks for all the workspace's bots.
2. **For a group:** create it, turn on **Topics**, and make your bot an admin with **Manage topics** and **Delete messages**, so it can open and delete topics and remove your `/secret` messages. The guided setup finds the group and checks both.
3. **For a threaded private chat:** in BotFather's Mini App, open your bot → **Bot Settings → Threads Settings**, turn on **Threaded Mode**, and stop users from creating threads: Household creates them.
4. **For a plain private chat:** press **Start** in your bot's chat.

**Limits.** Files up to 20 MB, Telegram's limit for bots. Threaded Mode is in beta at Telegram and looks different from one app to another.

**Revoke fully.** Remove the channel in **Workspace → Channels**. In BotFather, `/revoke` the token or `/deletebot`, and remove the bot from the group. Remove owner entries you no longer need.

## Slack

**What bots can do.** Read and write in your DM with the app, nothing else: the default bot in the DM's **Messages**, other bots and helpers in threads. The app asks Slack only for DM, reaction and file permissions, so it cannot read your channels. It connects by Socket Mode (no public address or tunnel), and its tokens stay on your machine, never in a bot.

**What you decide.** The bots and the default. The member ID you give becomes an owner of the workspace.

**Set it up in Slack:**

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app from Household's [manifest](https://github.com/underwear/household/blob/main/src/channel-adapters/slack/manifest.json) and install it in your Slack workspace.
2. Copy the **Bot User OAuth Token** (`xoxb-…`, under **OAuth & Permissions**) and create an app-level token (`xapp-…`, under **Basic Information → App-Level Tokens**) with only `connections:write`.
3. Copy your member ID: your profile → **More** → **Copy member ID**.

Then add the channel as **Slack Bot DM**; Household finds your DM with the app without sending anything.

**Limits.** Bot DMs only: no Slack channels, group chats or Slack Connect. One app serves one Slack workspace. Slack keeps slash commands, so type `!stop` and `!secret`, and since a bot cannot delete your messages, delete your `!secret` message yourself. Slack has no silent messages, so progress updates follow your notification settings. Threads stay as history when a bot or helper is removed. Files go up to 20 MB each way; long replies are split.

**Revoke fully.** Remove the channel, then delete the app at api.slack.com/apps, which voids both tokens. Remove the Slack owner entry if you no longer need it.

## Put it to use

A family group: a Telegram group with topics, you and your partner as owners, the rest of the family as guests. Give its house bot the shared Microsoft To Do list through a [connector](../connectors/), so anyone can ask what is on it. Since turning down guests' orders is the bot's judgement, give it nothing riskier than a shopping list.

## From the terminal

`house channel add <workspace> --kind telegram-group --chat <id> --bots a,b --default a` (also `telegram-private`, `telegram-dm`, `slack-private`; without `--token`, the token is read from standard input), `house channel set|rm`, `house owner add <workspace> telegram <user id>`.

## Related

- [Connectors](../connectors/): your accounts, as opposed to your chats
- [Network and secrets](../network/): what owners approve in the chat
- [Bots](../bots/): a bot's **Channels** tab
