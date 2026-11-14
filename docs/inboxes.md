# Inboxes

An inbox watches a source — a mailbox, a feed, a website, your alerts, a Telegram bot or your own endpoint — and hands each new event to the bots you choose. A new email arrives, a site goes down, a monitor fires: the bot gets it and can act on it without you asking.

An inbox is not a [connector](../connectors/). A connector lets bots look things up in an account when they need to; it never wakes them. An inbox does the opposite: it brings new events to bots, but gives them no access to the account itself. Watching a mailbox in an inbox doesn't let bots search older mail or send replies. For that, also connect the mailbox as a connector.

Sources are checked from Household's computer. Passwords, tokens and keys stay there and never reach a bot's VM. Bots treat event contents as outside data, never as your instructions.

## Add an inbox

Open **Workspace → Inboxes → + Add inbox**. The form has three steps.

1. **Source.** Pick what to watch (see the sections below).
2. **Connection.** Enter the address and credentials, then press **Test and continue**. The test only checks the connection: it posts nothing and tells no bot. Web sources take credentials as request headers (**+ Add header**). Redirects are not followed, so enter the final address.
3. **Delivery.**
   - **Name** the inbox and choose how often to **Check**: every minute, every 5 or 15 minutes, or a custom interval from 1 minute to 24 hours.
   - Pick the **Channel**. Bots reply about its events there.
   - **Post events in the channel**: on, everyone in the channel sees one message per event. Off, only the chosen bots get them.
   - Under **Bots**, choose who receives the events (see [Choose which bots get events](#choose-which-bots-get-events)).
   - **On the first check**: **Start from now, skip what is there** (the default), or **Deliver what is there now (up to 50)**.

Press **Add inbox**. A workspace can have up to 30 inboxes.

## Choose which bots get events

Each bot has two switches for an inbox:

- **Receives**: the bot gets the inbox's events. Only bots in the inbox's channel can receive; add a bot to the channel first.
- **Silent**: events go to the bot's inbox history only. It isn't woken for them, but it can look them up and search them when it needs to.

With posting on, you can leave every bot off and use the inbox as a plain feed in the channel. With posting off, at least one bot must receive.

You can set the same switches from the bot's side: a bot's **Inboxes** tab lists every inbox of the workspace with **Receives** and **Silent**.

A busy bot gets new events when it is free. A bot that was paused or stopped gets a short catch-up summary instead of a pile of messages, and reads the details from its history. A bot only sees events sent to it: switching **Receives** on later doesn't open older ones. Inbox history stays on Household's computer, survives pausing or removing an inbox, and is part of [backups](../backup/).

## Manage inboxes

Each inbox on the Inboxes page shows its state, when it was last checked, when it checks next, and how many events wait for delivery. States: **Watching**, **First check soon**, **Checking…**, **Retrying**, **Needs attention**, **Paused**. **Recent events** below the list shows what arrived lately.

- **Check now** checks right away.
- **Edit** opens the delivery settings; **Back** reaches the connection. You can't change the source or channel while events still wait for delivery.
- **Pause** stops checking and keeps the inbox's place. **Resume** carries on from there.
- **Remove** stops it and drops events still waiting. What it already posted stays in the channel, and bots keep their history.

Changing a password or header keeps the inbox's place. Changing the address, server, account, folder or monitor starts it over, as on a first check.

## Mail

Two sources watch a mailbox for new mail: **IMAP** (a chosen folder, usually `INBOX`) and **POP3**. Neither changes your mailbox: IMAP leaves messages unread, POP3 never deletes. Mail arrives as plain text, up to 16,000 characters per event, without attachments.

Enter the **Mail server**, **Port** and **Connection security** from your provider's help pages, then your **Username** and **Password or app password**. **TLS** encrypts from the start; **STARTTLS** requires encryption before signing in. Both check the server's certificate, and neither ever falls back to an unencrypted connection. Many providers want an app password rather than your normal one. Mailboxes that allow only signing in through Google or Microsoft are not supported. Mail needs Python 3.9 or later on Household's computer.

**Proton Mail** works through Proton Mail Bridge, running on the same computer as Household. Use the IMAP server, port and password Bridge shows for your account (usually `127.0.0.1`, port `1143`, **STARTTLS**) — not your Proton password. In Bridge, open **Settings → Advanced settings → Export TLS certificates** and paste the certificate into **Trusted certificate (optional)**; never paste the private key. If Bridge makes a new certificate, paste the new one.

## Feeds

**RSS / Atom** delivers new entries from a feed: articles, releases, changelogs. Enter the **Feed URL**. An entry that is edited later is not sent again.

## Health checks

**Health check** watches that an address answers. Enter its **Endpoint URL** and set the **Expected status** (200 by default), the **Timeout, s** (10 by default) and **Failures to alert** (3 in a row by default, 1–10). After that many failures, bots get one "down" event; the first passing check after it sends "recovered". A site that is already down when you add it still alerts.

## Changes in JSON

**JSON watcher** watches an **Endpoint URL** that returns JSON and sends an event when the answer changes. Watch the **Whole response**, or **Selected fields**, one path per line:

```text
/price
/status
/items/0/available
```

Key order and spacing don't count as changes; the order of list items does.

## Alerts

- **Grafana** delivers alerts and their state changes. Enter your **Grafana base URL** and put a service account token in the `Authorization` header (`Bearer <token>`).
- **Datadog** delivers state changes of one monitor. Enter your region's **Datadog API base URL** and the **Monitor ID**, and fill in the `DD-API-KEY` and `DD-APPLICATION-KEY` headers.

Give the token or keys read access only. An alert that fires and clears between two checks can be missed.

## Telegram bot

**Telegram Bot Updates** delivers what people send to a Telegram bot — handy for a public intake bot whose messages your own bots should handle. Create a new bot with BotFather just for this inbox and paste its **Bot token**. Don't reuse a bot from your channels: the inbox takes the bot's updates, so nothing else can read them, and a bot with a webhook is refused. Household never sends messages as this bot. Telegram keeps waiting updates for 24 hours only.

## Custom HTTP

**Custom HTTP** reads events from an **Endpoint URL** you run.

Household calls `GET <your URL>?limit=50`, adding `cursor=<value>` once you have returned one. Answer `200` with:

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

`items` holds up to 50 events, oldest first. Each needs a stable `id` (a changed event needs a new one), a `title` and plain `text` (up to 16,000 characters); `url`, `occurredAt` and a small `metadata` object are optional. Without a cursor, return the latest events; with one, the events after it. If your endpoint has no cursors, return a recent window: Household remembers the last 5,000 IDs.

## When an inbox fails

A failing source is retried with growing pauses, up to an hour (or the inbox's own interval, if longer). After 3 failed checks in a row, the inbox shows **Needs attention** with the reason, and its bots are told once; they hear again when it recovers. An inbox without bots shows the problem on the page only.

Events are saved before they are delivered, so a restart doesn't lose them. Rarely, around a crash, a channel post can appear twice.
