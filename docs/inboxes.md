# Inboxes

An inbox watches a source — a mailbox, a feed, a website, your alerts, a Telegram bot or your own endpoint — and hands each new event to the bots you choose. A site goes down, and your ops bot hears about it within minutes, without you asking.

An inbox is not a [connector](../connectors/). A connector lets bots look things up in an account when they need to; it never wakes them. An inbox does the opposite: it brings new events to bots, but gives them no access to the account itself. Watching a mailbox in an inbox doesn't let bots search older mail or send replies. For that, also connect the mailbox as a connector.

## When it helps

- **Mail that needs handling:** invoices, support requests, a shared family address.
- **Your services:** a failed health check or an alert wakes a bot to look into it.
- **Things you follow:** releases, a price, a status.
- **People outside your chats:** a public Telegram bot or your own app sends work to your bots.

## How it works

- **Household checks the source** from its own computer, every 5 minutes by default. Passwords, tokens and keys stay there and never reach a bot's VM.
- **Sources stay as they are.** IMAP leaves messages unread, POP3 never deletes, a watched Telegram bot never sends.
- **Each new event is saved, then delivered** to the bots that receive it, in the inbox's channel. A busy bot gets it when free; a paused or stopped bot gets a short catch-up summary instead of a pile of messages.
- **Every bot keeps an inbox history** on Household's computer and can search it. It holds only events sent to that bot, survives removing the inbox, and is part of [backups](../backup/).
- **Events are outside data, never your instructions.** Anyone can send you an email or put text in a feed, so a bot reads an event the way it reads a stranger's message. Give a bot that receives your mail only the access it needs.

## What you decide

### Inbox, connector or schedule?

- **An inbox** wakes a bot when something new arrives. It gives no access to the account.
- **A [connector](../connectors/)** lets a bot search and act in an account when asked. It never wakes the bot.
- **A [scheduled task](../schedules/)** wakes a bot at a set time, whatever has arrived.

They combine: an inbox brings mail in, a connector lets the bot reply, a schedule sets when you hear.

### Who gets the events

Each bot in the inbox's channel has **Receives** and **Silent**, and the inbox has **Post events in the channel**. Together they give three ways to use it:

| Mode | What happens | Use it for |
| --- | --- | --- |
| **Receives** | The bot is woken for each event. | What needs action soon: a site down, an alert, a support request. |
| **Silent** | The event goes to the bot's history only. It isn't woken, but finds it when you ask or on a schedule. | Volume you want summarised, not interruptions: newsletters, release feeds, all mail for a morning digest. |
| **Post only** | Posting on, no bot receiving: one message per event in the channel. | A plain feed for the people in a group: releases, a status page. |

Posting is separate from the bots. On, everyone in the channel sees each event, guests included: keep it off for mail and anything private. Off, only the chosen bots get events, and at least one must receive. Only bots in the inbox's channel can receive.

### First check and frequency

On the first check an inbox skips what is there (the default) or delivers up to 50 existing events. It checks every 5 minutes by default, from every minute to once a day. Check alerts often: one that fires and clears between two checks can be missed.

## Set it up

Add one under **Workspace → Inboxes → + Add inbox**; a bot's own **Inboxes** tab sets its switches too. The connection test posts nothing and tells no bot. Web sources take credentials as request headers. Redirects are not followed, so enter the final address.

## Mail

**IMAP** watches one folder, usually `INBOX`; **POP3** watches the mailbox. Mail arrives as plain text, up to 16,000 characters per event, without attachments. Take the server, port and connection security from your provider's help pages. **TLS** and **STARTTLS** both check the server's certificate, and neither ever falls back to an unencrypted connection. Many providers want an app password rather than your normal one. Mailboxes that allow only signing in through Google or Microsoft are not supported.

*Recipe:* point an inbox at `invoices@` with a bookkeeping bot on **Receives**: it notes each invoice and its due date as it comes.

**Proton Mail** works through Proton Mail Bridge on the same computer as Household. Use the IMAP server, port and password Bridge shows (usually `127.0.0.1`, port `1143`, **STARTTLS**), not your Proton password. In Bridge, open **Settings → Advanced settings → Export TLS certificates** and paste the certificate into **Trusted certificate**; never paste the private key. If Bridge makes a new certificate, paste the new one.

## Feeds

**RSS / Atom** delivers new entries from a feed. An entry that is edited later is not sent again.

*Recipe:* the release feeds of the tools you use, **Silent** to your coding bot, and a Friday task: "tell me which releases matter for our projects".

## Health checks

**Health check** watches that an address answers with the expected status (200 by default) within a timeout (10 seconds by default). After a number of failures in a row (3 by default, 1–10), bots get one "down" event; the first passing check after it sends "recovered". A site that is already down when you add it still alerts.

*Recipe:* your site, with an ops bot on **Receives** that looks into it and tells you more than "it's down".

## Changes in JSON

**JSON watcher** sends an event when a JSON answer changes: the whole response, or selected fields, one path per line:

```text
/price
/status
/items/0/available
```

Key order and spacing don't count as changes; the order of list items does.

*Recipe:* a shop's product API, watching `/price` and `/available`, with a bot that tells you only when the price drops below what you named.

## Alerts

- **Grafana** delivers alerts and their state changes. Put a service account token in the `Authorization` header (`Bearer <token>`).
- **Datadog** delivers state changes of one monitor. Fill in the `DD-API-KEY` and `DD-APPLICATION-KEY` headers.

Give the token or keys read access only.

*Recipe:* see the night ops bot below.

## Telegram bot

**Telegram Bot Updates** delivers what people send to a Telegram bot. Create a bot with BotFather just for this inbox. Don't reuse a bot from your channels: the inbox takes the bot's updates, so nothing else can read them, and a bot with a webhook is refused. Telegram keeps waiting updates for 24 hours only.

*Recipe:* a public feedback bot for your project. People write to it; your bot sorts what they send and gives you a summary each evening.

## Put it to use

**A night ops bot.** A Grafana inbox, posting off, with your ops bot on **Receives**. When an alert fires, the bot reads it and calls a [scout](../scouts/) that holds the production key. You press **Run** from your phone and read the findings in the scout's thread.

**A mail triage bot.** An IMAP inbox with the bot on **Silent**, the [Email connector](../connectors/) with **Ask me first**, and a [scheduled task](../schedules/) at 9:00: "summarise yesterday's mail and draft replies to what needs one". Nothing goes out until you approve it.

## Limits and good to know

- Up to 30 inboxes per workspace.
- A failing source is retried with growing pauses, up to an hour (or the inbox's own interval, if longer). After 3 failed checks in a row, the inbox shows the reason on its page and its bots are told once; they hear again when it recovers.
- Events are saved before they are delivered, so a restart doesn't lose them. Rarely, around a crash, a channel post can appear twice.
- Changing a password or header keeps the inbox's place. Changing the address, server, account, folder or monitor starts it over, as on a first check. The source and channel can't change while events still wait for delivery.
- Removing an inbox drops events still waiting; what it posted stays.

## Custom HTTP

**Custom HTTP** reads events from an endpoint you run. Use it to bring your own app's events (new orders, tickets, sign-ups) to your bots.

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

`items` holds up to 50 events, oldest first. Each needs a stable `id` (a changed event needs a new one), a `title` (up to 300 characters) and plain `text` (up to 16,000 characters); `url`, `occurredAt` and a small `metadata` object (up to 16 KB) are optional. Without a cursor, return the latest events; with one, the events after it. If your endpoint has no cursors, return a recent window: Household remembers the last 5,000 IDs.

## Related

- [Connectors](../connectors/): access to the accounts behind your inboxes.
- [Scheduled tasks](../schedules/): when a time, not an event, should wake a bot.
- [Scouts](../scouts/): for alerts that need production access.
