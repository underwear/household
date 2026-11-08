# Running Household

`house --help` has every command; the groups below have their own `--help`. Read-only: `house status`, `house ls`,
`house show <house>`, `house pet show <house> <pet>`.

## What there is

- **Pets** (`house pet …`): set model, effort, mode, CPUs and memory; restart, disable/enable, attach to the
  terminal, send a message, instructions, setup / on-start scripts (`pet env`), scheduled prompts (`pet tasks`),
  memory. Shared skills of a house: `house skills`.
- **Channels**: more pets or chats per house with `house channel add|set` (`--default` picks who gets General).
- **Network**: `house allow|disallow`; `house revoke` ends a temporary grant a pet got in the chat.
- **Secrets**: `house secret add <name> --host … --env VAR --houses …` (value on stdin). The pet sees a placeholder
  in `$VAR`; the gateway swaps in the value for those hosts only.
- **Scouts and capabilities** (`house scout …`, `house capability …`, `--json` on both): capabilities are install
  scripts with network (`--network any` for a tool, `--network host1,host2` for an access capability) and keys
  (`--via gateway` or `--via vm`); `capability test` installs one in a fresh VM; pets can propose drafts. Scouts are
  made of capabilities; `house scout run` starts one directly, `house scout runs` lists runs.
- **House features**: `house features <house> scouts|preview|sideworkers=on|off`.
- **Web UI**: `house dashboard` (one-time sign-in link).

## Updating

`house update` installs the newest release (`house update <tag>` a given one) and keeps the one before; the daemon
uses it once restarted. Then `house doctor` and `house status` clean. Release notes:
https://github.com/underwear/household/releases.

`house migrate` shows what the new release will migrate. On start the daemon backs up the config and the database
(`house migrate backups`) and migrates them; pets move to the new release's images by themselves. Going back is
`house update <previous tag>` plus `house migrate restore <backup>`: an older Household refuses a newer config or
database.

## Backups

`house export [file]` puts the config (with keys), the database and the pets' homes into one `.tar.gz`;
`house import <file>` restores it with the daemon stopped (`--force` over an existing setup).
