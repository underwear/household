# Inboxes

An inbox watches a source, for example a mailbox, a feed, a website, your alerts, a Telegram bot or your own endpoint, and hands each new event to the bots you choose. A site goes down, and your ops bot hears within minutes, without you asking.

## How it works

- **Household checks the source** from its own computer, every 5 minutes by default. Passwords and tokens never reach a bot's VM.
- **Sources stay as they are.** IMAP leaves messages unread, POP3 never deletes, a watched Telegram bot never sends.
- **Each new event is saved, then delivered** to the bots that receive it, in the inbox's channel. A stopped bot gets a short catch-up summary later.
- **Each bot keeps a searchable history** of its events, included in [backups](../backup/).
- **Events are outside data, never your instructions.** Anyone can email you or write in a feed, so a bot reads an event like a stranger's message. Give a bot that receives your mail only the access it needs.

## What you decide

### Inbox, connector or schedule?

- **An inbox** wakes a bot when something new arrives. It gives no access to the account.
- **A [connector](../connectors/)** lets a bot search and act in an account. It never wakes the bot.
- **A [scheduled task](../schedules/)** wakes a bot at a set time.

They combine: an inbox brings mail, a connector lets the bot reply, a schedule sets when you hear.

### Who gets the events

Each bot in the inbox's channel has **Receives** and **Silent**, and the inbox has **Post events in the channel**:

| Mode | What happens | Use it for |
| --- | --- | --- |
| **Receives** | The bot is woken for each event. | What needs action soon: a site down, an alert. |
| **Silent** | The event goes to the bot's history only; the bot finds it when you ask or on a schedule. | Volume you want summarised: newsletters, a morning mail digest. |
| **Post only** | No bot receives; each event is posted in the channel. | A plain feed for a group: releases, a status page. |

With posting on, everyone in the channel sees each event, guests included: keep it off for mail and anything private.

On its first check an inbox skips what is there, unless you ask for up to 50 existing events. Check alerts often: one that fires and clears between two checks is missed.

## Mail

**IMAP** watches one folder, **POP3** the mailbox. Mail arrives as plain text, no attachments. Many providers want an app password; Google- or Microsoft-only sign-ins don't work. For **Proton Mail**, run Proton Mail Bridge on Household's computer, use the server and password it shows, and paste its exported certificate into **Trusted certificate**, never the private key.

## Feeds and websites

- **RSS / Atom** delivers new entries; edited ones aren't sent again.
- **Health check** sends one "down" event after failures in a row (3 by default), then "recovered".
- **JSON watcher** sends an event when a JSON answer changes, or only chosen fields, such as `/price`.

## Alerts

- **Grafana** delivers alerts and their state changes. Put a service account token in the `Authorization` header (`Bearer <token>`).
- **Datadog** delivers state changes of one monitor. Fill in the `DD-API-KEY` and `DD-APPLICATION-KEY` headers.

Give the token or keys read access only.

## Telegram bot

**Telegram Bot Updates** delivers what people send to a Telegram bot, such as a public feedback bot. Create one with BotFather just for this inbox. Don't reuse a bot from your channels: the inbox takes its updates, so nothing else can read them.

## Custom HTTP

**Custom HTTP** reads your own app's events from an endpoint you run. Household calls `GET <your URL>?limit=50`, adding `cursor=<value>` once you return one. Answer `200` with events oldest first:

```json
{
  "version": 1,
  "items": [{ "id": "ticket-184:rev-3", "title": "Payment latency", "text": "p95 over 2 s." }],
  "nextCursor": "184"
}
```

Each event needs a stable `id` (a new one when it changes), a `title` and plain `text`; `url`, `occurredAt` and `metadata` are optional. Without cursors, return recent events: Household skips IDs it has seen.

## Put it to use

**A mail triage bot.** An IMAP inbox with the bot on **Silent**, the [Email connector](../connectors/) with **Ask me first**, and a [scheduled task](../schedules/) at 9:00: "summarise yesterday's mail and draft replies to what needs one". Nothing goes out until you approve it.

## Good to know

- After 3 failed checks in a row the inbox's bots are told, and again when it recovers.
- Changing the address, server, account or folder starts the inbox over, as on a first check.
- Removing an inbox drops events still waiting; what it posted stays.
