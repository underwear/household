# House inboxes

In **House → Inboxes**, connect a source, choose a channel and subscribe individual pets. Choose **Announce in channel** for a House post per event, or **Silent — pets only** to deliver directly to pets without a House post. Silent delivery requires at least one subscriber; pets may still choose to reply in the selected channel. Each subscriber gets its own durable queue entry and processes it when idle; paused pets wait until resumed. Replies stay in the selected channel, even when the pet also lives elsewhere.

Pollers run on the host. Passwords and authorization headers stay in the private Household config, outside pet prompts and VM environments. Incoming content is marked as external, untrusted data. Subscribing a pet does not make the source an owner.

## Setup

1. Choose **Telegram Bot Updates**, **RSS / Atom**, **Health check**, **JSON watcher**, **IMAP**, **POP3**, **Grafana**, **Datadog**, or **Custom HTTP**.
2. Enter connection details and choose **Test connection & continue**. Testing reads the source without posting messages, notifying pets or changing its saved cursor.
3. Name the inbox. Choose **every minute**, **every 5 minutes**, **every 15 minutes**, or a custom interval from 60 seconds to 24 hours.
4. Choose delivery mode, a channel and subscribers. Only pets placed in that channel are offered. In announcement mode, leave all unchecked for a channel-only feed. In silent mode, the channel determines where pets can reply.
5. Choose **Start from now** (default) or **Deliver current items / snapshot**, then save.

The page shows status, next check, pending deliveries and the last 50 events. **Check now** uses the saved cursor. **Pause** retains state; **Resume** continues it. **Remove** discards pending events and polling state, but leaves posted chat history.

## Built-in sources

| Source | Connection | What arrives |
| --- | --- | --- |
| Telegram Bot Updates | Dedicated BotFather token, no webhook or other consumer | Incoming Bot API updates; never sends/edits messages |
| RSS / Atom | Feed URL, optional headers | New entries identified by GUID/Atom ID, link, or content fallback |
| Health check | URL, expected status, timeout, consecutive failure threshold | Down/recovered transitions |
| JSON watcher | URL, optional headers, whole response or selected JSON Pointer paths | Changed values or current response preview |
| IMAP | Host, implicit TLS port (usually 993), username, password/app password, folder | New UID messages; read-only mailbox and `BODY.PEEK`, no read flags changed |
| POP3 | Host, implicit TLS port (usually 995), username, password/app password | New UIDL messages; no `DELE` |
| Grafana | Base URL, `Authorization: Bearer …` service-account header | State changes from `/api/alertmanager/grafana/api/v2/alerts`; disappearing alerts labelled “No longer active” |
| Datadog | Region API base URL, monitor ID, `DD-API-KEY` and `DD-APPLICATION-KEY` headers | Changes to that monitor's `overall_state` from `/api/v1/monitor/{id}`, including recovery to OK |
| Custom HTTP | Endpoint URL and authorization headers | Events in the versioned JSON contract below |

Use read access appropriate to the Grafana alert resources or Datadog monitor. Datadog watches one monitor per inbox, not a full per-group event history. A Grafana disappearance can mean resolution or removal; it is not always a recovery.

Email requires Python 3.9+ on the host and a provider accepting a password or app password. OAuth-only mailboxes and STARTTLS ports (143/110) are not implemented. Certificates and hostnames are verified. Attachments are not forwarded; MIME text/HTML becomes plain text, with previews capped at 64 KiB per mail and 16,000 characters per event. Large POP3 messages require server support for `TOP`. Up to 10,000 mailbox IDs are supported. IMAP UIDVALIDITY changes establish a new baseline without replaying the folder.

Recent-mail import takes the latest 50 existing messages, then catches up new mail in batches of 50. Grafana imports current alerts in batches of 50, up to 1,000 alerts. The default first successful check establishes a baseline without sending existing events.

## Telegram Bot Updates

Use a **dedicated bot token**. Household calls only `getMe`, `getWebhookInfo` and `getUpdates`. It never sends or edits messages, downloads attachments, answers callbacks, changes update subscriptions, or installs/removes a webhook. Tokens stay on the host, including Telegram's required token-in-URL API requests; transport errors are replaced with credential-free diagnostics.

Telegram exposes a single update queue per bot. Advancing `offset` **acknowledges updates on Telegram**; this is an incoming-only consumer, not an independent read-only mirror. Do not share the token with another polling process. Household rejects bots already used by one of its channels or another inbox, including across houses and token rotation. Existing webhooks are refused without changing them. A competing external consumer may return HTTP 409; external consumers cannot always be detected in advance.

Connection testing calls only `getMe` and `getWebhookInfo`: no updates read or acknowledged. Normal polling uses up to 50 updates and 10-second long polling per scheduled check. The next offset is saved with pending deliveries and used only after those deliveries drain. “Start from now” skips the pending queue counted at first connection, in batches; import starts with the oldest pending updates. Do not use this as an archive of historical Telegram chat messages: the API retains pending updates for at most 24 hours, and only returns updates the bot is permitted/subscribed to receive. Existing `allowed_updates` settings and privacy mode remain unchanged. Callback and non-message updates are retained as JSON previews; they are not acted upon.

## RSS / Atom

Supports RSS 2.0, RSS 1.0 and Atom, including namespaced feeds. Give the direct feed URL. HTML content becomes a plain-text preview; feed links are not fetched. First connection skips existing entries by default, including feeds larger than one batch. Import emits up to 50 entries per check in feed order and catches up subsequent entries. Up to 5,000 entry identities are retained in the durable cursor. Editing an entry with the same ID does not emit a new event. XML DTD/entity declarations are refused; feed responses are limited to 2 MB. Redirects are refused, so configure the final feed URL.

## Health check

A GET must return the exact expected HTTP status (default **200**) within the timeout (default **10 seconds**, configurable 0.1–60). Redirects, network errors and timeouts count as failed checks. Response bodies are not imported. After **3 consecutive failures** by default (configurable 1–10), emit one down event. The first successful check after a down event emits recovery. Repeated down/up results are quiet. Failures reset after any successful check.

A site already down when monitoring begins still alerts after the threshold, including with “Start from now.” Health failures are observations, not poller errors: checks continue at the configured interval without backoff. State and failure counts survive restarts. Connection testing reports the current result without starting the counter or delivering anything.

## JSON watcher

No custom envelope is needed: the endpoint returns any valid JSON. Choose **Entire JSON response** or **Selected fields**. Selected fields use [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901), one per line:

```text
/price
/status
/items/0/available
```

Use `~1` for a slash in a property name and `~0` for a tilde. Missing fields are distinct from `null`; additions and removals trigger events. Object key order and whitespace are ignored; array order remains significant. In whole-response mode any semantic JSON change triggers an event. In selected-fields mode changes outside those fields are ignored.

The poller stores only SHA-256 hashes and a transition counter in its cursor, not copies of the previous JSON body. Repeated identical responses are quiet. Returning to an earlier value is a new transition, including after a restart. Events contain current changed field values, or a whole-response preview limited to 16,000 characters, with a truncation marker. “Start from now” establishes a silent baseline; “Deliver current items / snapshot” emits the first snapshot. Errors or invalid JSON preserve the last successful baseline.

## Poller problems and recovery

After **3 consecutive failed checks**, subscribed pets receive one operational notice. It includes a safe diagnostic and warns that incoming data may be delayed. The first fully successful check sends one recovery notice. Repeated failures do not spam pets; the incident, pending notices and recipient progress survive daemon restarts. A later outage starts a new incident. Pausing, editing or stopping the daemon does not count as a failed check.

The Inboxes UI shows the failure count, when the problem began, the last successful poll and the next retry. Existing retry backoff still applies. Source and event-delivery errors both count: a successful fetch alone does not clear an incident if delivery remains blocked.

Operational notices are **pet-only**, independent of the inbox's normal announcement mode. They have a separate durable queue so a failed channel announcement cannot block them. They are also archived with `metadata.kind = "poller_status"`, `status = "failed" | "recovered"`, `consecutiveFailures` and `problemSince`; offline pets receive them through normal inbox catch-up. A missing channel or pet placement can still prevent notification delivery until its configuration is repaired; the UI remains the place to inspect the problem. Inboxes with no subscribers show the problem in the UI only.

## Catch-up after VM downtime

When a pet is paused, its VM is unavailable, or queued events are restored after a daemon restart, pending inbox notifications are delivered as a **catch-up digest** once its agent is idle and ready. Backlogs accumulated while busy also use this format.

The digest groups events by inbox: counts, received-time range, up to three example titles and ready-to-use `inbox_history` filters. Full bodies and metadata remain in the archive; they are not pasted into the VM in bulk. This is a pet notification only, with no additional House channel post, so silent delivery stays silent.

Different reply places/channels and intervening owner messages remain separate. Very large backlogs are split into batches of at most 500 events / 30 inbox groups, with each batch waiting for the prior inbox turn to finish. Original durable queue rows remain the acknowledgment units: a digest does not delete events or mark them done before delivery. Completed batches are not replayed on the next wake-up.

Inbox events delivered before an interrupted session but not confirmed complete return in a digest too. It explicitly says they **may already have been seen**; the pet should consult history and avoid repeating actions blindly. No old event body is automatically replayed in that recovery path. If Household itself was offline, pollers resume from their saved cursors when it starts; they cannot recover events a provider has already expired (for example Telegram's 24-hour retention).

## Durable event history and metadata

Every accepted new event is archived in the host SQLite database **before delivery**, including silent events and events whose channel delivery needs retrying. The archive keeps title, full accepted notification text, URL, source kind, delivery mode, arbitrary JSON-object `metadata`, and both timestamps:

- `occurredAt`: source event time, when provided; otherwise null.
- `receivedAt`: when Household accepted the event, always present.

The scheduler's “Recent events” list is capped at 50; the archive is not. Removing or pausing an inbox does not erase history. Backups include it. Archiving starts with this version: previously delivered notifications are not reconstructed from chat previews, and events skipped by initial baselining are not archived. Text limits still apply; an archived preview is not the original attachment or an unlimited provider response.

### Pet tools

- `inbox_list({})`: subscribed inboxes and readable retained archives, without connection credentials.
- `inbox_history({inbox?, since?, until?, time?, before?, limit?})`: event slices, newest accepted first.
- `inbox_search({query, ...sameFilters})`: word/prefix search across notification title, body **and metadata**. All search words must match.

`since` is inclusive, `until` exclusive; timestamps must include a timezone. `time` defaults to `received`; `occurred` filters by source time, falling back to received time when absent. Pass returned `next` as `before` with unchanged filters to continue. Default 10 events, maximum 50, also capped by response size. Results include metadata and both timestamps.

```json
{"inbox":"production-alerts","since":"2026-11-09T00:00:00+01:00","until":"2026-11-10T00:00:00+01:00","limit":10}
```

Each pet can read only events addressed to it when they were accepted, within its own house. A new subscriber does not retroactively gain old events; removal of a subscription stops new delivery but preserves access to its own archived events. Scouts/sideworkers do not automatically inherit this access. Retrieved notifications and metadata remain untrusted external content, not owner instructions. Known source credentials are redacted recursively from content and metadata before storage or delivery.

### Built-in metadata

| Source | Metadata |
| --- | --- |
| Telegram | `updateId`, `type`, chat and sender IDs/names, message/thread IDs, callback identifiers/data when present; message date supplies `occurredAt` |
| IMAP / POP3 | `from`, `to`, `cc`, `subject`, `messageId`, raw date, content type, truncation flag; IMAP UID/UIDVALIDITY/mailbox or POP3 UIDL; a valid timezone-aware mail date supplies `occurredAt` |
| RSS / Atom | `feedUrl`, `entryId`, author, categories, feed format; published/updated time supplies `occurredAt` |
| Grafana | Fingerprint, start time, bounded labels, current/previous state; disappearance includes the prior state |
| Datadog | Monitor ID, current/previous state |
| Health check | State, HTTP status, expected status, latency, timeout, failure count and reason |
| JSON watcher | Whole/fields mode, changed JSON Pointer paths and transition generation |
| Custom HTTP | Any provider-defined JSON object conforming to the size/depth bounds below |

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
      "occurredAt": "2026-11-09T08:30:00Z",
      "metadata": { "service": "payments", "severity": "warning", "ticketId": 184 }
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
| `metadata` | Optional arbitrary JSON object, up to 16 KiB serialized UTF-8 and 8 levels deep; arrays, objects, strings, numbers, booleans and null allowed inside |
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
- HTTP/feed responses are bounded to 2 MB and 20 seconds; health checks use their configured timeout and discard the body. Mail processes are bounded to 60 seconds.
- Cursor, IDs and pending events are saved **before** delivery. Retries drain unfinished deliveries before polling for more.
- Pet queue entries have stable deduplication IDs. Restarting does not intentionally replay queued events.
- External channel posting is **at least once around a crash**: a messenger may accept a post just before Household saves its receipt. That narrow failure window can duplicate a channel post; exactly-once delivery is not promised.
- Failures back off exponentially, capped at eight times the interval or one hour, never faster than the configured interval. Success restores the configured schedule.
- Changing source identity or channel with pending events is refused. Drain the queue first, or remove the inbox to discard it.
- Changing endpoint, mail account/folder or monitor establishes a new baseline. Rotating passwords or headers keeps the cursor; do not use a credential change to switch datasets.
- Delivery mode is captured when an event is queued. Switching silent/announcement affects future events; already pending events keep their mode.
- Removing a subscription stops future fan-out; entries already in a pet's durable queue remain.
- Polling sees snapshots: an alert appearing and resolving entirely between checks can be missed.
- The host can reach configured internal endpoints. VM allowlists do not govern host polling. Only the owner admin configures sources.

Configuration and polling state are included in normal Household backups. Restore a backup before downgrading to a release without inbox support.

## Adding a built-in poller

Add a validated source variant to `pollSourceSchema`, implement its handler, register it in the exhaustive registry in `src/infra/inbox-pollers.ts`, and add the corresponding connection fields in the admin UI.

A handler may provide a separate non-consuming `test` probe; Telegram uses one because a connection check must not acknowledge updates. The host-only handler contract is `(source, cursor, initial, signal) => Promise<PollResult>`. Return up to 50 normalized `InboxItem` events and an opaque cursor (up to 1 MB). The application persists the cursor with pending delivery before dispatch; no poller-local files or in-memory caches are needed. Honor cancellation and do not mutate remote data. Use safe fixed diagnostics (`InboxPollError`) rather than including provider responses or credentials in errors.

`inbox-pollers/common.ts` supplies bounded HTTP reads, canonical JSON and SHA-256 hashes. Each implementation owns the meaning of its cursor: feed IDs, watched-field hashes, or health state/counters. Event IDs must distinguish separate transitions (A → B → A) while remaining stable for retries. `baselineHandled: true` is reserved for built-in pollers that own first-check delivery semantics, such as health monitoring; it is not part of the external HTTP contract. Other sources use the normal first-check baseline suppression. Pollers never choose recipients or delivery modes.

## References

- [Telegram Bot API: getting updates](https://core.telegram.org/bots/api#getting-updates)
- [Grafana Alertmanager API routes](https://github.com/grafana/grafana/blob/main/pkg/services/ngalert/api/generated_base_api_alertmanager.go)
- [Datadog monitor details API](https://docs.datadoghq.com/api/latest/monitors/get-a-monitors-details/)
- [Python IMAP client](https://docs.python.org/3/library/imaplib.html)
- [Python POP3 client](https://docs.python.org/3/library/poplib.html)
