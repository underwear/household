# When something does not work

`house doctor`, `house status` and `house logs` (`--problems`, `--bot <bot>`, `--kind daemon,harness,network`,
`-f`) are the way in. The log is `~/.local/state/household/events.jsonl`.

| Symptom | Where the answer is |
|---|---|
| Daemon down | The service's log; a config error stops it at start (`house reload` shows it). |
| Bot stuck `starting` | Its first image download; then `house bot logs <workspace> <bot> --source setup|docker|kernel`. |
| Bot silent in Telegram | `house bot screen` (a dialog waiting?), `house logs --bot`; is the bot in the channel (`house workspace show`)? |
| `409 Conflict … getUpdates` | Something else polls the same bot token. |
| Bot cannot reach a host | `house logs --bot <bot> --kind network` says why (allowlist, private address, DNS). |
| Key refused | `house doctor`; a pasted token expires — a new one into `house key set <name>`; a sign-in ended — `house key claude <name> --link`, then `--code` (ChatGPT: `house key codex <name>`). |
| No claude.ai connectors in a bot | Its key must be a sign-in (`house ls`: kind `sign-in`), and the bot's setting `claudeAiConnectors=true`. |
| Scout fails to start | `house scout status <workspace> <run>` keeps the setup log; `house capability test` runs the install alone. |
| Broken after an update | `house migrate backups` and roll back (operate.md → Updating). |
