# Inboxes

An inbox is where events from the outside world come in for your bots: new mail, a new post in a feed, an alert, a message to a Telegram bot, an event from your own app. Think of it as a subscription. Household watches the source, drops each new event into the inbox, and the bots subscribed to it get the event, the way you get mail.

You don't need an inbox for a bot to check something now and then: it can do that itself on a [schedule](../schedules/). An inbox takes the watching off its hands. Household checks the source, and the bot hears only when something actually arrived.

## How it works

- **Household checks the source** from its own computer, every 5 minutes by default. Passwords and tokens never reach a bot's VM.
- **Sources stay as they are.** IMAP leaves messages unread, POP3 never deletes, a watched Telegram bot never sends.
- **Each new event is saved, then delivered** to the subscribed bots. A stopped bot gets a short catch-up summary later.
- **Each bot keeps a searchable history** of its events, included in [backups](../backup/).
- **Events are outside data, never your instructions.** Anyone can email you or write in a feed, so a bot reads an event like a stranger's message.

## Who gets the events

Each bot in the inbox's channel is **Receives** or **Silent**, and the inbox can **Post events in the channel**:

| Mode | What happens | Use it for |
| --- | --- | --- |
| **Receives** | The bot is woken for each event. | What needs attention soon: a site down, an alert. |
| **Silent** | The event goes to the bot's history only; the bot finds it when you ask or on a schedule. | Volume you want summarised: newsletters, a morning mail digest. |
| **Post only** | No bot receives; each event is posted in the channel. | A plain feed for a group: releases, a status page. |

With posting on, everyone in the channel sees each event, guests included: keep it off for mail and anything private.

On its first check an inbox skips what is already there, unless you ask for up to 50 existing events.

## Sources

- **Mail.** **IMAP** watches one folder, **POP3** the mailbox. Mail arrives as plain text, without attachments. Many providers want an app password; for a local bridge such as Proton Mail Bridge, paste its exported certificate under **Trusted certificate**, never the private key.
- **RSS / Atom** delivers new entries.
- **Health check** sends one "down" event after a few failures in a row, then "recovered".
- **JSON watcher** sends an event when a JSON answer changes, or only the fields you pick, such as `/price`.
- **Alerts** from Grafana or Datadog: their state changes. Give their tokens read access only.
- **Telegram Bot Updates** delivers what people send to a Telegram bot, such as a public feedback bot. Make one with BotFather just for this: an inbox takes all of a bot's updates, so don't reuse a bot from your channels.
- **Custom HTTP** reads your own app's events from an endpoint you run (format below).

<details>
<summary>The Custom HTTP format</summary>

Household calls `GET <your URL>?limit=50`, adding `cursor=<value>` once you return one. Answer `200` with events oldest first:

```json
{
  "version": 1,
  "items": [{ "id": "ticket-184:rev-3", "title": "Payment latency", "text": "p95 over 2 s." }],
  "nextCursor": "184"
}
```

Each event needs a stable `id` (a new one when it changes), a `title` and plain `text`; `url`, `occurredAt` and `metadata` are optional. Without cursors, return recent events: Household skips IDs it has seen.

</details>

## Good to know

- After 3 failed checks in a row the inbox's bots are told, and again when it recovers.
- An alert that fires and clears between two checks is missed: check alert sources often.
- Changing the address, server, account or folder starts the inbox over, as on a first check.
