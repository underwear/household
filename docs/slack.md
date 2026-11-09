# Slack

A workspace can talk to you in a Slack bot DM, alongside Telegram or instead of it. The connection uses Socket Mode: no public URL or tunnel. The tokens stay on the host and never reach a bot.

## How it works

- Your **default bot** answers right in the DM's Messages. Address another bot by starting your message with its name or alias.
- Other bots, scouts and sideworkers work in their own threads. A thread Household does not recognise gets a short hint on where to talk.
- Bots show progress in one updating message, ask with buttons, react, edit their replies and send and receive files up to 20 MB.
- Only owners can answer workspace decisions. Messages from bots, other workspaces and other chats are ignored.

Slack takes ordinary slash commands for itself, so type them with `!`:

- **`!stop`** stops the bot you are talking to: in Messages, the default bot; in a thread, that thread's bot. Or press **Stop** on its progress message.
- **`!secret`** saves a secret as `/secret` does elsewhere. A bot cannot delete your message, so delete the original by hand afterwards.

## Connect Slack

1. **Create the app.** At [api.slack.com/apps](https://api.slack.com/apps), create an app from the Household [`manifest.json`](../src/channel-adapters/slack/manifest.json) and install it in your workspace. It asks only for DM, reaction and file scopes: no channel history, no user token.
2. **Copy two tokens.** The Bot User OAuth Token (`xoxb-…`, under OAuth & Permissions), and an app-level token (`xapp-…`, under Basic Information → App-Level Tokens) with **only** `connections:write`.
3. **Add the channel.** In the admin, **Channels → + Add channel → Slack Bot DM**:
   - **App** — paste both tokens.
   - **Your account** — your Slack member ID (your profile → More → Copy member ID). Choose **Find my bot DM**: Household finds your DM with the bot, sending nothing. That account becomes an **owner** of the workspace: it can command its bots and approve their requests.
   - **Bots** — the name, the bots in this DM and the default one. **Connect Slack** saves the channel and the owner together.

To change tokens, bots or the default later, choose **Edit** on the channel. **Open in Slack** on its row takes you to the DM. `house doctor` checks the bot and the DM.

One Slack app serves one workspace. For another workspace, create another app.

### Without the admin

From a source checkout, the setup helper reads the tokens from a private file (mode `0600`) so they stay out of your shell history:

```json
{ "botToken": "xoxb-…", "appToken": "xapp-…" }
```

```sh
# Check the bot and find your DM; changes nothing:
bun scripts/slack-setup.ts --credentials /private/path/slack.json --user U0123456789
# Add the owner and the channel to a workspace (the first bot is the default):
bun scripts/slack-setup.ts --credentials /private/path/slack.json --user U0123456789 --workspace work --bots sibling --apply
```

`house channel add --kind slack-private --app-token …` works too. In `household.yaml` it is (the saved channel key remains `pets` for compatibility):

```yaml
people:
  owners:
    slack: ["T0123456789:U0123456789"]   # workspace:member
channels:
  - kind: slack-private
    name: Slack
    chat: "T0123456789:D0123456789"      # workspace:DM
    token: "xoxb-…"
    appToken: "xapp-…"
    pets: [sibling]
```

## Limits

- **Bot DMs only.** No channels or group chats, Slack Connect, slash commands or App Home.
- **Status messages notify.** Slack has no silent sends: its own notification settings apply to progress posts.
- **Threads stay.** Slack cannot delete a thread the way Telegram deletes a topic: removing a bot or a helper leaves its threads as history.
- **Rare loss on a crash.** An event Slack delivered at the moment the daemon crashed can be lost, and missed messages are not fetched later. An old progress message can be left behind.
- **Long replies** are split into several messages; a code block across a split may break.
