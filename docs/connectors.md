# Connectors

A connector gives chosen bots one of your outside accounts, as you: a mailbox, a calendar, your documents, a chat, a task list. A bot uses it when its work needs it ("find last week's invoice", "move Friday's call") and never wakes up because of it. The admin lists the kinds you can connect today, with each one's setup; more will come.

## First, check what is already there

- **A connector** lets a bot look things up and act in an account. It never wakes the bot.
- **An inbox** brings a bot events from outside, such as new mail or an alert: a subscription, not access to an account. See [Inboxes](../inboxes/).
- **A channel** is where you talk with your bots. A chat you talk in is not a chat bots can read, and the other way round. See [Channels](../channels/).
- **Your Claude or ChatGPT account's connectors** (Drive, Jira, GitHub…) work for a bot on that sign-in, as that account, once you turn on **Claude.ai connectors** or **ChatGPT apps** on its **Harness** tab. See [Provider keys](../keys/).
- **An MCP server** for any other service: ask the bot to add one. See [MCP servers](../mcp/).

## How it works

**Per account and per bot.** Each account belongs to one workspace and stays private until you pick bots. Sideworkers get their parent's access; [scouts](../scouts/) never get any. A bot in a family group shouldn't hold your work mailbox: what it reads can end up in that chat.

**Access: Read only, Ask me first or Full access.** One choice per account, made when you connect it and changed under **Bot access**:

- **Read only**: bots look things up; nothing in the account changes.
- **Ask me first**: every change (an email, an edited file, an event, a post, a task) comes to your chat with the bot as a card showing exactly what it will do. Approving applies exactly that; denying changes nothing. A card expires after ten minutes, and restarting Household or changing the account's access cancels the ones waiting. The bot must be in a [channel](../channels/) with you.
- **Full access**: bots make changes in your name without asking.

Choose **Read only** unless changing things is the bot's job, and **Ask me first** for a bot that reads text from strangers. Household never repeats a change whose outcome is unclear: check the account before asking the bot again.

**Household makes the calls, not the VM.** Sign-ins and passwords stay on your computer and in your [backups](../backup/), never in a VM. What a bot reads goes to its AI provider and may be quoted in its chat. See the [Privacy Policy](../../privacy/).

⚠️ **A connector that can change things is a way out the network allowlist doesn't cover.** A bot reading text from strangers can be tricked into sending what it knows to someone, as you. With **Ask me first** you see each change before it happens; with **Full access** you don't.

## Disconnect

Disconnecting cuts the bots off at once, cancels changes waiting for approval and deletes the stored sign-in; what bots already read stays in their history. To revoke fully, also remove Household's access at the provider: its connected apps, or the app password you made for it.
