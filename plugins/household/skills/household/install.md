# Installing and setting up Household

Work through the steps in order. After each, check it before going on. Run `house doctor` whenever unsure: it
checks Docker, microsandbox, openssl, python3, the config, every key, every bot and the daemon, and says what is
wrong.

## 1. Requirements

- **macOS on Apple silicon**, or **Linux with KVM** (`ls -l /dev/kvm`, and the user in the group that owns it).
- **Bun**: `curl -fsSL https://bun.sh/install | bash`, then a new shell (`bun --version`).
- **microsandbox 0.7.13** exactly (Household checks the version):
  macOS `brew install superradcompany/tap/microsandbox`, then `msb --version`. On Linux follow
  https://microsandbox.dev for 0.7.13.
- **Docker**, to build the VM images: on macOS OrbStack (`brew install --cask orbstack`, then open it once), on
  Linux Docker Engine. `docker info` must work without sudo.
- **openssl** and **python3** (macOS: `brew install openssl python`).

Installing apps and using sudo are the user's call: ask first.

## 2. Household

Install a release, not the `main` branch (which moves between releases): clone, then check out the newest
version tag.

```sh
git clone https://github.com/underwear/household ~/household
cd ~/household && git checkout "$(git tag --sort=-v:refname | head -1)"
bun run setup
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bun "$HOME/household/src/cli/main.ts" "$@"\n' > ~/.local/bin/house && chmod +x ~/.local/bin/house
house --version && house doctor
```

`~/.local/bin` must be on `PATH`. `house --version` shows the release. At this point doctor reports no config and
no daemon: that is expected. Releases and their notes: https://github.com/underwear/household/releases

## 3. An agent key

Pick by the agent the user wants. The user runs these; you never see the value.

**Claude Code pets** (`claude-code-tmux`) need an Anthropic key, either:

- a **Claude subscription** (Pro or Max): with Claude Code installed, the user runs `claude setup-token`, signs in
  in the browser and copies the printed token (`sk-ant-oat01-…`, valid for a year). Then:
  `pbpaste | house key add claude --provider anthropic` (Linux: paste after running
  `house key add claude --provider anthropic`, then Enter and Ctrl-D);
- or an **API key** from https://console.anthropic.com → API Keys (`sk-ant-api03-…`), added the same way.

**Codex pets** (`codex-app-server`) need an OpenAI key, either:

- a **ChatGPT subscription**: with the Codex CLI installed (`npm i -g @openai/codex`),
  the user runs `house key codex codex` and completes the device sign-in it shows. This login is Household's own,
  separate from the user's Codex, and goes into Household's backups;
- or an **API key** from https://platform.openai.com/api-keys: `pbpaste | house key add openai --provider openai`.

Check: `house ls` lists the key with its kind (subscription or API key), and `house doctor` checks it.

## 4. A house and its network

```sh
house create work
house allow work github.com          # host, host:port (443 by default), '*.example.com' (subdomains only)
```

A new house reaches only what its pets' agents need (their model APIs). Add hosts the user's work needs, one by
one. `house allow work '*'` opens every public host on 443 — ask first; private addresses stay closed whatever
the allowlist says, except an exact entry (`db.internal:5432`). Pets can also ask for a host from the chat; the
owner approves it there.

## 5. A pet

```sh
house pet add work assistant --key claude --title Assistant
```

`--key` is required. `--agent codex-app-server --key codex` for a Codex pet. Defaults: agent `claude-code-tmux`,
model `opus` (Codex: its default model), 2 vCPU and 1 GiB (`--cpus`, `--memory` in GiB). A pet is in no chat until
a channel lists it.

## 6. The Telegram bot

The user, in Telegram:

1. **@BotFather** → `/newbot` → a name and a username → copy the token (`123456789:AAH…`) into a file only they
   read, or keep it on the clipboard.
2. In BotFather's **Mini App** (the menu button) → the bot → **Bot Settings** → **Threads Settings** → turn
   **Threaded Mode** on. Household refuses a bot without it. In the same screen, tick the switch that stops users
   from creating threads themselves: Household opens a thread for each pet and scout, and a thread the user
   makes by hand belongs to none of them.
3. Open a private chat with the new bot and press **Start**.
4. Get their numeric Telegram user id, e.g. from **@userinfobot** (`Id: 123456789`). It is not a secret.

Then, with the id they gave you:

```sh
house owner add work telegram <user id>
pbpaste | house channel add work --kind telegram-private --chat <user id> --pets assistant
```

The token is read from stdin and checked with Telegram before it is saved. One bot per house.

## 7. Start and check

```sh
house start          # foreground; Ctrl-C stops it. For good, make it a service (step 8)
```

In another terminal: `house status` (each pet `running` after its first image build, which takes minutes),
`house doctor` (all ✓). Then the user writes to the bot: the pet answers in its thread.
`house dashboard` prints a one-time sign-in link to the web UI (http://127.0.0.1:8780).

## 8. As a service

`house start` stops cleanly on SIGTERM and exits non-zero only when it cannot run: restart it on failure.

**macOS**: write `~/Library/LaunchAgents/dev.household.plist` (absolute paths; `PATH` must find `docker`,
`openssl` and `msb`), then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.household.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.household</string>
  <key>ProgramArguments</key>
  <array><string>/Users/ME/.bun/bin/bun</string><string>/Users/ME/household/src/cli/main.ts</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/Users/ME/Library/Logs/household.log</string>
  <key>StandardErrorPath</key><string>/Users/ME/Library/Logs/household.log</string>
</dict>
</plist>
```

Stop: `launchctl bootout gui/$(id -u)/dev.household`. Restart: `launchctl kickstart -k gui/$(id -u)/dev.household`.

**Linux**: `~/.config/systemd/user/household.service`, then `systemctl --user enable --now household` and
`loginctl enable-linger $USER` (so it runs without a login session). Logs: `journalctl --user -u household -f`.

```ini
[Unit]
Description=Household

[Service]
ExecStart=%h/.bun/bin/bun %h/household/src/cli/main.ts start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Only one daemon may run: stop a foreground `house start` before starting the service.
