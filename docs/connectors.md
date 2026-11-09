# Google connectors

Open a house's **Connectors** page. Select Gmail, Drive, Calendar, or any combination, choose which pets may use the account, and press **Connect Google**. Google opens in your browser and asks for read-only access. A connection with no pets selected is private until you grant access. Multiple Google accounts can belong to one house.

Official release builds use Household's shared Desktop OAuth client: you do not need a Google Cloud project. Google connectors are available starting with v0.5.6. Source builds can set `HOUSEHOLD_GOOGLE_CLIENT_ID` and `HOUSEHOLD_GOOGLE_CLIENT_SECRET` in the daemon's environment; these identify the Desktop application, not a user's account. Release builds inject the distributable Desktop client secret from the matching repository secret, without committing it to source.

The dashboard and Google callback use the same loopback port. On a remote host, use SSH forwarding with the **same local and remote dashboard port**, open the dashboard via `127.0.0.1`, and keep the tunnel open during sign-in. The callback must reach the host that started the connection. No callback service is run by Household's maintainers.

## Access

Each connection belongs to one house. Only its selected pets can use it. Sideworkers inherit their parent's **current** access, so removing the parent immediately removes their access too. Scouts cannot use house Google connectors. Changing access takes effect on the next request, without restarting pets. The three generic tools are available to ordinary pets even before an account is connected, so the tool list does not need a session restart.

Connecting the same Google account again in a house replaces its services and pet grants with your new choices. Google may let you approve only some services; the connection exposes only services whose full required scopes were granted. Other houses' connections stay separate.

## Tools

The existing Household MCP server exposes:

- `household_connectors_google_accounts`: available account IDs and services; never credentials.
- `household_connectors_google_operations`: operation descriptions and exact parameter schemas.
- `household_connectors_google_request`: `{connection, operation, params}`.

Operations:

| Service | Operations |
| --- | --- |
| Gmail | `gmail.messages.list`, `gmail.messages.get`, `gmail.threads.get`, `gmail.labels.list` |
| Drive | `drive.files.list`, `drive.files.get`, `drive.files.export` |
| Calendar | `calendar.calendarList.list`, `calendar.events.list`, `calendar.events.get` |

The pet can compose Gmail or Drive search queries and Calendar date filters. Requests are checked against this operation registry; there is no arbitrary URL, HTTP method, header, or token injection. Only GET requests to fixed Google API endpoints are allowed. Redirects are refused. Results are bounded to 256 KiB; list operations default to 20 results, with at most 50 per page. Follow pagination tokens for more.

Gmail text and HTML bodies are decoded; attachments are not downloaded. Drive returns metadata and can export supported Google Workspace documents as plain text, CSV (Sheets' first sheet), or Markdown. Binary files such as PDFs and images are not downloaded in this first version. There are no send, write, delete, share, or event-creation operations.

Retrieved content is untrusted data. It may enter the pet's AI provider, chat, and history. Choose an AI provider and configuration compatible with Google's Limited Use rules; Google data must not train generalized models.

## Storage and disconnect

Refresh and access tokens stay in the host's private `household.db`, never in a pet VM, MCP response, or dashboard response. Refresh tokens update automatically. A revoked or expired authorization is marked **Reconnect required** when Google rejects refresh. `house export` includes these credentials in its private database backup: protect backups like passwords. Removing a house removes its live stored connections when configuration is reconciled; removing a pet removes its grants.

**Disconnect** removes this house's stored connection and blocks in-flight results. It does not erase previous chat history, agent memory, provider copies, or backups. It does not revoke Google's grant for other houses or installations: use [Google Account connections](https://myaccount.google.com/connections) to revoke the entire Household authorization.

## Deployment and troubleshooting

The shared Google Cloud project must enable Gmail API, Google Drive API and Google Calendar API. Requested scopes are Gmail read-only, Drive read-only, Calendar calendar-list read-only, Calendar events read-only, plus OpenID/email to identify the account.

Until Google verifies the requested sensitive/restricted scopes, Google's unverified-app warning and project user cap apply. Publishing OAuth to Production removes the test-user allowlist; it does not verify the app or remove verification requirements. Workspace administrators may block unverified apps.

If authorization fails, retry from the local dashboard. OAuth state is single-use and expires in ten minutes; restarting the daemon also cancels pending sign-ins. A missing API or denied service permission can produce a 403. Grant the selected permission, enable the API in the shared project, or reconnect. Provider error bodies and tokens are not logged or returned to pets.
