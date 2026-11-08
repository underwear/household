# When something does not work

Start wide, then narrow:

```sh
house doctor                       # dependencies, config, keys, bots, the daemon
house status                       # is the daemon up, which pets are not running
house logs --problems -n 50        # warnings and errors of the daemon, agents and network
house logs --pet assistant -f      # one pet's agent and network, live (--kind daemon,agent,network)
```

| Symptom | Look at |
|---|---|
| `daemon: down` | Is it running: the service (`launchctl print gui/$(id -u)/dev.household`, `systemctl --user status household`) or its log. A config error stops it at start: `house reload` shows it. |
| A pet stays `starting` | The first image build takes minutes. Then `house pet logs work assistant --source setup` (its setup script), `--source docker`, `--source kernel`. |
| A pet does not answer in Telegram | `house pet screen work assistant` (Claude pets: is it waiting on a dialog?), `house logs --pet assistant`. Is the pet in the channel (`house show work`)? Did the message go to its thread, or name it first in General ("Assistant, …")? |
| `409 Conflict … getUpdates` in the log | Another program polls the same bot token (a second Household, an old script). Only one may. |
| A pet cannot reach a host | `house logs --pet assistant --kind network`: the reason is there (not on the allowlist, a private address, DNS). `house allow …`, or the owner approves the pet's request in the chat. |
| A key is refused | `house doctor` checks each key. A subscription token expires: the user runs `claude setup-token` again, then `house key set claude` with the new value on stdin. |
| A scout fails to start | `house scout status work <run>` keeps a failed setup's log after its VM is gone; `house capability test work <capability>` runs the install alone. |
| Something broke after an update | `house migrate backups`, then roll back as in operate.md → Updates. |

Pet agents' own state lives in the pet's VM; `house pet attach` (Claude pets) shows its terminal. The Household
log is `~/.local/state/household/events.jsonl` (`house logs` reads it, with rotation).
