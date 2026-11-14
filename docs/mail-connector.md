# Mail connector

Connect an IMAP mailbox and optional SMTP sending from **Workspace → Connectors → Add connector → Mail**. Bots can search existing mail, read messages, download attachments and reply with the permissions you choose. An [inbox](../inboxes/) separately watches for new mail and delivers events; connecting mail does not automatically wake a bot or subscribe it to incoming messages.

## Connect an account

Household needs Python 3.9+ on its host. Enter the account address, IMAP server, port, username and password or app password. Choose **TLS** for encryption from the start, or **STARTTLS** for a required upgrade before login. Both verify the certificate, hostname and expiry; neither falls back to plaintext. OAuth-only accounts are not supported.

For **Proton Bridge**, run Bridge on the Household host and copy the connection settings and generated password from Bridge, not your Proton account password. IMAP is commonly `127.0.0.1:1143` with STARTTLS; use the actual settings shown for your account. Export Bridge's TLS certificate from **Settings → Advanced settings → Export TLS certificates** and paste the PEM certificate into the endpoint's trusted certificate field. Never paste its private key. Configure SMTP separately with its own port, security mode and certificate. Replace the certificate if Bridge regenerates it. See [Bridge settings](https://proton.me/support/comprehensive-guide-to-bridge-settings).

Choose a sending policy:

- **No sending**: no SMTP connection. Bots can read mail.
- **Approve each outgoing email**: the send tool waits before SMTP; you approve or deny the exact outgoing message.
- **Send automatically**: selected bots can send without a per-message prompt.

**Allow mailbox changes** independently permits flags, moving messages, saving drafts and creating or renaming folders. It does not grant sending. Select the bots that may use the connection; no selection keeps it private. Sideworkers inherit their enabled parent's access; scouts receive none.

**Test and save** authenticates without sending or changing messages. Passwords stay in private host state and never enter the bot's VM or tool results. Mail content read by a bot goes to its AI provider and may appear in chat. An approval displays its complete message in the requesting bot's chat and in Connectors; choose bot access with that audience in mind.

## Approve or withdraw a send

`household_connectors_mail_send_message` takes recipients, subject, text, optional attachments and an optional original message reference for a threaded reply. Household fixes the sender, Date and Message-ID and snapshots attachment bytes before asking you. The owner card and **Connectors → Outgoing mail → Review** show To, Cc, Bcc, body and attachment names and sizes. The approval lists the files; it does not upload copies to the chat or offer a download.

**Approve and send** authorizes exactly that snapshot. **Deny** ends the call without sending. Changing the text, recipients or attachments requires a new request and approval. Requests expire after ten minutes; stopping the original call, losing account access, editing connection settings or restarting Household cancels requests that have not begun submission.

A bot can use `household_connectors_mail_cancel_send` with the request ID obtained through `household_connectors_mail_send_status` to withdraw its own pending request. Once SMTP submission starts, cancellation returns that it is too late; this is not email recall. Approval and withdrawal race through one state transition, so a withdrawn request cannot later be approved.

Each send requires a stable `clientRequestId`. Repeating the same ID within the same bot and connection does not submit again; changing the input under that ID is rejected. Full message history retains up to 100 completed requests, pruning records older than 30 days on subsequent send activity, while small used-ID records persist to prevent replay after history expires. Pending requests appear first.

If the server's final acknowledgement is lost, the result is **unknown**: the message may have been accepted. Household never retries it automatically. Inspect Sent before considering another request. **Sent** means SMTP accepted the message, not that the recipient read it or that downstream delivery is guaranteed.

The optional **Save an additional Sent copy to** setting performs a separate IMAP append after SMTP acceptance. Leave it empty when the server already saves sent mail, as Proton Bridge normally does. A failed append is reported as **sent-copy-failed**; the delivered message is never resent to repair the copy.

## Agent tools and mailbox operations

All tool names use the `household_connectors_mail_` prefix:

| Tool suffix | Purpose |
| --- | --- |
| `accounts` | List accounts shared with this bot and their permissions. |
| `operations` | Discover allowed mailbox operations and parameter schemas. |
| `request` | Run a mailbox operation using its connection ID. |
| `send_message` | Submit one immutable outgoing message, waiting for approval when required. |
| `send_status` | Inspect this bot's send requests and request IDs. |
| `cancel_send` | Withdraw this bot's request before submission. |

Read operations list mailboxes, search messages, read bodies and download individual attachments into the bot's inbox directory. Reads use EXAMINE and BODY.PEEK, preserving Seen. Search results carry an account identity, mailbox, UIDVALIDITY and UID; callers must retain the complete reference. A mailbox reset invalidates old references rather than silently reading or changing a different message.

Search supports from, to, subject, text, unread and received-date filters. Follow `next` as `cursor` with the same mailbox, query and search mode until `complete` is true. The cursor preserves the initial upper UID boundary, so new arrivals do not shift older pages. An empty page with a cursor is not the end.

If a server's subject/from/to search is unreliable, explicitly choose `searchMode: "headers"`. Household scans up to 200 candidate headers per call locally and returns continuation until the candidates are exhausted. This mode searches complete decoded headers within the header size limit; body text search requires server mode. An ASCII-only server can still use local header search for Unicode terms.

With mailbox changes enabled, bots can add/remove Seen, Answered, Flagged or Draft, move a message, move it to the configured Trash folder, create/rename folders and save a new text draft. Moving requires UID MOVE; there is no copy/delete/global-expunge fallback. Permanent deletion and raw IMAP/SMTP commands are unavailable. An uncertain mutation result should be inspected before retrying.

Messages are limited to 12 MiB and 200 MIME parts, headers to 64 KiB, individual downloads and total outgoing attachments to 8 MiB. Read bodies over 64,000 characters report truncation. Search returns at most 50 matches per call; searches with more than 100,000 candidate UIDs must be narrowed. Mail and attachment contents remain untrusted external data, not owner instructions.

The connector uses a bounded host-side Python standard-library transport. Himalaya was consulted as a design reference; installing or configuring Himalaya is not required.
