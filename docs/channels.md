# Channels

A channel is where you talk to your bots: a workspace's connection to a messenger, such as your private chat with a Telegram bot or a Slack DM. You write there, your bots answer there, and that is where they ask you to approve things. One channel can hold several bots, and one bot can be in several channels.

A channel is for talking. To let bots read your mail, calendar or Slack messages, use a [connector](../connectors/) instead.

## How a channel works

- **It belongs to one workspace.** The messenger bot or app you connect (a Telegram bot, a Slack app) serves that workspace only.
- **Bots share it.** Put as many of the workspace's bots in a channel as you like. Each one signs its replies with its name.
- **One bot is the default.** With two or more bots, you choose a **Default**: it gets every message that is not addressed to a particular bot. A bot alone in a channel is its default.
- **Address a bot by name.** Start a message with a bot's name or alias (`Chef, plan dinner`), or reply to one of its messages, and that bot answers. In channels with a thread or topic per bot, just write in its thread.
- **Stop a bot.** Every bot shows its progress in one updating message with a **Stop** button. You can also send `/stop` (in Slack, `!stop`).
- **Helpers follow.** [Sideworkers](../sideworkers/) and [scouts](../scouts/) a bot starts from a channel report in that channel, in their own thread or topic where the messenger has them.

## Owners

Bots obey owners only. An owner is a person, known by their id on a messenger. Everyone else who writes in a channel is a guest: a bot may talk with a guest, but it never carries out a guest's orders, and a guest cannot approve anything.

Owners are per platform, not per channel. One Telegram user id makes you the owner in every Telegram channel of the workspace.

To add one, go to **Workspace → Channels**, scroll to **Owners** and press **+ Add owner**. Choose the **Platform**, enter the id and, if you like, a **Note** (only you see it; it is never told to a bot). Removing an owner makes them a guest.

The guided setup and the Slack setup add you as an owner for you. When you add a Telegram channel by hand, add yourself under **Owners** too. Until a platform has an owner, everyone there is a guest.

From the command line: `house owner add <workspace> telegram <your user id>`.

⚠️ Being an admin of a Telegram group does not make someone an owner. Only the ids under **Owners** count.

## Add a channel

The first channel usually comes with the guided setup: `house onboard` in a terminal, or **/setup** in the admin. It asks which messenger you want, shows how to make the bot or app, checks it, and makes you the owner. See [Quick start](../start/).

To add another channel to a workspace:

1. Go to **Workspace → Channels → + Add channel**.
2. Pick the kind and press **Next**. Each kind has its own fields; see the messenger's section below.
3. Fill in the fields, then optionally a **Name**, the **Bots** in it, the **Default** and a **Note**.
4. Press **Add channel**.

A channel with a problem (a token that is not a bot's, for example) shows the reason in red on its row. **Edit** changes its token, name, bots and default; its chat cannot change, since another chat is another channel. **Remove** makes the workspace leave the chat.

## Put bots in a channel

You can do it from either side:

- **From the channel.** **Workspace → Channels**, then **Edit** on the channel. Tick the **Bots** and choose the **Default**.
- **From the bot.** Open the bot and go to its **Channels** tab. It lists every channel of the workspace with a switch: turn it on to put the bot in, off to take it out. Where the bot shares a channel, **Make default** gives it the unaddressed messages.

A new bot can join channels right away from the **Channels** group of the **+ Add bot** dialog. A bot in no channel hears no one.

## Telegram

Household talks to Telegram through a bot you make yourself with [@BotFather](https://t.me/BotFather): send it `/newbot`, choose a name and a username, and it gives you a token. That one Telegram bot is the face of all your Household bots in the workspace.

There are three kinds of Telegram channel. The same Telegram bot can serve a private chat and a group in one workspace, but connect a given chat in only one mode.

### A group with a topic per bot

**Telegram Bot Group (topics)**. Recommended. A private group of yours with Topics on, where each bot has its own topic.

1. Create a group (or open yours) and turn on **Topics** in its settings.
2. Add your Telegram bot and make it an admin with **Manage topics** and **Delete messages**.
3. In Household, add the channel with the **Bot token** and the **Group chat id**, a negative number starting with `-100`. To find it, open [Telegram Web](https://web.telegram.org/a), open the group, and copy everything after `#` in the address, minus sign included.

The guided setup finds the group by itself once the bot is in it, and checks that Topics are on and the bot has both rights.

How it behaves:

- Each bot gets its own topic. Sideworkers and scouts get topics of their own, deleted when they are done.
- Topics you create yourself in Telegram belong to the default bot. The default bot can also open new topics when it needs them.
- Everyone in the group sees the conversation and can write to the bots, as a guest unless they are an owner.
- Messages in **General** are ignored by default. Turn on **Forward General to the default bot** in the channel's settings to change that: each message in General then goes to the default bot's topic, and the bot answers there. A message that names another bot goes to that bot's topic. Everyone in the group can then reach the bot from General.

### A private chat with a thread per bot

**Telegram Bot DM (threaded)**. Beta. Your private chat with the Telegram bot, using Telegram's bot Threaded Mode: a thread per bot, sideworker and scout.

1. In BotFather's Mini App (the menu button), open your bot → **Bot Settings → Threads Settings**.
2. Turn **Threaded Mode** on, and stop users from creating threads: Household creates them.
3. Add the channel with the **Bot token** and your Telegram user id as the **Chat id**.

**Forward General to the default bot** works here too, and General is ignored without it. Threaded Mode is still in beta at Telegram, so threads may look different from one Telegram app to another.

### One plain private chat

**Telegram Bot DM**. An ordinary private chat, no threads. Every bot answers in the same conversation: address one by name or reply to its message, and anything else goes to the default bot. Threaded Mode is not needed.

Add the channel with the **Bot token** and your Telegram user id as the **Chat id**, then press **Start** in the bot's chat in Telegram.

To find your Telegram user id, ask [@userinfobot](https://t.me/userinfobot).

### What bots can do in Telegram

- Reply with formatting, buttons and files. In private chats, also longer reports with headings, lists and tables.
- In private chats, show a small interactive widget, such as a counter or a checklist you tap right in the chat, if your Telegram app supports widgets. A widget has no internet access. A tap reaches the bot as an action, never as your approval.
- Files you send can be up to 20 MB, a Telegram limit for bots.

## Slack

A Slack channel is a direct message with a Slack app of yours, in your Slack workspace. It connects through Slack's Socket Mode, so you need no public address or tunnel. The app's tokens stay on your machine and never reach a bot.

1. **Create the app.** At [api.slack.com/apps](https://api.slack.com/apps), create an app from Household's [manifest](https://github.com/underwear/household/blob/main/src/channel-adapters/slack/manifest.json) and install it in your workspace. It asks only for DM, reaction and file permissions: it cannot read your channels.
2. **Copy two tokens.** The **Bot User OAuth Token** (`xoxb-…`, under **OAuth & Permissions**), and an app-level token (`xapp-…`, under **Basic Information → App-Level Tokens**) with only `connections:write`.
3. **Add the channel.** **Workspace → Channels → + Add channel → Slack Bot DM**. Paste both tokens, then give **Your member ID** (in Slack: your profile → **More** → **Copy member ID**) and press **Find my bot DM**. Household finds your DM with the app without sending anything. Then name the channel, pick its bots and press **Connect Slack**.

The account you give becomes an owner of the workspace: it can command the bots and approve their requests.

How it behaves:

- The default bot answers right in the DM's **Messages**. Start a message with another bot's name or alias to reach it; other bots, sideworkers and scouts work in their own threads.
- Slack keeps slash commands for itself, so type `!stop` and `!secret` instead of `/stop` and `/secret`.
- **Open in Slack** on the channel's row takes you to the DM. `house doctor` checks the app and the DM.

Limits:

- Bot DMs only: no Slack channels or group chats, no Slack Connect.
- One Slack app serves one Slack workspace. For another, create another app.
- Slack has no silent messages, so progress updates follow your Slack notification settings.
- Threads stay when a bot or helper is removed; they remain as history.
- A bot cannot delete your messages in Slack. After `!secret`, delete your message yourself.
- Files go up to 20 MB each way.
- Long replies are split into several messages.

## From the command line

Everything above can also be done with `house`:

- `house channel add <workspace> --kind telegram-group --chat <id> --bots a,b --default a` adds a channel. Kinds: `telegram-dm`, `telegram-private`, `telegram-group`, `slack-private`. Leave out `--token` and it is read from standard input, so it stays out of your shell history.
- `house channel set <workspace> <chat> --bots a,b --default a --forward-general on` changes one.
- `house channel rm <workspace> <chat>` removes one.
