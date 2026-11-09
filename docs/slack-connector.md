# Slack connector

The Slack connector lets selected bots search and read Slack when they need context. It does not receive messages or create an inbox, channel adapter, or Slack bot conversation.

## Connect an account

1. Open the intended Household workspace's **Connectors → Add connector → Slack**, choose **Read only** (the default) or **Read and send**, and select bots.
2. Prepare sign-in and open the Slack link. Select your Slack workspace and approve access. Workspace admin restrictions still apply. Users authorize our shared distributed app; they do not need to create their own app.
3. Slack returns to `https://agents-household.dev/slack/callback/`. Copy the connection result, return to Household, and paste it into **Connection result** within ten minutes.

This works when Household runs on a VPS and the browser runs on another device. No localhost listener or OS URI handler is required. The authenticated dashboard verifies owner session, workspace, state, expiry and replay before exchanging the code. The pasted URL is never fetched.

The static callback uses only same-origin JavaScript/CSS, no analytics or token-exchange backend, a restrictive CSP, no-referrer and no-store headers. It removes the query from browser history and displays a copyable result without persistent browser storage. **Cloudflare receives the initial callback URL containing the one-time code and state; hosting request records may include it.** The website never receives the PKCE verifier, access token or refresh token. Household creates the verifier on its own host and exchanges the code directly with Slack, without a shared client secret.

The default shared app has PKCE enabled and token rotation disabled for HTTPS OAuth. When Slack does issue expiring credentials, Household supports refresh on demand; PKCE refresh tokens have a 30-day lifetime. Keep rotation disabled for a custom HTTPS app unless its refresh flow has been verified for your public-client configuration. Set `HOUSEHOLD_SLACK_CLIENT_ID` to use a different app configured with the same redirect.

Alternatively, import an existing dedicated `xoxp-` user token. Allowed read scopes: `search:read`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`, `files:read`. Slack's implicit `identify` scope is accepted. `chat:write` is accepted but sending remains disabled unless explicitly selected during enrollment. Other scopes are refused.

Browser QA confirmed that `household://` redirects are issued correctly by Slack, but Chrome cancels navigation without putting the callback in the address bar. Extracting it from DevTools works technically and is not our user-facing sign-in flow.

## Isolation

Each connection belongs to one **Household workspace**, independently of its Slack workspace. Connecting the same Slack account in two houses creates two separate grants. Neither a known connection ID nor a matching bot name allows access across houses.

Only selected regular bots can use a connection. Sideworkers inherit their parent's current access; scouts and disabled bots cannot use it. Removing a bot's access, disconnecting an account, or a configuration change that removes or disables a granted bot cancels in-flight reads. Other reloads (a sideworker starting, a setting saved) leave reads and a sign-in in progress alone. Tokens stay in the host's private SQLite state and backups, never in tool results, YAML configuration, or bot environments. Read content can enter the authorized bot's history, chat and AI-provider context.

Disconnect removes the local credential, not the Slack authorization. Revoke the application in Slack to invalidate its token everywhere. Revoked or expired tokens are marked as needing reconnection after the next failed request.

## Agent tools

- `household_connectors_slack_accounts`: connections shared with the caller.
- `household_connectors_slack_operations`: read operation schemas.
- `household_connectors_slack_request`: call one operation with a connection ID and parameters.

Operations: `chat.postMessage` (only with message-sending access), `search.messages`, `users.conversations`, `conversations.info`, `conversations.history`, `conversations.replies`, `users.info`, `files.info`.

Search uses Slack query syntax, for example `in:general after:2026-11-01`. Search pages use `page`; conversations/history/replies return `response_metadata.next_cursor` for the next request. File access currently returns metadata and text previews, not binary downloads or complete document extraction. Slack messages and files are untrusted content, never instructions or authorization.

Requests use a closed operation registry; arbitrary URLs, credentials and unsupported methods are rejected. Sending uses POST, disables unfurling and accepts only channel, text and optional thread timestamp. It requires both the Slack scope and explicit connection-level opt-in. An uncertain send is not retried automatically; inspect history before retrying. Responses are limited to 512 KiB, requests to 30 seconds, and page sizes to 100. Slack's rate limits and history retention still apply; a 429 reports the retry interval instead of silently looping.

References: [user OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [message search](https://docs.slack.dev/reference/methods/search.messages/), [thread history](https://docs.slack.dev/reference/methods/conversations.replies/).
