# Updates and troubleshooting

`house update` keeps Household current, a background service keeps it running, and most problems show up in `house doctor` or in a bot's logs. Troubleshooting below is ordered by what you see.

## Update Household

```sh
house update            # the newest release; `house update v0.10.2` for a given one
```

It installs the release next to the one you have and keeps the one before on disk. The running Household keeps the old release until you restart it: Ctrl-C and `house start` again, or restart the service. On its first start, the new release copies your config and database aside, then moves them to the new format if it needs to (`house migrate` shows what it will change). Afterwards `house doctor` and `house status` should be clean. Release notes are on [GitHub](https://github.com/underwear/household/releases).

**To go back**, stop Household, then:

```sh
house update <previous tag>
house migrate backups               # the copies taken before migrating, newest first
house migrate restore <backup>
```

An older release refuses a config or database a newer one has changed, which is why you restore the copy too.

## Run it in the background

`house start` runs in the foreground and stops with the terminal. To keep Household running after you log out and after a reboot, run `house start` as a launchd service on a Mac or a systemd user service on Linux. The service must:

- **start it again whenever it exits, a clean exit too**: `KeepAlive` set to `true` for launchd, `Restart=always` for systemd. A service that restarts only on failure can leave Household down;
- **have a `PATH` that finds `python3` and `openssl`.**

Run only one Household at a time. While a service runs it, stop and restart it through the service, not with Ctrl-C or `house start`, or the service starts it again.

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
- Restart it, after an update say: `launchctl kickstart -k gui/$(id -u)/dev.agents-household.house`
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
- Restart it, after an update say: `systemctl --user restart household`
- Stop it: `systemctl --user stop household`
- Its output: `journalctl --user -u household`

</details>

## Check that it runs

| Command | What it tells you |
| --- | --- |
| `house status` | Whether Household runs, the admin's address, each bot's state |
| `house doctor` | What the machine, the config, your keys and your Telegram bots still need: ✗ needs fixing |
| `house ls` | Your keys, workspaces, bots and channels, without secret values |
| `house workspace show <workspace>` | A workspace's bots, channels, owners and allowed hosts |
| `house bot show <workspace> <bot>` | What runs a bot and what it uses now |

## Read the logs

In the admin, a bot's logs are under **Logs** on its page. **Activity** is what Household did with the bot, with its network requests if you turn them on; **Setup** is the first place to look when a bot does not start. **Console** shows the bot's terminal read-only, for a harness that has one, such as Claude Code.

From the terminal (`house logs` works while Household is stopped, too):

```sh
house logs --problems                       # only what went wrong
house logs --bot <bot> -f                   # one bot, following new lines
house logs --bot <bot> --kind network       # its network requests, and why one was denied
house bot logs <workspace> <bot> --source setup
house bot screen <workspace> <bot>          # its terminal right now
```

## Back up and restore

`house export` writes your config with its keys, the database and the bots' homes into one archive; `house import <file>` restores it with Household stopped. The archive holds your keys in plain form. See [Back up and move](../backup/).

## Troubleshooting

### Household won't install or start

- **`house: command not found`.** Add `~/.household/bin` to your `PATH`; the installer printed the exact line for your shell.
- **`house doctor` says virtualization is unavailable.** On Linux, `/dev/kvm` must exist and be usable by you: add yourself to its group and log in again. On a VPS, pick one with KVM or nested virtualization. Intel Macs are not supported.
- **`python3` or `openssl` is missing.** Install it (`brew install python3 openssl` on a Mac, your package manager on Linux). If Household runs as a service, check that the service's `PATH` finds it.
- **"daemon not running".** Start it with `house start`, or start its service.
- **"a daemon is already running".** Your service probably runs it already: `house status`.
- **It stops right after it starts.** Read the last lines it printed, or the service's log. `house doctor` points at config errors. If it says others can read your config, run the `chmod 600` command it shows: the config holds your keys and bot tokens.

### A bot doesn't start

Its first start downloads the VM image, which takes a minute or two. If it takes longer, read its setup log (**Logs → Setup**, or `house bot logs <workspace> <bot> --source setup`). A failing setup script is fixed on the bot's **Environment** tab, or by asking the bot once it runs.

### A bot doesn't answer

- Check that Household runs and the bot is running: `house status`.
- Check that the bot is in that channel, and that you are an owner of the workspace. A bot does not take orders from guests.
- Look at **Console**: the harness may be waiting for an answer on screen.
- For a Telegram group, Topics must be on, and the Telegram bot must be an admin with **Manage topics** and **Delete messages**. For a private chat with a thread per bot, Threaded Mode must be on in BotFather; `house doctor` tells you if it is off.
- Use each Telegram bot token in one place only. If another program or another Household uses it, Telegram hands each message to only one of them.

### Sign-in expired, or the model stops answering

- **A Claude sign-in** ends about once a month. From five days before, the chats of its bots get a daily reminder. Sign in again next to the key in **Settings → Keys**, or with `house key claude <name>`.
- **After restoring a backup**, a signed-in key says it is not signed in on this Household. Sign in again the same way.
- **A Claude subscription token** from `claude setup-token` lasts a year. Make a new one and replace the old one in **Settings → Keys** or with `house key set <name>`.
- **A used-up allowance.** A subscription's bots get no answers until its allowance resets; **Settings → Keys** says so.

⚠️ You can let a key's bots go on past the allowance with `house key set <name> --allow-overage on`, or the same switch on the key. Your provider bills that usage apart from the subscription.

### A bot can't reach a site

A bot reaches only the hosts its workspace allows, and should ask you in the chat for a new one. `house logs --bot <bot> --kind network` says why a request was denied. You can add a host yourself on **Workspace → Network**. A bot's own request for a name that points into a private network is refused without asking you; if you do want it to reach such a host, add it to the allowlist yourself. See [Network and secrets](../network/).

### The admin won't open

- **"That link expired or was used".** A sign-in link works once, for 60 seconds. Run `house dashboard` again.
- **"daemon not running".** The admin runs inside Household: start it first.
- **"port 8780 is taken".** Another program uses the port. Set `daemon.webPort` in `~/.config/household/household.yaml` and restart Household.
- **On a remote server**, forward the same port on both ends from your computer (`ssh -L 8780:127.0.0.1:8780 <server>`), run `house dashboard --no-open` on the server, and open the link on your computer.

### Something broke after an update

Go back to the release before, as in [Update Household](#update-household), and report the problem on [GitHub](https://github.com/underwear/household/issues).
