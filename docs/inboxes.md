# Workspace inboxes

An inbox watches a source — mail, a feed, a health check, alerts, a Telegram bot or your own endpoint — and hands each new event to the bots you choose. Sources are checked from the host: passwords and tokens stay in the private Household config and never reach a bot's VM. Event contents are treated as untrusted data, never as your instructions.

## Add an inbox

In **Workspace → Inboxes**, choose **+ Add inbox**:

1. **Source.** Pick what to watch (see [Sources](#sources)).
2. **Connection.** Enter the address and credentials, then **Test and continue**. A test posts nothing, tells no bot and does not move the inbox forward.
3. **Delivery.** Name it and choose how often to check: every minute, 5 or 15 minutes, or any interval from 1 minute to 24 hours. Choose a channel and:
   - **Post events in the channel** — on: one Workspace message per event in that channel. Off: only the bots get them.
   - **Bots** — for each bot in that channel, **Receives** and **Silent** (see [Bots](#bots)). With posting on, you may leave every bot off for a plain channel feed; with posting off, at least one bot must receive.
   - **On the first check** — *Start from now* (default) skips what is already there; *Deliver what is there now* sends up to 50 current items, or the current state of a JSON or health check.

Bots reply about an event in the inbox's channel.

## Manage inboxes

Each inbox shows its state (Watching, Retrying, Needs attention, Paused), when it was last checked, when it checks next, and how many events wait for delivery. **Recent events** under the list shows what arrived lately.

- **Check now** checks right away.
- **Edit** changes anything. Changing the source or the channel is refused while events still wait for delivery: let them go out, or remove the inbox.
- **Pause** stops checking and keeps its place; **Resume** goes on from there.
- **Remove** stops it and drops waiting events. Posts already in the channel and the bots' event history stay.

## Bots

A bot's **Inboxes** tab lists every inbox of its workspace with two switches:

- **Receives** — the bot gets the inbox's events. It must be in the inbox's channel first.
- **Silent** — events go to the bot's inbox history only: it is not woken for them and can look them up when it needs to.

The same switches are in the inbox's own form. The only bot of an inbox that does not post in its channel cannot switch off there: turn posting on or add another bot first.

A busy bot takes events when it is idle. A paused bot, or one whose VM was down, gets a short **catch-up digest** instead of a pile of messages: counts per inbox, the time range and a few titles. It reads the full events from its history.

Bots read and search their history with three tools:

- `inbox_list` — the inboxes it receives, and which of them are silent.
- `inbox_history` — events by inbox and date, newest first.
- `inbox_search` — events by words in their title, text and metadata.

A bot sees only events that were addressed to it; subscribing later does not open older events. History is kept on the host, is not cleared by pausing or removing an inbox, and is part of backups.

## Sources

| Source | You enter | What arrives |
| --- | --- | --- |
| IMAP | Server, port (TLS: 993; STARTTLS: 143), connection security, username, password or app password, folder | New mail. Messages stay unread. |
| POP3 | Server, port (TLS: 995; STARTTLS: 110), connection security, username, password or app password | New mail. Nothing is deleted. |
| RSS / Atom | Feed URL | New entries |
| Health check | URL, expected status, timeout, failures before an alert | Down and recovered |
| JSON watcher | URL, the whole response or selected fields | Changed values |
| Grafana | Base URL, `Authorization: Bearer <service account token>` | Alerts and their state changes |
| Datadog | API URL of your region, monitor ID, `DD-API-KEY` and `DD-APPLICATION-KEY` | State changes of that monitor |
| Telegram Bot Updates | Token of a dedicated bot | Updates the bot receives |
| Custom HTTP | URL and headers | Events your endpoint returns ([format](#custom-http)) |

Every URL source accepts request headers for credentials. Redirects are not followed: enter the final URL.

**Mail.** Needs Python 3.9+ on the host and a provider that accepts a password or app password; OAuth-only mailboxes are not supported. Choose **TLS** for encryption from the start, or **STARTTLS** to upgrade the connection before login (POP3 uses STLS). Encryption and certificate verification are required in both modes; there is no fallback to plaintext. Existing inboxes keep using TLS. Attachments are not forwarded; mail arrives as plain text, up to 16,000 characters per event.

**Proton Mail Bridge.** Run Bridge on the same computer as Household. In Bridge, open the account's mailbox settings and use its IMAP host (usually `127.0.0.1`), port (usually `1143`), username and generated password, not your Proton account password. Choose the connection mode configured in Bridge, usually **STARTTLS**. In Bridge's **Settings → Advanced settings → Export TLS certificates**, export the certificate, then paste its PEM contents into **Trusted certificate** in Household. Do not paste the private key. This trusts the supplied certificate for this inbox while still checking the server name and expiry. If Bridge regenerates its certificate, export and replace it here. Test the connection, then select delivery. See [Bridge settings](https://proton.me/support/comprehensive-guide-to-bridge-settings).

**RSS / Atom.** RSS 2.0, RSS 1.0 and Atom. An edited entry with the same ID is not sent again.

**Health check.** A check passes when the URL answers the expected status (200 by default) within the timeout (10 s by default). After 3 failures in a row (1–10) the bots get one *down* event; the first passing check after it sends *recovered*. A site already down when you add it still alerts. The response body is ignored.

**JSON watcher.** Any JSON endpoint. Watch the whole response, or list fields as [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) paths, one per line:

```text
/price
/status
/items/0/available
```

Key order and whitespace don't count as changes; array order does. A field appearing or disappearing is a change.

**Grafana and Datadog.** Give the token read access to the alerts or the monitor. One Datadog inbox watches one monitor. A Grafana alert that disappears arrives as "No longer active": it may be resolved or deleted.

**Telegram Bot Updates.** Use a bot made for this inbox, not one of your channels' bots: checking takes the updates off Telegram's queue, so nothing else may read that bot, and a bot with a webhook is refused. Household never sends messages as this bot. Telegram keeps waiting updates for 24 hours only.

## Custom HTTP

Household sends `GET <your URL>?limit=50`, adding `cursor=<value>` once you have returned one. Put credentials in headers. Answer `200` with:

```json
{
  "version": 1,
  "items": [
    {
      "id": "ticket-184:revision-3",
      "title": "Payment service latency",
      "text": "p95 latency exceeded 2 seconds for five minutes.",
      "url": "https://status.example.com/incidents/184",
      "occurredAt": "2026-11-09T08:30:00Z",
      "metadata": { "service": "payments", "severity": "warning" }
    }
  ],
  "nextCursor": "184"
}
```

| Field | Meaning |
| --- | --- |
| `version` | Always `1` |
| `items` | Up to 50 events, oldest first; empty when there is nothing new |
| `id` | Required, stable, up to 512 characters. A changed event needs a new ID. |
| `title` | Required, up to 300 characters |
| `text` | Required plain text, up to 16,000 characters |
| `url` | Optional HTTP(S) link |
| `occurredAt` | Optional time with a timezone |
| `metadata` | Optional JSON object, up to 16 KiB; bots can search it |
| `nextCursor` | Optional, up to 4,096 characters; where to continue next time |

Without a cursor, return the latest 50 events; with one, the next events after it. Endpoints without cursors can return a recent window: Household remembers the last 5,000 IDs of each inbox.

## When something fails

A failing source is retried with growing pauses: up to an hour, or the inbox's own interval when that is longer. After 3 failed checks in a row, the inbox shows **Needs attention** with the reason, and its bots get one notice; they get one more when it recovers. An inbox without bots shows the problem on the page only.

Good to know:

- An event is saved before it is delivered, so a restart does not lose it. Around a crash, a channel post can rarely appear twice, and a bot may get an event it had already started on: the digest tells it so.
- Checks see snapshots: an alert that fires and clears between two checks can be missed.
- Changing a password or header keeps the inbox's place. Changing the URL, server, account, folder or monitor starts it over, as on its first check.
- Changing mail connection security or its trusted certificate also keeps the inbox's place; changing the port starts it over.
- Switching posting on or off applies to new events; switching a bot to Silent applies at once.
- The host can reach internal addresses your bots cannot: only you configure sources.

## References

- [Telegram Bot API: getting updates](https://core.telegram.org/bots/api#getting-updates)
- [Grafana Alertmanager API](https://github.com/grafana/grafana/blob/main/pkg/services/ngalert/api/generated_base_api_alertmanager.go)
- [Datadog monitor details API](https://docs.datadoghq.com/api/latest/monitors/get-a-monitors-details/)
