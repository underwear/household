# Running Household

`house --help` has every command; the groups below have their own `--help`. Read-only: `house status`, `house ls`,
`house workspace show <workspace>`, `house bot show <workspace> <bot>`.

## What there is

- **Bots** (`house bot …`): set model, effort, mode, CPUs and memory; restart, disable/enable, attach to the
  terminal, send a message, instructions, setup / on-start scripts (`bot env`), scheduled prompts (`bot tasks`),
  memory. Shared skills of a workspace: `house skills`.
- **Channels**: more bots or chats per workspace with `house channel add|set` (`--default` picks who gets unaddressed messages; `--forward-general on` forwards what people write in a Telegram General to that bot's thread instead of ignoring it).
- **Network**: `house workspace allow|disallow`; `house workspace revoke` ends a temporary grant a bot got in the chat.
- **Secrets**: `house secret add <name> --host … --env VAR --workspaces …` (value on stdin). The bot sees a placeholder
  in `$VAR`; the gateway swaps in the value for those hosts only.
- **Shared folders** (`house volume ls|add|set|rm`): a folder of this computer at `/volumes/<name>` in the VMs of the
  bots listed (`--bots a,b`), `--access read|write`; a change restarts those bots; `rm` unmounts and keeps the files.
  Bots can ask with `volume_request`; the owner approves in the chat.
- **Scouts and capabilities** (`house scout …`, `house capability …`, `--json` on both): capabilities are install
  scripts with network (`--network any` for a tool, `--network host1,host2` for an access capability) and keys
  (`--via gateway` or `--via vm`); `capability test` installs one in a fresh VM; bots can propose drafts. Scouts are
  made of capabilities; `house scout run` starts one directly, `house scout runs` lists runs.
- **Workspace features**: `house features <workspace> scouts|preview|sideworkers=on|off`.
- **Web UI**: `house dashboard` (one-time sign-in link).

## Updating

`house update` installs the newest release (`house update <tag>` a given one) and keeps the one before; the daemon
uses it once restarted. Then `house doctor` and `house status` clean. Release notes:
https://github.com/underwear/household/releases.

`house migrate` shows what the new release will migrate. On start the daemon backs up the config and the database
(`house migrate backups`) and migrates them; bots move to the new release's images by themselves. Going back is
`house update <previous tag>` plus `house migrate restore <backup>`: an older Household refuses a newer config or
database.

## Backups

`house export [file]` puts the config (with keys), the database and the bots' homes into one `.tar.gz`;
`house import <file>` restores it with the daemon stopped (`--force` over an existing setup).
