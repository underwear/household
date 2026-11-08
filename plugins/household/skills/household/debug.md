# When something does not work

`house doctor`, `house status` and `house logs` (`--problems`, `--pet <pet>`, `--kind daemon,agent,network`,
`-f`) are the way in. The log is `~/.local/state/household/events.jsonl`.

| Symptom | Where the answer is |
|---|---|
| Daemon down | The service's log; a config error stops it at start (`house reload` shows it). |
| Pet stuck `starting` | Its first image download; then `house pet logs <house> <pet> --source setup|docker|kernel`. |
| Pet silent in Telegram | `house pet screen` (a dialog waiting?), `house logs --pet`; is the pet in the channel (`house show`)? |
| `409 Conflict … getUpdates` | Something else polls the same bot token. |
| Pet cannot reach a host | `house logs --pet <pet> --kind network` says why (allowlist, private address, DNS). |
| Key refused | `house doctor`; a subscription token expires — a new one into `house key set <name>`. |
| Scout fails to start | `house scout status <house> <run>` keeps the setup log; `house capability test` runs the install alone. |
| Broken after an update | `house migrate backups` and roll back (operate.md → Updating). |
