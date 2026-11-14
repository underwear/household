# Updates and troubleshooting

Keep Household current, keep it running, and find what went wrong.

## Update Household

```sh
house update            # the newest release; `house update v0.10.2` for a given one
```

The new release takes over when you restart Household. On its first start it copies your config and database aside, then converts them if needed.

**To go back**, stop Household, then:

```sh
house update <previous tag>
house migrate backups               # the copies taken before migrating, newest first
house migrate restore <backup>
```

An older release refuses a config or database a newer one has changed, so restore the copy too.

## Run it in the background

To keep Household running after you log out and after a reboot, run `house start` as a launchd service on a Mac or a systemd user service on Linux. The service must:

- **start it again whenever it exits, a clean exit too**: `KeepAlive` set to `true` for launchd, `Restart=always` for systemd. A service that restarts only on failure can leave Household down;
- **have a `PATH` that finds `python3` and `openssl`.**

Run only one Household at a time. While a service runs it, stop and restart it through the service, not with Ctrl-C or `house start`.

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

## Check that it runs and read the logs

`house status` shows whether Household and each bot run; `house doctor` lists what the machine, config, keys and Telegram bots still need.

```sh
house logs --problems                       # only what went wrong
house logs --bot <bot> -f                   # one bot, following new lines
house logs --bot <bot> --kind network       # its network requests, and why one was denied
house bot logs <workspace> <bot> --source setup
```

The admin shows them under **Logs** on a bot's page. Backups: [Back up and move](../backup/).

## Troubleshooting

### Household won't install or start

- **`house: command not found`.** Add `~/.household/bin` to your `PATH`.
- **No virtualization.** On Linux, join the group of `/dev/kvm` and log in again; on a VPS, pick one with KVM.
- **`python3` or `openssl` missing.** Install it; for a service, check that its `PATH` finds it.
- **"a daemon is already running".** Your service probably runs it: `house status`.
- **It stops right after starting.** Read its last lines or the service's log, and run `house doctor`.

### A bot doesn't start or answer

- The first start takes a minute or two; if longer, read its setup log and fix a failing setup script on its **Environment** tab.
- Check that you are an owner and the bot is in that channel; see [Channels](../channels/).
- Look at **Console**: the harness may be waiting for an answer on screen.
- Use each Telegram bot token in one place only; `house doctor` flags Telegram settings that are off.

### The model stops answering

A Claude sign-in ends about once a month and after a restore: sign in again in **Settings → Keys**. A used-up allowance stops answers until it resets. See [Keys](../keys/).

### A bot can't reach a site

`house logs --bot <bot> --kind network` says why a request was denied. See [Network and secrets](../network/).

### The admin does not open

- **"That link expired or was used".** Run `house dashboard` again.
- **"port 8780 is taken".** Set `daemon.webPort` in `~/.config/household/household.yaml` and restart.
- **On a remote server**, forward the port from your computer (`ssh -L 8780:127.0.0.1:8780 <server>`), run `house dashboard --no-open` on the server, and open the link on your computer.

### Something broke after an update

Go back to the release before, as in [Update Household](#update-household), and report the problem on [GitHub](https://github.com/underwear/household/issues).
