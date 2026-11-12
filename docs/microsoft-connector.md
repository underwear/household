# Microsoft To Do connector

Connect a personal or work/school Microsoft account from **Workspace → Connectors → Add connector → Microsoft To Do**. Choose **Read only** or **Read and write** and the bots that may use it. With no bots selected, the connection stays private.

Select **Prepare Microsoft sign-in**, open Microsoft's page, and enter the displayed code. Keep the Household dialog open: it completes automatically after approval. You can sign in from another device, including when Household runs on a VPS. Cancel closes this enrollment; expiry or a daemon restart requires starting it again. Only enter codes you just requested in your own Household dashboard.

## Standalone authorization

Household uses Microsoft's OAuth device authorization flow as a public client. No callback listener, hosted callback page, client secret, or maintainer-operated token exchange is needed. Household talks directly to Microsoft. The default public client ID is distributed in source and release builds. Set `HOUSEHOLD_MICROSOFT_CLIENT_ID` to use your own app.

For a custom Microsoft Entra app registration:

1. Select **Accounts in any organizational directory and personal Microsoft accounts**.
2. Under Authentication → Settings, enable **Allow public client flows**. No redirect URI or client secret is needed for device authorization.
3. The connector dynamically requests delegated `User.Read` (account identity), `offline_access`, and `Tasks.Read` or `Tasks.ReadWrite` (depending on the owner's selection). No application permissions or directory-wide access are requested.

An unverified publisher can require administrator approval in organizations; device-code authentication can also be blocked by tenant policy. Publisher verification does not override those policies. Personal-account consent and corporate policy behavior should be validated separately before promising support for a deployment. This connector targets the global Microsoft cloud (`login.microsoftonline.com`, `graph.microsoft.com`).

## Access and storage

Tasks are read and changed directly through Microsoft Graph on every request. There is no local task database, mirror, background synchronization or delta cache. The existing Household database stores only connection identity, credentials and bot grants for this connector.

Connections are isolated by Household workspace and account. Selected enabled bots may use them; sideworkers inherit their parent's current access, and scouts never have access. Removing a grant, disabling a bot, deleting its workspace or disconnecting cancels in-flight reads. Reconnection replaces only the matching account's grant in that workspace. Other accounts and installations remain independent.

Access and refresh tokens are kept in the host's private SQLite state and its private backups. They never appear in bot environments, configuration views or MCP responses. Tokens refresh on demand; revoked authorization marks the connection as needing reconnection. Task content is untrusted external data and can enter authorized bots' AI-provider context, chats and local history.

Disconnect deletes this host's saved credential and prevents future bot use. It does not revoke Microsoft account-wide consent or erase backups and earlier task content. Revoke the application's consent separately through your Microsoft account's app permissions (or your organization's My Apps portal) when needed.

## Agent tools

- `household_connectors_microsoft_accounts`: shared accounts and whether each is writable.
- `household_connectors_microsoft_operations`: supported operations and parameter schemas.
- `household_connectors_microsoft_request`: one operation using an account's connection ID.

Supported operations: list/get/create/update/delete task lists; list/get/create/update/delete tasks; list/create/update/delete checklist items. Task changes include title, body, importance, status, dates, reminders and recurrence. To finish a task, update `status` to `completed`; to reopen it, use `notStarted`. Dates include `dateTime` and `timeZone`. Plain-text bodies are escaped and sent as HTML, as required by To Do.

Reading collections returns `nextPageToken` when there are more results. Pass it as `pageToken` to the same operation with the same collection IDs. Page sizes are bounded to 50. Tokens cannot redirect requests to another host or collection. Some collections support Graph OData `filter` and `orderBy`; this is not a general Graph proxy or a cross-list full-text search service.

Writes require both explicit owner opt-in and Microsoft's granted `Tasks.ReadWrite` scope. Update/delete operations accept optional `ifMatch` ETags. A 412 means the object changed: read it again before editing. A 429 reports a retry interval. An uncertain mutation is never automatically retried: inspect the task/list before retrying to avoid duplicates. Responses are limited to 256 KiB and requests to 30 seconds.

This is the stable Graph v1.0 To Do API. Planner, My Day management, attachments, sharing/invitations, delta synchronization and push notifications are outside this connector's current operation registry.

References: [To Do API](https://learn.microsoft.com/en-us/graph/api/resources/todo-overview?view=graph-rest-1.0), [device authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code), [publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview).
