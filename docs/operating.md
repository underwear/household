# Updates and troubleshooting

Household runs on your own machine, so keeping it up to date and fixing it when something goes wrong is up to you. This page shows how to update it, keep it running in the background, check that it works, read its logs, and fix the problems people run into most.

## Update Household

```sh
house update
```

This downloads the newest release, checks it, and installs it next to the one you have. The release before stays on disk, so you can go back to it. To install a particular release instead, give its tag: `house update v0.10.2`. Release notes are on [GitHub](https://github.com/underwear/household/releases).

The running Household keeps using the old release until you restart it:

- In a terminal: press Ctrl-C, then run `house start` again.
- As a background service: restart the service (see below).

When it starts, the new release first copies your config and database aside, then moves them to the new format if it needs to. `house migrate` shows what it will change. Afterwards, `house doctor` and `house status` should both look clean.

**To go back** to the release before, stop Household, then:

```sh
house update <previous tag>
house migrate backups               # the copies taken before migrating, newest first
house migrate restore <backup>
```

An older release refuses a config or database that a newer one has already changed, which is why you restore the copy as well.

## Run it in the background

`house start` runs in the foreground and stops with the terminal. To keep Household running after you log out and after a reboot, run `house start` as a service: launchd on a Mac, a systemd user service on Linux.

Set the service to start it again **whenever it exits**, a clean exit too: `KeepAlive` set to `true` for launchd, `Restart=always` for systemd. A service that restarts only "on failure" can leave Household down. Make sure the service's `PATH` finds `python3` and `openssl`.

Run only one Household at a time. While the service runs it, stop and restart it through the service, not with Ctrl-C or `house start`.

<details>
<summary>An example for a Mac (launchd)</summary>

Save this as `~/Library/LaunchAgents/dev.agents-household.house.plist`, with your user name in place of `YOU`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agents-household.house</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.household/bin/house</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/household.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/household.log</string>
</dict>
</plist>
```

- Start it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.agents-household.house.plist`
- Restart it, for example after an update: `launchctl kickstart -k gui/$(id -u)/dev.agents-household.house`
- Stop it: `launchctl bootout gui/$(id -u)/dev.agents-household.house`

</details>

<details>
<summary>An example for Linux (systemd)</summary>

Save this as `~/.config/systemd/user/household.service`:

```ini
[Unit]
Description=Household

[Service]
ExecStart=%h/.household/bin/house start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

- Start it, and at every boot: `systemctl --user daemon-reload && systemctl --user enable --now household`
- Keep it running while you are logged out: `loginctl enable-linger $USER`
- Restart it, for example after an update: `systemctl --user restart household`
- Stop it: `systemctl --user stop household`
- Its output: `journalctl --user -u household`

</details>

## Check that it runs

| Command | What it tells you |
| --- | --- |
| `house status` | Whether Household is running, the admin's address, and each bot's state |
| `house doctor` | What this machine, the config, your keys and your Telegram bots still need: ✓ is fine, ✗ needs fixing |
| `house ls` | Your keys, workspaces, bots and channels, without any secret values |
| `house workspace show <workspace>` | A workspace's bots and their state, channels, owners and allowed hosts |
| `house bot show <workspace> <bot>` | What runs a bot, what it is given and what it uses now |

In the admin, **Workspaces** shows every workspace at a glance, and **Workspace → Bots** shows each bot as **Running**, **Not started**, **Stopped** or **Disabled**.

## Read the logs

**In the admin**, open a bot and press **Logs** at the top of its page:

- **Activity** is what Household did with the bot: messages in and out, its turns, and problems. Press **Network** to see its network requests too, allowed or denied. Use **Search…** to filter, and **Live** or **Paused** to follow new lines or not.
- **Setup**, **On start**, **Docker** and **Kernel** are logs from inside the bot's VM. **Setup** is the first place to look when a bot does not start.

**Console**, next to **Logs**, shows the bot's terminal as it is right now, read-only. It helps when the bot seems stuck on a question.

**In a terminal:**

```sh
house logs --problems                       # only what went wrong
house logs --bot <bot> -f                   # one bot, following new lines
house logs --bot <bot> --kind network       # its network requests, and why one was denied
house bot logs <workspace> <bot> --source setup
house bot screen <workspace> <bot>          # its terminal right now
```

`house logs` also takes `--workspace`, `--grep <words>` and `-n <lines>`, and it works while Household is stopped.

## Get into the admin

```sh
house dashboard
```

It prints a one-time sign-in link and opens it in your browser. The link works once, for 60 seconds. If the admin says **That link expired or was used**, run the command again. **Sign out** ends your session; `house dashboard` signs you in again.

The admin is at `http://127.0.0.1:8780` and listens only on this machine. On a remote server, forward the same port from your computer with `ssh -L 8780:127.0.0.1:8780 <server>`, run `house dashboard --no-open` on the server, and open the link on your computer.

## Common problems

**`house: command not found` after installing.** Add `~/.household/bin` to your `PATH`. The installer prints the exact line for your shell.

**`house doctor` says virtualization is unavailable.** Bots need hardware virtualization. On Linux, `/dev/kvm` must exist and be usable by you: add yourself to its group and log in again. On a VPS, pick one that offers KVM or nested virtualization. Intel Macs are not supported.

**`python3` or `openssl` is missing.** Install it (on a Mac, `brew install python3 openssl`; on Linux, your package manager). If Household runs as a service, make sure the service's `PATH` finds it.

**"daemon not running; start it with `house start`".** Household is not running. Start it, or start its service.

**"a daemon is already running".** Only one Household runs at a time. Your background service probably runs it already: check with `house status`.

**Household stops right after it starts.** Read the last lines it printed, or the service's log. `house doctor` points at config errors. If it says other users can read your config, run the `chmod 600` command it shows: the config holds your keys and bot tokens.

**A bot stays starting, or shows Not started.** Its first start downloads the VM image, which takes a minute or two. If it takes longer, open **Logs → Setup** on the bot's page, or run `house bot logs <workspace> <bot> --source setup`. A failing setup script is fixed on the bot's **Environment** tab.

**A bot does not answer in the chat.**

- Check that Household runs and the bot is **Running**.
- Check that the bot is in that channel: the switch on its **Channels** tab.
- Check that you are an owner: **Workspace → Channels → Owners**. Only owners can give bots orders.
- Look at **Console**: the harness may be waiting for an answer on screen.
- For **Telegram, a thread per bot**, `house doctor` tells you if Threaded Mode is off. Turn it on in BotFather: **Bot Settings → Threads Settings**.
- For a Telegram group, Topics must be on, and the bot must be an admin with **Manage topics** and **Delete messages**.
- Use each Telegram bot token in one place only. If another program or another Household uses the same token, Telegram hands each message to only one of them.

**Bots stop getting answers from the model.**

- A Claude sign-in ends about once a month. Your bots' chats get a reminder for five days before. Sign in again in **Settings → Keys → Sign in again**, or with `house key claude <name>`.
- After restoring a backup, a signed-in key shows "Not signed in on this Household". Sign in again the same way.
- A Claude subscription token lasts a year. Make a new one with `claude setup-token`, and replace the old one in **Settings → Keys** or with `house key set <name>`.
- A subscription has a usage allowance. When it is used up, **Settings → Keys** says so, and bots on that key get no answers until it resets.

⚠️ You can let bots go on past the allowance: edit the key and turn on **Go on in overage (billed apart from the subscription)**, or run `house key set <name> --allow-overage on`. Your provider bills that usage separately, so it costs extra money.

**A bot cannot reach a website or service.** It reaches only the hosts the workspace allows. A bot should ask you in the chat. You can also add it yourself: **Workspace → Network → Domains allowlist → Add host**. `house logs --bot <bot> --kind network` tells you why a request was denied. Private and local addresses are never allowed. See [Network and secrets](../network/).

**Something broke after an update.** Go back to the release before, as shown in [Update Household](#update-household), and report the problem on [GitHub](https://github.com/underwear/household/issues).
