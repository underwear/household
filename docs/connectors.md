# Connectors

A connector gives chosen bots one of your outside accounts, as you: a mailbox, a Google account, your Slack user, Microsoft To Do. A bot reaches into it when its work needs it: "find last week's invoice", "what did the team decide in #launch?", "add milk to the shopping list". You choose per account whether bots may only read or also change things, and which bots get it.

## When it helps

- A bot answers from your mail, Drive or Slack history.
- A bot drafts replies and sends each one only after you approve it.
- A family bot keeps the shared shopping list in Microsoft To Do.

## First, check what is already there

- **A connector** lets a bot look things up and act in an account when its work needs it. It never wakes the bot.
- **An inbox** wakes a bot when something new arrives, but gives it no access to the account. To watch a mailbox and answer from it, use both. See [Inboxes](../inboxes/).
- **A channel** is where you talk with your bots. A Slack channel doesn't let a bot read your Slack, and the Slack connector doesn't let anyone talk to a bot. See [Channels](../channels/).
- **Your Claude or ChatGPT account's connectors.** A bot on a Claude or ChatGPT sign-in can use the connectors or apps set up in that account (Drive, Jira, GitHub…), as that account. Turn on **Claude.ai connectors** or **ChatGPT apps** on the bot's **Harness** tab. See [Keys](../keys/).
- **An MCP server** for any other service: ask the bot to add one. It runs in the bot's VM, behind the network allowlist. See [MCP servers](../mcp/).

## How it works

**Access per account and per bot.** Each account has its own permissions and bots, within one workspace; with none picked, it stays private. A bot taken off the list loses access from its next request. Sideworkers get their parent's access. Scouts never get any: they see nothing of the bot, its accounts included.

**Read only or read and write.** Read only: bots search and read, and nothing changes. Read and write: a bot sends, edits and deletes in your name.

**Household makes the calls, not the VM.** Sign-ins and passwords stay on your computer (and in your [backups](../backup/)) and never enter a VM.

⚠️ **A write connector is a way out the network allowlist doesn't cover.** A bot reading text from strangers can be tricked by it, and with write access could send what it knows to someone, as you. Only Email has **Ask me first**, an approval for each outgoing message. Google, Slack and Microsoft To Do act with no per-action approval.

**What your AI provider sees.** What a bot reads goes to its AI provider (Anthropic or OpenAI), and may be quoted in its chat, which the messenger and everyone in it see. See the [Privacy Policy](../../privacy/).

**Disconnect and reconnect.** **Disconnect** cuts the bots off and removes the stored sign-in; what they already read stays in their history and backups. **Reconnect** renews an expired or revoked sign-in and changes a Google, Slack or Microsoft account's permissions; email has **Settings** instead.

## What you decide

- **Read only, unless changing things is the bot's job**, above all for a bot that reads mail from strangers.
- **Which bots.** A bot in a family group shouldn't hold your work mailbox: what it reads can end up in that chat.

### Email connector or Google for the same Gmail

- **Email** when you want to approve each outgoing email, when bots should save attachments, or for mail outside Google. Gmail needs an app password for it.
- **Google** when bots also need Drive or Calendar, or you'd rather sign in with Google. With write access, Gmail sends without asking.

You can use both: Google with only Drive and Calendar, and the mailbox as Email with **Ask me first**.

## Email

**What bots can do.** Search and read mail (without marking it read) and save attachments into their files. If you allow it, send new mail and replies with attachments, and organize the mailbox: mark, move, put in Trash, save drafts, manage folders. Nothing is ever deleted for good.

**What you decide.** Any mailbox with IMAP works, plus SMTP for sending. Setup runs **Account** (incoming server; **Next** checks the sign-in) → **Sending** (outgoing server, guessed from the incoming one; **Next** checks it, or **Skip for now** to read only and add it later in the mailbox's **Settings → Sending**) → **Permissions** → **Bots**. **Organize the mailbox** is a separate switch and never allows sending.

### Sending

- **Ask me first** (default): each email comes to your chat with the bot, recipients, text and attachments included. **Approve send** sends exactly that message; **Deny** sends nothing. To change it, tell the bot. The bot must be in a [channel](../channels/) with you.
- **Send on their own**: bots send without asking.
- **Don't send**: bots only read; the outgoing server stays saved.

The account's row shows emails waiting for your OK and, for a week, ones that weren't sent or may not have gone out. Household never resends by itself: check Sent before asking again.

**Before you start.**

1. Look up your provider's IMAP and SMTP servers. If it doesn't accept your normal password from other apps, create an app password in its security settings.
2. For a local bridge such as Proton Mail Bridge, run it on Household's computer, use the password it gives you, and export its certificate. Under **Trusted certificate**, paste it or choose the file: the certificate, never the private key.

**Limits.** Accounts that only allow signing in through Google or Microsoft, with no password for mail apps, aren't supported. Messages over 12 MB can't be opened; attachments are capped at 8 MB per saved file and per sent email. An approval request expires after ten minutes, and is cancelled if you change the account's settings or bot access, disconnect it or restart Household. Up to 20 mailboxes per workspace.

**Revoke fully.** Disconnect (it cancels emails waiting for approval), then delete the app password at your provider.

## Google

**What bots can do.** Read only: search and read Gmail; find files and read Docs, Sheets (the first sheet) and Slides as text; read calendars and events. Read and write adds sending, drafting, labelling and trashing mail; creating, editing and trashing files; creating, changing and deleting events.

**What you decide.** Read only or read and write, which of Gmail, Drive and Calendar to share, and the bots. A write permission you untick on Google's screen leaves that service read only.

**Setup.** You sign in with Google itself, no app password. If Household says Google isn't set up on this host, you're on a source build: install an official release.

**Limits.** With write access, bots send mail and change files and events without asking. Bots don't open Gmail attachments, can't share files, and can't delete mail or files for good: they go to Google's Trash.

**Revoke fully.** Disconnecting removes the account from Household only. Also remove Household in [Google Account connections](https://myaccount.google.com/connections).

## Slack

**What bots can do.** Act as your Slack user. Read only: search and read the channels and direct messages you can see, look up people, user groups and reactions, and download files. Read and write adds posting, editing and deleting your messages, uploading files, reacting, opening direct messages and marking conversations read.

**What you decide.** Read only or read and write, and the bots. Posts go out under your name with no approval.

**Setup.** It uses Household's own Slack app:

1. Press **Open Slack** in Household, choose your Slack workspace and approve. Its admins may have to allow the app.
2. Slack sends you to a page on agents-household.dev. Copy the connection result there.
3. Paste it into Household within ten minutes.

It works with Household on a server too. For a Slack app of your own, choose **Use a user token instead**.

**Limits.** Files up to 50 MB each way; one a bot uploads without naming a conversation stays private to you. A message a bot deletes is gone. An account connected before Household 0.10.6 can do less: reconnect it to get the rest (with your own app, add the permissions its steps list first).

**Revoke fully.** Disconnecting also revokes access at Slack. If Slack can't be reached then, remove the app from your Slack account yourself.

## Microsoft To Do

**What bots can do.** Read only: your lists, tasks and checklists. Read and write: also create, edit, complete and delete lists, tasks and checklist items, with notes, due dates, reminders and repeats.

**What you decide.** Read only or read and write, and the bots. Personal, work and school accounts work.

**Setup.**

1. Press **Open Microsoft**, enter the code Household shows and approve, in any browser on any device.
2. Keep Household's dialog open: it connects by itself.

Only enter a code you just requested in your own Household; a code someone sends you is an attempt to take your account. Work and school accounts may need an administrator's approval.

**Limits.** To Do only: no Planner, My Day or attachments. No approval per action.

**Revoke fully.** Disconnecting doesn't withdraw the permission at Microsoft. Remove Household in your Microsoft account's app permissions, or your organization's My Apps page.

## Put it to use

**A week planner for the family.** Give the family group's bot Google with only Calendar, read only, and Microsoft To Do, read and write. A Monday 8:00 [scheduled task](../schedules/): "post this week's events and what's left on the shopping list". During the week an owner says "add oat milk" in the group, and the list changes.

## Related

- [Inboxes](../inboxes/): wake bots when something new arrives.
- [Network and secrets](../network/): the allowlist connectors sit outside of.
- [MCP servers](../mcp/): any other service.
