# Connectors

A connector gives chosen bots one of your outside accounts, as you: for example a mailbox, a Google account, your Slack user or Microsoft To Do. A bot uses it when its work needs it: "find last week's invoice". Per account you choose which bots get it and whether they may change things.

## First, check what is already there

- **A connector** lets a bot look things up and act in an account. It never wakes the bot.
- **An inbox** wakes a bot when something new arrives, but gives no access to the account. To watch a mailbox and answer from it, use both. See [Inboxes](../inboxes/).
- **A channel** is where you talk with your bots. A Slack channel doesn't let a bot read your Slack, and the Slack connector doesn't let anyone talk to a bot. See [Channels](../channels/).
- **Your Claude or ChatGPT account's connectors** (Drive, Jira, GitHub…) work for a bot on that sign-in, as that account, once you turn on **Claude.ai connectors** or **ChatGPT apps** on its **Harness** tab. See [Keys](../keys/).
- **An MCP server** for any other service: ask the bot to add one. See [MCP servers](../mcp/).

## How it works

**Per account and per bot.** Each account belongs to one workspace and stays private until you pick bots. Sideworkers get their parent's access; [scouts](../scouts/) never get any. A bot in a family group shouldn't hold your work mailbox: what it reads can end up in that chat.

**Read only or read and write.** Write lets a bot send, edit and delete in your name. Choose read only unless changing things is the bot's job, above all for a bot that reads mail from strangers.

**Household makes the calls, not the VM.** Sign-ins and passwords stay on your computer and in your [backups](../backup/), never in a VM. What a bot reads goes to its AI provider and may be quoted in its chat. See the [Privacy Policy](../../privacy/).

⚠️ **A write connector is a way out the network allowlist doesn't cover.** A bot reading text from strangers can be tricked, and with write access could send what it knows to someone, as you. Only Email has **Ask me first**, an approval for each outgoing message. Google, Slack and Microsoft To Do act with no per-action approval.

**Disconnecting** cuts the bots off and deletes the stored sign-in; what they read stays in their history.

### Email connector or Google for the same Gmail

- **Email** when you want to approve each outgoing email, when bots should save attachments, or for mail outside Google. Gmail needs an app password for it.
- **Google** when bots also need Drive or Calendar, or you'd rather sign in with Google. With write access, Gmail sends without asking.

You can use both: Google with only Drive and Calendar, and the mailbox as Email with **Ask me first**.

## Email

Bots search and read mail without marking it read, and save attachments. If you allow it, they send, and organize the mailbox (mark, move, trash, draft, folders) without ever deleting for good.

You need IMAP, SMTP to send, and often an app password. For a local bridge such as Proton Mail Bridge, use the password it gives you and paste its exported certificate under **Trusted certificate**, never the private key. Accounts with no password for mail apps (Google or Microsoft sign-in only) aren't supported. Attachments are capped at 8 MB.

### Sending

- **Ask me first** (default): each email comes to your chat with the bot, recipients, text and attachments included. **Approve send** sends exactly that message; **Deny** sends nothing. The bot must be in a [channel](../channels/) with you.
- **Send on their own**: bots send without asking.
- **Don't send**: bots only read.

Household never resends by itself: check Sent before asking again.

**Revoke fully.** Disconnect (it cancels emails waiting for approval), then delete the app password at your provider.

## Google

Bots read Gmail, Drive files (Docs, Sheets, Slides as text) and calendars; with write access they also send and label mail, edit files and change events, all without asking. You pick which of Gmail, Drive and Calendar to share and sign in with Google itself. They can't open Gmail attachments, share files or delete anything for good.

**Revoke fully.** Disconnecting removes the account from Household only. Also remove Household in [Google Account connections](https://myaccount.google.com/connections).

## Slack

Bots act as your Slack user: they search and read the channels and direct messages you can see and download files. With write access they post, edit and delete your messages, upload files and react, with no approval. You approve Household's Slack app (your Slack admins may have to allow it), or use a user token from your own app.

**Revoke fully.** Disconnecting also revokes access at Slack. If Slack can't be reached then, remove the app from your Slack account yourself.

## Microsoft To Do

Bots read your lists, tasks and checklists; with write access they also create, edit, complete and delete them. No Planner, My Day or attachments. Work and school accounts may need an administrator's approval.

To connect, enter the code Household shows on Microsoft's page and approve. Only enter a code you just requested in your own Household: a code someone sends you is an attempt to take your account.

**Revoke fully.** Disconnecting doesn't withdraw the permission at Microsoft. Remove Household in your Microsoft account's app permissions, or your organization's My Apps page.
