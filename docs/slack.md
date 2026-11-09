# Slack adapter prototype

`slack-private` connects a house to a **one-to-one bot DM** using Socket Mode. Telegram and Slack can coexist in one house. One Slack app / workspace installation / token pair serves one house; several configured DMs can share that connection.

## What works

- The default pet replies directly in Messages, without forwarding notices or a permanent pet thread. Other placed pets, scouts and sideworkers use named threads. House routing selects the default pet or a pet named at the start of the message. Earlier default-pet threads remain readable with a notice pointing back to Messages.
- Slack mrkdwn replies, editing, Block Kit choices, owner-only House decisions, a changing progress message and Stop. Completed choices lose their buttons. Sender IDs include the workspace.
- Incoming edits and reactions; outgoing reactions; private file download and the current external file-upload flow (20 MB limit). Both directions were verified against a live Slack installation.
- Threads and the latest 1,000 handled event IDs survive daemon restarts. SDK heartbeat/reconnection; one socket shared across a bot's channels. Unknown workspaces/chats and bot-authored messages are ignored. An unknown thread gets a private navigation hint.
- Configuration through Channels in the web admin, CLI and the setup helper. `house doctor` checks the bot and DM. Tokens live only on the host, in the existing private config; they are not part of pet prompts or VM credentials.

In Slack, use **`!stop`** in Messages for the default pet, in a helper's thread, or use its Stop button. Use **`!secret`** for House-managed secrets: Slack intercepts ordinary slash commands, so this adapter translates the `!` form into the existing House command internally.

A bot cannot delete a user's Slack message. For this channel, `!secret` still performs owner/domain checks and the separate Save confirmation, stores the value on the host and exposes only the existing placeholder to the pet. House tells the owner to delete the original Slack message manually. Detected raw-token messages are withheld rather than offering to forward them to a VM. As elsewhere, secret detection is not a guarantee of recognizing every arbitrary secret string.

## Install

1. Create a Slack app from [`manifest.json`](../src/channel-adapters/slack/manifest.json). Socket Mode and interactivity are enabled. No tunnel or public callback endpoint is needed.
2. Install it in the intended workspace. Requested bot scopes are `chat:write`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, `files:read`, `files:write`. There is no user token or channel-history scope.
3. Copy the `xoxb-…` Bot User OAuth Token. Under Basic Information → App-Level Tokens, generate an `xapp-…` token with **only `connections:write`**.
4. In Household admin, open **Channels → Add channel → Slack Bot DM**. Paste both tokens in **App**, then enter your Slack member ID in **Your account** (Slack profile → More → Copy member ID).
5. Choose **Find my bot DM**. Household opens/resumes the private conversation automatically, without sending a message. Review the owner account, choose your pets and the **Default** pet that replies in Messages, then **Connect Slack**. The channel and owner access are saved together. Tokens stay on the host.
6. To change tokens, pets or the default later, choose **Edit** on the channel: one form, like every other channel's, with the bot DM read-only and a link to open it in Slack.

### Optional CLI setup

For scripted installations, save both tokens in a private file outside the checkout, mode `0600`:

   ```json
   { "botToken": "xoxb-…", "appToken": "xapp-…" }
   ```

Find your Slack member ID (`U…`, profile → More → Copy member ID). Run from the checkout:

   ```sh
   bun scripts/slack-setup.ts --credentials /private/path/slack.json --user U0123456789
   ```

   This validates the bot, opens/resumes your bot DM, and prints the workspace-qualified owner and DM IDs. It does not print credentials or modify Household config.

Start/restart Household **from this checkout** so the running daemon includes the new adapter. Then attach existing pets:

   ```sh
   bun scripts/slack-setup.ts --credentials /private/path/slack.json \
     --user U0123456789 --house work --pets sibling --apply
   ```

   The helper adds the Slack owner, adds or updates the channel, and requests reload. With several comma-separated pets, the first becomes the default. It refuses to write a Slack channel while an older daemon without this adapter is running.

The equivalent channel fields in `household.yaml` are:

```yaml
people:
  owners:
    slack: ["T0123456789:U0123456789"]
channels:
  - kind: slack-private
    name: Slack
    chat: "T0123456789:D0123456789"
    token: "xoxb-…"
    appToken: "xapp-…"
    pets: [sibling]
```

Keep the existing Telegram owner/channel alongside these. The web admin resolves the DM from your member ID; you do not need to copy a Workspace:DM address. CLI `channel add` and `channel set` also accept `--app-token`; the private-file helper avoids putting credentials in shell history/process arguments.

## Local proof of concept

```sh
bun scripts/slack-lab/server.ts
```

Open [the local lab](http://127.0.0.1:8793). `SLACK_LAB_PORT` changes the port. It binds only loopback and checks Host, Origin and a page-specific token on writes. Stop its process with Ctrl-C.

This lab uses **the real SlackChannel and House Chat router**, a synthetic Slack API, and a scripted agent. It does not call a model, start a VM, change network grants or send messages to a workspace. It demonstrates addressing, root threads, reply buttons, owner/guest checks and live Stop. Its state resets on process restart. Do not enter real secrets in the lab.

The separate integration test runs the **real official Socket Mode and Web API SDKs** against local HTTP/WebSocket endpoints and then through House routing. It exercises SDK acknowledgements, routing, reply/edit, guest denial, owner decisions and `!stop`.

```sh
bun test test/channel-adapters/slack.test.ts test/app/slack-chat.test.ts
bun run typecheck
```

## Prototype limits

- Live Slack-to-VM inference, interactive reply buttons, file upload/download, Stop process termination and subsequent recovery were verified on 2026-11-08. The separate local lab remains a scripted demonstration of the original threaded layout; live Slack uses the default-pet-in-Messages layout.
- Socket envelopes are acknowledged before asynchronous handling. A hard crash between that acknowledgement and House's durable enqueue can lose the event. There is no history catch-up/outbox reconciliation yet. API writes retry explicit short 429s; ambiguous network failures are not retried, to avoid duplicate posts.
- Owner approvals follow the existing House restart semantics; durable adapter card text does not resurrect an in-flight decision. Old live-status messages can remain after a crash.
- Bot DMs only: no groups, Slack Connect, slash commands, App Home directory or native assistant streaming/typing. Slack's notification settings still apply to status posts; the API used here cannot promise Telegram-style silent sends.
- A Slack thread cannot be removed wholesale like a Telegram topic. The adapter does not advertise `removePlace`; deleting a pet does not purge its Slack history. Unknown/deleted root-thread recovery is manual.
- `format=rich` is not advertised; use regular Slack mrkdwn. Long replies split into pieces; code fences crossing a split may need separate replies. Uploaded file handles cannot be edited/reacted to as text-message handles.
- One workspace installation per app in this prototype. Distinct apps may serve distinct houses. This avoids Socket Mode distributing a single app's events across independent, incompatible bot-token connections.

## Sources

- [Socket Mode and acknowledgements](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Official Node Socket Mode SDK](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/)
- [Threaded chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Open a bot DM](https://docs.slack.dev/reference/methods/conversations.open/)
- [External file uploads](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/)


## Code Channels investigation (2026-11-08)

Recommendation: keep the default pet in the bot DM; use a Code Channel for a bounded coding task / sideworker with its own workspace, branch and review artifacts. Short scouts can stay in ordinary task threads. Do not replace a permanent per-pet thread with a permanent per-pet Code Channel.

The authenticated [Code Channels docs](https://api.slack.com/partners/code-channels) describe task channels with status, a context bar, and managed tabs. These are distinct from the fixed Home/Messages/About tabs of App Home. Socket Mode works; no public tunnel is required. New integrations should use `agents.conversations.*`, not the transitional `codeChannels.*` names.

- [Creation](https://api.slack.com/partners/agent-conversations-create): bot token, `code_channels:manage`, manifest `features.code_channels.enabled: true`; stable `session_id` makes creation idempotent. Link an originating message to invite its author; explicitly private channels are appropriate for this personal setup. Workspace/user availability can still reject creation (`feature_disabled`, `user_not_enabled`, `accesslimited`).
- [Views](https://api.slack.com/partners/agent-conversations-setView): up to five views, at most one diff; HTML, diff, Block Kit and canvas. HTML/diff content is capped at 1 MB. HTML is sandboxed; `connect_domains` is documented as not yet honored, so embedding our live localhost admin is not a supported shortcut. Block Kit interactions can call our host backend through Socket Mode. Publish snapshots/artifacts instead.
- [Lifecycle](https://api.slack.com/partners/code-channels-lifecycle): ordinary top-level replies, processing/active/suspended/closed status, native stop event, archive with summary when done. A Code Channel is one session; independent session threads within it are not supported. Native stop must terminate the corresponding work and suppress further channel updates until resumed under explicit session semantics.
- Event access needs appropriate public/private history scopes; `message.session` narrows delivered events to sessions. This is an additional adapter/runtime integration, not simply switching the existing DM ID to a channel ID. Current DM adapter intentionally rejects C/G channels.
- Host credentials, House owner authorization, isolated VM identities and secret filtering must remain unchanged. Channel membership alone must never grant House owner privileges.

Availability checked: the installed app's scope picker offers `code_channels:manage`; a read-only `agents.conversations.listViews` probe returns `missing_scope`, naming that scope. This establishes the endpoint and permission requirement, **not** successful workspace enablement. No additional scopes were granted and no Code Channel was created during this investigation. Home dashboard and Code Channels are not implemented by this PoC.

Scouts capture the launch conversation and are placed only in that channel. A Slack launch never falls back to Telegram when the parent switches chats or the origin channel disappears. This was verified with a live scout and a two-channel regression test.

### Explicit places

Chat headers now include `place: { id, kind, title }`. Public place IDs keep the existing address shape, e.g. `inbox@c2` or `pet:sibling@c2`, with a Household channel ID instead of a vendor chat ID. `places` lists destinations and whether their channel is available.

- `reply({text, place})`, `send_file({path, place})` and `channel_format({place})` select an exact place. Legacy `channel` remains supported; supplying both is an error. Reply/file results include `place`.
- `scout_spawn({scout, task, place, placement})` and `sideworker_spawn({cwd, task, place, placement})` take the parent's place. `placement: "thread"` (default) creates the helper's dedicated place in that channel; `"same"` shares the selected place. Spawn returns the helper's public place. Spawning inside another helper's temporary place is refused; use the parent's own place or inbox.
- With no destination, a tool inherits the active request's exact place. Later delivered messages and explicit sends elsewhere do not move that default. Without request context, a single attached destination can be used; multiple channels require explicit selection. Session loss clears the default.
- Helper placement is captured before asynchronous setup and persisted. Removing its channel never relocates the helper to another platform. Approval cards at launch stay in the selected parent place; subsequent scout decisions stay with the scout.
- In a shared pet thread, address a helper with `name, ...` or reply to its message. Unaddressed conversation still goes to the original pet. Closing a shared helper never deletes the shared place.
- Slack threads remain as history after a helper ends. Telegram's existing dedicated-thread cleanup remains supported; shared places are protected.

Owner CLI also accepts `house scout run <house> <name> --pet <pet> --place <place-id> --placement same|thread --task <text>`.
