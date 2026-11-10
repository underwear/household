# Channel-specific tools

Channel adapters can expose optional `Channel.tools()` capabilities. Each capability declares a name, description, argument schema and implementation. The core contract stays independent of MCP and platform APIs. Adapters without capabilities need no changes.

Agents discover capabilities with `channel_tools({place})` and invoke them with `channel_tool({name, arguments, place, id?})`. Omitted `place` uses the current request destination, or the only available destination; ambiguity is refused. Discovery is per destination, so unsupported tools are never advertised for that channel. These tools are available to regular bots; scouts and sideworkers do not receive them.

The application resolves destinations from authenticated identity, checks access, rejects unknown/missing arguments, enforces the reply budget and journals newly posted messages. Tools with `target: "own-post"` receive an opaque post reference only after ownership and place checks. Adapters validate argument types and platform limits before API calls; schemas alone do not validate inputs. Arguments must never select arbitrary vendor chats, users or messages.

Adapters return a history summary and, for a newly posted message, its opaque post reference. Adapter interactions use `InboundMessage` text with `interaction: true`, `replyTo` and structured `external` metadata. The app routes them only to the original post's still-placed author, with normal trust and deduplication checks. Deleted authors do not transfer their interactions to the default bot.

## Telegram widgets in private chats

Both ordinary DMs and private chats with bot topics support:

- `telegram_send_widget`: `html`, a required plain-text `caption`, optional `chat_data`, `public_data`, `width`, `height`.
- `telegram_update_widget`: optional `chat_data` and `public_data` (at least one), plus the original Household message `id` in the outer `channel_tool` call. Pass the same `place` as the send result.

Example inner arguments for `telegram_send_widget`:

```json
{
  "caption": "A counter — tap + to increment",
  "html": "<p id=\"count\"></p><button onclick=\"TelegramWidget.request('increment')\">+</button><script>function render(){var s=JSON.parse(TelegramWidget.chatData||'{\\\"count\\\":0}');document.getElementById('count').textContent=String(s.count)}TelegramWidget.onEvent('chatDataChanged',render);render()</script>",
  "chat_data": "{\"count\":0}"
}
```

A request is delivered as an `interaction` event with `trust: automation`, `event.on.id` identifying the widget, and content `Widget action: increment`, with `channel.meta.widget` containing `{event: "data", data: "increment"}` and the original widget reference in the event header. Requests can originate automatically from widget code; they do not provide new user authorization and never answer open Household dialogs. The bot can then call `telegram_update_widget` with `chat_data: '{"count":1}'`.

The adapter acknowledges receipt before agent delivery (Telegram's deadline is 15 seconds). This acknowledgement is not completion of the action. State updates arrive separately; no agent answer is held inside the widget request. Widget mappings survive daemon restarts. Unknown widgets, other users, wallet-signing requests and unsupported chat destinations are not delivered to agents.

No separate web server, webhook or hosted page is needed: HTML goes through Bot API, clicks through the existing long poll. HTML is immutable after sending; new layouts require a new widget. HTML must fit 32,768 UTF-8 bytes and 4,096 bytes compressed with zlib level 9; each state string fits 1,024 UTF-8 bytes. Widgets have no network access, external dependencies, keyboard inputs or scrolling. Avoid background polling: every accepted request can start an agent turn.

Groups, inline/shared widgets and wallet actions are outside this implementation. Current production availability and the supported HTML/JS profile are documented in [Telegram Widgets](https://core.telegram.org/bots/widgets) and the [Bot API](https://core.telegram.org/bots/api#sendwidget).
