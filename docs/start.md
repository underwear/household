# Quick start

From a bare machine to a bot answering you in your messenger.

## What you need

- **A Mac on Apple silicon**, or **Linux with `/dev/kvm`**: your own machine, a VM with nested virtualization, or a VPS that offers KVM. An Intel Mac only through such a Linux VM.
- `python3` and `openssl` on it.
- **A key for the harness:** a Claude subscription or Anthropic API key for Claude Code, or a ChatGPT subscription or OpenAI API key for Codex.

Don't like typing? Give this to your coding harness:

```text
Read https://agents-household.dev/llms.txt and help me set up Household on my machine.
```

## 1. Install

```sh
curl -fsSL https://agents-household.dev/install.sh | sh
```

It installs the newest release into `~/.household`, with everything it needs inside: no Docker, no Bun, no sudo. It tells you if something is missing, such as `~/.household/bin` on your `PATH`. Then check that microVMs can run here:

```sh
house doctor
```

## 2. Onboard

```sh
house onboard
```

It asks, one step at a time:

1. **Harness and its key** — Claude Code or Codex; paste a Claude token (`claude setup-token` makes one) or an API key, or use the ChatGPT login of the Codex on this machine.
2. **Workspace** — a name for your bots' home.
3. **Telegram** — create a bot with [@BotFather](https://t.me/BotFather), turn on **Threaded Mode** in its Mini App (Bot Settings → Threads Settings), press **Start** in a chat with your bot, and paste its token. You become the workspace's owner.
4. **Bot** — its name and display name.
5. **Scouts** — on or off.
6. **Sideworkers** — on or off. You can change both later in the admin.

You can run `house onboard` again any time.

## 3. Start

```sh
house start
```

The first start downloads the bot's VM image, so give it a minute. `house status` shows your bot as `running` when it is ready.

To keep Household running after you close the terminal, run `house start` as a service (launchd on a Mac, a systemd user service on Linux). Only one daemon at a time.

## 4. Say hi

For a shared group with a topic per bot, see [Telegram groups with topics](../telegram-groups/).

Open your Telegram channel and write to your assistant bot. It answers in its own thread. 🤖

For an ordinary private conversation without threads, add a channel in the admin with kind **Telegram Bot DM** (`telegram-dm`), your Telegram user id as the chat id, and a BotFather token. Threaded Mode is not required. Press **Start** in the bot's Telegram chat, and assign your assistant to the channel.

All replies and files stay in that chat. If you assign several assistants, choose a default; address another by name (for example, `Chef, plan dinner`) or reply to one of its messages. Replies include the assistant's name. The Stop button and `/stop` always stop the channel's default assistant, even when replying to another assistant. The existing **Telegram Bot DM (threaded)** kind remains `telegram-private`. Connect a particular bot and chat in only one of these modes.

Example channel entry:

```yaml
kind: telegram-dm
token: YOUR_BOT_TOKEN
chat: "100200300"
pets: [sibling]
```

The adapter omits `message_thread_id` when sending to this channel; see the [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).


Then open the admin:

```sh
house dashboard
```

It prints a one-time link (valid 60 seconds) and opens it. The admin lives at `http://127.0.0.1:8780`, on this machine only. On a remote server, forward the port first: `ssh -L 8780:127.0.0.1:8780 <server>`, then run `house dashboard --no-open` there and open the link on your computer.

## Next

- [Bots](../bots/) — everything on a bot's page.
- [Scouts](../scouts/) — let bots use the internet and your keys safely.
- [Inboxes](../inboxes/) — mail, alerts and feeds for your bots.
- [Back up and move](../backup/) — keep a copy of everything.
- `house update` moves to the newest release; `house --help` lists everything else.
