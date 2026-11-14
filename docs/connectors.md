# Connectors

A connector lets your bots use one of your outside accounts — a mailbox, Google, Slack, Microsoft To Do — as you. For each account you choose what bots may do there and which bots may use it at all. A bot then reaches into the account when its work needs it: "find last week's invoice", "what did the team decide in #launch?", "add milk to my shopping list".

[Channels](../channels/) are for talking with your bots, and [inboxes](../inboxes/) wake them when something new arrives. A connector does neither: it only gives chosen bots access to an account.

## Add a connector

Open **Workspace → Connectors → + Add connector**, pick what to connect and press **Next**. Each kind of account has its own short setup, described in its section below. All of them ask two things:

- **What bots may do**: read only, or also change things. Some connectors offer finer choices, such as whether bots may send email.
- **Which bots** may use the account. Picking none is fine: the account stays private until you grant access.

You can connect several accounts of one kind, say a personal and a work mailbox; each has its own permissions and bots. A connection belongs to one workspace, and bots of other workspaces never see it.

## Bot access

Each account's row shows the bots that may use it. To change them, press **Bot access**, switch bots on or off, and press **Save access**. A bot that loses access stops at once, even in the middle of a read.

**Sideworkers** get their parent bot's access. **Scouts** never get any. A disabled bot can't use connectors until you enable it again.

## Read only or read and write

With read access, bots search and read, and nothing in the account changes. With write access, a bot acts as you: it sends messages, edits files or changes events in your name.

Bots treat what they read as outside content, not your instructions. Still, a bot that reads mail from strangers and may send mail can be targeted by them. For email, **Ask me first** lets you approve each message. Other connectors have no per-action approval, so give write access only to bots you trust with that account.

## Reconnect and settings

Each row shows **Connected** or **Reconnect required**; the latter means the sign-in was revoked or expired. **Reconnect** signs in again with the account's current choices, and what you pick replaces them. It is also how you change a Google, Slack or Microsoft account's permissions. An email account has **Settings** instead: the same steps as tabs (**Account**, **Sending**, **Permissions**, **Bots**), and **Save** checks the connection again.

## Disconnect

Press **Disconnect** on the row and confirm. Its bots lose access right away and the saved sign-in is removed from your computer; other accounts stay connected. What bots already read stays in their history, chats and backups. Whether the provider also forgets Household depends on the connector; each section below says what to do.

## Privacy and security

- **Credentials stay on your computer**, in Household's private storage and its backups. They never enter a bot's VM.
- **What a bot reads goes to its AI provider** (Anthropic or OpenAI), like anything else it works on, and may be quoted in its chat. Choose bot access with the chat's audience in mind.
- **Bots act only through Household**, and only in the ways the connector offers. No connector can permanently delete your mail or files.

See also the [Privacy Policy](../../privacy/).

## Email

Connect any mailbox that offers IMAP for reading and, if bots should send, SMTP for sending. That covers most providers and your own mail server. Bots can:

- search mail by sender, recipient, subject, text, date or unread, and read it — reading doesn't mark it as read;
- save attachments into their files;
- reply in a thread or write new mail with attachments, if you allow sending;
- organize the mailbox, if you allow it: mark read or flagged, move, put in Trash, save drafts, manage folders. Nothing is ever deleted for good.

Email needs Python 3.9 or later on Household's computer. Accounts that only allow signing in through Google or Microsoft, with no password for mail apps, are not supported.

### Connect a mailbox

Your provider's help pages list its IMAP and SMTP servers, ports and security; have them at hand.

1. **Workspace → Connectors → + Add connector → Email.**
2. **Account.** Enter the email address and the incoming (IMAP) server: its host, port, and **SSL/TLS** or **STARTTLS**. Both encrypt and check the server's certificate; there is never an unencrypted fallback. Leave the username empty if it is your email address, and enter the password. Press **Next**: Household signs in to check the account before you go on.
3. **Sending.** Enter the outgoing (SMTP) server, which Household guesses from the incoming one, and press **Next** to check it too. Or press **Skip for now**: bots will only read, and you can set up sending later.
4. **Permissions.** Choose how bots may send (see [Sending](#sending)) and whether they may **Organize the mailbox**.
5. **Bots.** Pick the bots, then press **Connect**.

Tip: many providers don't accept your normal password from other apps and want an app password, which you create in your account's security settings and can revoke any time. A local mail bridge such as Proton Mail Bridge runs on the same computer as Household, gives you its own password, and uses its own certificate: export it from the bridge and, under **Trusted certificate**, paste it or **Choose file…** (the certificate file, never the private key).

### Sending

Sending signs in like incoming mail; turn off **Same sign-in as incoming mail** to give it its own username and password. You also set the sender name recipients see and, if your provider doesn't keep a copy of sent mail by itself, a folder for Household to save one.

On **Permissions**, choose how bots may send:

- **Ask me first** (default): each email comes to your chat with the bot. Nothing goes out until you approve it.
- **Send on their own**: bots send from this address without asking.
- **Don't send**: bots only read; the outgoing server stays saved for later.

To add sending to a mailbox connected without it, or to remove it, open its **Settings → Sending**.

**Organize the mailbox** is a separate switch. It does not allow sending.

### Approving an email

With **Ask me first**, the bot posts an **Approve outgoing email** card in its chat, so it must be in a [channel](../channels/) with you. The card shows the sender, To, Cc, Bcc, subject, full text, and names and sizes of attachments.

- **Approve send** sends exactly that message; the bot can't change it afterwards.
- **Deny** sends nothing.

To change something, tell the bot; it asks again. A request expires after ten minutes, and is cancelled if you change the account's settings or bot access, disconnect it, or restart Household. An email on its way can't be recalled.

The account's row shows when an email waits for your OK and in which chat. For a week it also notes emails that weren't sent (for example because the bot is in no chat with you) and ones that **may not have gone out** because the server stopped answering. Household never resends by itself: check Sent before asking the bot again.

Limits: messages over 12 MB can't be opened; attachments are capped at 8 MB per file saved and per email sent; up to 20 mailboxes per workspace.

To fully revoke access after disconnecting, also delete the app password at your provider.

## Google

Connect a Google account with Gmail, Drive and Calendar. You sign in with Google itself; no app password needed.

| Service | Read only | Read and write adds |
| --- | --- | --- |
| Gmail | Search and read email | Send, draft, label and trash email |
| Drive | Find files and read documents | Create, edit and trash files |
| Calendar | Read calendars and events | Create, change and delete events |

Bots read Google Docs, Sheets (the first sheet) and Slides as text. Mail and files a bot removes go to Google's Trash. Bots can't share files with anyone.

1. **Workspace → Connectors → + Add connector → Google.**
2. Choose **Access**, switch on the **Services** you want, and pick bots under **Bot access**.
3. Press **Continue to Google**, choose the account and allow access. Google sends you back to Connectors.

If you untick a write permission on Google's screen, that service stays readable, and the row says which services are writable. If the dialog says **Google isn't set up on this host**, you're on a source build: install an official release.

Google has no owner approvals: with write access, bots send mail and change files and events without asking. To approve each email, connect the mailbox as [Email](#email) with **Ask me first** instead.

Disconnecting removes the account from Household only. To revoke access at Google too, remove Household in [Google Account connections](https://myaccount.google.com/connections).

## Slack

Connect your Slack user so bots can search and read Slack as you when they need context. Nobody messages your bots here; to talk with them in Slack, add a [channel](../channels/).

- **Read only**: bots search and read what your Slack user can see — channels, direct and group messages, people. Files show details and a text preview, not full downloads.
- **Read and send**: bots can also post messages and thread replies as you, without asking.

1. **Workspace → Connectors → + Add connector → Slack.**
2. Choose access, pick bots under **Bot access**, and press **Continue to Slack**.
3. Press **Open Slack**, choose your Slack workspace and approve. You use Household's own Slack app; your workspace's admins may have to allow it.
4. Slack sends you to a page on agents-household.dev. Copy the connection result there.
5. Paste it into **Connection result** within ten minutes and press **Connect**.

This works when Household runs on a server, too. The result's one-time code is useless without a key that stays on your Household computer. Prefer your own Slack app? Choose **Use a user token instead**; **Get a user token** lists the steps.

Disconnecting also revokes the token at Slack. If Slack can't be reached then, remove the app from your Slack account yourself.

## Microsoft To Do

Connect a personal, work or school Microsoft account.

- **Read only**: bots read your lists, tasks and checklists.
- **Read and write**: bots can also create, edit, complete and delete lists, tasks and checklist items, with notes, due dates, reminders and repeats.

1. **Workspace → Connectors → + Add connector → Microsoft To Do.**
2. Choose access, pick bots under **Bot access**, and press **Prepare Microsoft sign-in**.
3. Press **Open Microsoft**, enter the code Household shows and approve. Any browser on any device works.
4. Keep the dialog open: it connects by itself after you approve. If the code expires, press **Start again**.

Only enter a code you just requested in your own Household. Work and school accounts may need an administrator's approval. Planner, My Day and attachments aren't available.

Disconnecting doesn't withdraw the permission at Microsoft: remove Household in your Microsoft account's app permissions, or your organization's My Apps page.

## Claude and ChatGPT account connectors

A bot on a key signed in to Claude or ChatGPT can also use the connectors set up in that claude.ai account, or the apps in that ChatGPT account (Drive, Jira, GitHub…), as that account. They aren't managed on the Connectors page: switch on **Claude.ai connectors** or **ChatGPT apps** on the bot's **Harness** tab. Off by default; sideworkers get them too, scouts never. A pasted token or API key has none. See [Keys](../keys/).

For anything else, a bot can add an MCP server to its own harness: see [MCP](../mcp/).
