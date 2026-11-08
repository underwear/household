# House inboxes

In **House → Inboxes**, connect a source, choose a channel and subscribe individual pets. Each new event is posted once in that channel. Each subscriber gets its own durable queue entry and processes it when idle; paused pets wait until resumed. Replies stay in the selected channel, even when the pet also lives elsewhere.

Pollers run on the host. Passwords and authorization headers stay in the private Household config, outside pet prompts and VM environments. Incoming content is marked as external, untrusted data. Subscribing a pet does not make the source an owner.

## Setup

1. Choose **IMAP**, **POP3**, **Grafana**, **Datadog**, or **Custom HTTP**.
2. Enter connection details and choose **Test connection & continue**. Testing reads the source without posting messages, notifying pets or changing its saved cursor.
3. Name the inbox. Choose **every minute**, **every 5 minutes**, **every 15 minutes**, or a custom interval from 60 seconds to 24 hours.
4. Choose a channel and subscribers. Only pets placed in that channel are offered. Leave all unchecked for a channel-only feed.
5. Choose **Start from now** (default) or **Import recent mail / current alerts**, then save.

The page shows status, next check, pending deliveries and the last 50 events. **Check now** uses the saved cursor. **Pause** retains state; **Resume** continues it. **Remove** discards pending events and polling state, but leaves posted chat history.

## Built-in sources

| Source | Connection | What arrives |
| --- | --- | --- |
| IMAP | Host, implicit TLS port (usually 993), username, password/app password, folder | New UID messages; read-only mailbox and `BODY.PEEK`, no read flags changed |
| POP3 | Host, implicit TLS port (usually 995), username, password/app password | New UIDL messages; no `DELE` |
| Grafana | Base URL, `Authorization: Bearer …` service-account header | State changes from `/api/alertmanager/grafana/api/v2/alerts`; disappearing alerts labelled “No longer active” |
| Datadog | Region API base URL, monitor ID, `DD-API-KEY` and `DD-APPLICATION-KEY` headers | Changes to that monitor's `overall_state` from `/api/v1/monitor/{id}`, including recovery to OK |
| Custom HTTP | Endpoint URL and authorization headers | Events in the versioned JSON contract below |

Use read access appropriate to the Grafana alert resources or Datadog monitor. Datadog watches one monitor per inbox, not a full per-group event history. A Grafana disappearance can mean resolution or removal; it is not always a recovery.

Email requires Python 3.9+ on the host and a provider accepting a password or app password. OAuth-only mailboxes and STARTTLS ports (143/110) are not implemented. Certificates and hostnames are verified. Attachments are not forwarded; MIME text/HTML becomes plain text, with previews capped at 64 KiB per mail and 16,000 characters per event. Large POP3 messages require server support for `TOP`. Up to 10,000 mailbox IDs are supported. IMAP UIDVALIDITY changes establish a new baseline without replaying the folder.

Recent-mail import takes the latest 50 existing messages, then catches up new mail in batches of 50. Grafana imports current alerts in batches of 50, up to 1,000 alerts. The default first successful check establishes a baseline without sending existing events.

## Custom HTTP contract, version 1

Household sends **GET** to the configured URL, preserving query parameters and adding `limit=50` and, after a response supplies it, `cursor=<opaque cursor>`.

Use headers for authorization. Embedded URL credentials and transport-header overrides are rejected. Redirects are not followed. HTTPS is recommended; HTTP is allowed for explicitly configured local/internal endpoints.

Respond with HTTP 200 and JSON:

```json
{
  "version": 1,
  "items": [
    {
      "id": "ticket-184:revision-3",
      "title": "Payment service latency",
      "text": "p95 latency exceeded 2 seconds for five minutes.",
      "url": "https://status.example.com/incidents/184",
      "occurredAt": "2026-11-09T08:30:00Z"
    }
  ],
  "nextCursor": "184"
}
```

| Field | Contract |
| --- | --- |
| `version` | Exactly `1` |
| `items` | 0–50 events, oldest first |
| `id` | Required stable nonempty string, maximum 512 characters; changed events need a new ID |
| `title` | Required string, maximum 300 characters |
| `text` | Required plain-text string, maximum 16,000 characters |
| `url` | Optional HTTP(S) URL, without embedded credentials |
| `occurredAt` | Optional ISO 8601 timestamp with timezone |
| `nextCursor` | Optional opaque string, maximum 4,096 characters; omission retains the previous cursor |

On the **first request without a cursor**, return the most recent 50 events and a cursor after them. “Start from now” records these IDs/cursor without delivery; “import recent” delivers them. Subsequent requests return the next oldest events after the cursor, advancing only through returned items. An empty array means caught up. If more than 50 wait, the next page arrives on the following poll. Without cursors, return a recent rolling window; Household remembers the last 5,000 IDs per inbox.

Keep IDs stable across polls and restarts. Never use fetch time as an ID. Include a revision for changed items. Sources cannot choose channels, select pets, run commands or override authorization: those are owner settings.

### Minimal endpoint

Replace this in-memory Bun example with your database. Store `INBOX_TOKEN` in your endpoint's environment.

```ts
const events = [
  { sequence: 1, id: "demo-1", title: "New ticket", text: "A customer needs help." },
];

Bun.serve({
  port: 8080,
  fetch(request) {
    if (!process.env.INBOX_TOKEN ||
        request.headers.get("authorization") !== "Bearer " + process.env.INBOX_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    const raw = new URL(request.url).searchParams.get("cursor");
    if (raw !== null && !/^\d+$/.test(raw)) return new Response("Invalid cursor", { status: 400 });
    const selected = raw === null
      ? events.slice(-50)
      : events.filter(event => event.sequence > Number(raw)).slice(0, 50);
    return Response.json({
      version: 1,
      items: selected.map(({ sequence, ...event }) => event),
      nextCursor: String(selected.at(-1)?.sequence ?? Number(raw ?? 0)),
    });
  },
});
```

## Delivery and failures

- Checks never overlap for one inbox. At most four sources poll concurrently.
- HTTP responses are bounded to 2 MB and 20 seconds. Mail processes are bounded to 60 seconds.
- Cursor, IDs and pending events are saved **before** delivery. Retries drain unfinished deliveries before polling for more.
- Pet queue entries have stable deduplication IDs. Restarting does not intentionally replay queued events.
- External channel posting is **at least once around a crash**: a messenger may accept a post just before Household saves its receipt. That narrow failure window can duplicate a channel post; exactly-once delivery is not promised.
- Failures back off exponentially, capped at eight times the interval or one hour, never faster than the configured interval. Success restores the configured schedule.
- Changing source identity or channel with pending events is refused. Drain the queue first, or remove the inbox to discard it.
- Changing endpoint, mail account/folder or monitor establishes a new baseline. Rotating passwords or headers keeps the cursor; do not use a credential change to switch datasets.
- Removing a subscription stops future fan-out; entries already in a pet's durable queue remain.
- Polling sees snapshots: an alert appearing and resolving entirely between checks can be missed.
- The host can reach configured internal endpoints. VM allowlists do not govern host polling. Only the owner admin configures sources.

Configuration and polling state are included in normal Household backups. Restore a backup before downgrading to a release without inbox support.

## References

- [Grafana Alertmanager API routes](https://github.com/grafana/grafana/blob/main/pkg/services/ngalert/api/generated_base_api_alertmanager.go)
- [Datadog monitor details API](https://docs.datadoghq.com/api/latest/monitors/get-a-monitors-details/)
- [Python IMAP client](https://docs.python.org/3/library/imaplib.html)
- [Python POP3 client](https://docs.python.org/3/library/poplib.html)
