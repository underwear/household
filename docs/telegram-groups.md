# Telegram groups with topics

Create a private Telegram group, add your Household bot, and enable **Topics** in the group's settings. Make the bot an administrator with **Manage topics** and **Delete messages** rights. BotFather's private-chat Threaded Mode is not required for groups.

In Household, add a channel of type **Telegram Bot Group (topics)**. Enter the bot token and the supergroup's numeric chat id (`-100…`), then place your bots in it. The same Telegram bot can serve a private chat and a group within one workspace; they share one update poller and keep separate topic mappings.

Each bot gets its own topic. Topics created manually in Telegram are discovered automatically as shared `topic` places. Messages in them go to the channel's default bot; replies, edits and live status stay in that topic. Topics created while Household was offline are discovered on their next message. Names and addresses survive daemon restarts.

The `places` tool lists discovered topics and advertises `canCreatePlace`. On supporting channels, `place_create({title, place?})` creates another shared topic; `place` selects its channel, or the current request channel is used. This is an optional adapter capability: private Telegram chats and Slack do not advertise it. Only the channel default bot can list, create, read or write these topics. Other bots, sideworkers and scouts cannot access them, even by passing a known place id. Helpers cannot be spawned into these topics; select the parent bot’s own place instead.

By default, messages written in General are ignored: they are not delivered to any bot, including mentions, replies and commands. This also applies to General in private Telegram Threaded Mode.

Turn on **Forward General to the default bot** in the channel's settings (or `forwardGeneral: true` in the config, or `house channel set <workspace> <chat> --forward-general on`) to change that. Each message written in General is then forwarded into the default bot's own topic (a message naming another bot of the channel goes to that bot's), and the bot answers there. General gets a short note under the message with a link to the topic, at most once every ten minutes per person. Edits in General are passed to the bot but not forwarded again. In a group, everyone who writes in General reaches the bot this way, as a guest unless they are an owner. The bot needs no extra rights for this. Turn it off and General is ignored again. Scouts and sideworkers spawned from the group use that channel; a sideworker with `placement: "thread"` gets its own topic, while `placement: "same"` shares the requesting place. A failed destination prevents the sideworker's task from starting.

Visible copies of communication between bots and helpers use collapsed, expandable quotes in Telegram.

Group messages are visible to group members, and agents receive `audience: "group"` in their channel context. Being a Telegram group administrator does not make someone a Household owner: owner trust still uses the workspace's configured Telegram user ids.

Topic links use `https://t.me/c/<group>/<topic>`. Regular Telegram HTML replies, files, buttons, edits and typing are supported. Rich Markdown replies are not advertised for this channel. Closing a helper deletes its dedicated topic and messages; shared places remain.

Example channel configuration:

```yaml
kind: telegram-group
name: Team forum
token: <bot token>
chat: "-1001234567890"
pets: [sibling]
default: sibling
forwardGeneral: true # optional: General's messages go to sibling's topic
```
