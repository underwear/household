# Back up and move Household

One command saves everything — every workspace, every bot — into one file; another puts it back, on this machine or a new one. There is no export of a single workspace or bot yet, and no backup button in the admin (**Backup** in its menu is still *soon*).

## Back up

```sh
# Saves household-YYYYMMDD-HHMM.tar.gz in the current folder, or where you say:
house export
house export ~/backups/house.tar.gz
```

The daemon can keep running: each bot pauses for a moment while its files are copied, and messages to it wait. Close all sideworkers first.

The archive holds:

- the config, `household.yaml`: workspaces, bots, channels, owners, network rules, inboxes, keys, secrets and bot tokens;
- the database: chat history, memory, scheduled tasks, inbox events;
- every bot's home folder: its projects, sessions, skills, instructions and anything it installed there;
- the workspace's shared skills, ChatGPT subscription logins, and the certificate bots trust.

Not included: logs, and what a bot installed outside its home — its Setup script brings that back on the first start.

⚠️ **The archive contains your keys and tokens in plain form.** It is saved readable only by you (mode 600); keep it like a password file.

## Restore

Stop the daemon (`Ctrl-C` in its terminal), then:

```sh
house import household-20261109-0300.tar.gz
house doctor
house start
```

On a machine that already has a Household, import refuses to overwrite anything. `--force` replaces it: the current config, database and certificate are moved aside as `*.bak-…` files, and the bots' home folders are replaced.

A backup from an older Household restores with a warning. One from a newer Household is refused: `house update` first.

## Move to another machine

1. `house export` on the old machine.
2. [Install Household](../start/) on the new one; skip `house onboard`.
3. Copy the archive over, then `house import <file>` and `house start`.

Stop the daemon on the old machine before starting the new one: both would answer the same bots.

## Just the config

`household.yaml` is a plain file in `~/.config/household/`. You can keep a copy, edit it by hand and run `house reload` to apply it. It alone does not carry chat history, memory or the bots' files: for those, use `house export`.

When a new version has to migrate the config or the database, Household copies both aside first, as it starts. `house migrate backups` lists those copies; `house migrate restore <name>` puts one back.


Config migration 4 moves the old top-level `secrets` into `houses.<name>.secrets`. Shared secrets become independent copies in each existing recipient workspace; restricted secrets stay only in their named workspaces. New workspaces inherit none. If a destination is missing or already has the same secret name, migration stops without overwriting it.

Manage these credentials in the workspace’s **Secrets** menu. CLI commands now include the workspace, for example `house secret add work github --host api.github.com --env GITHUB_TOKEN` (the value is read from stdin). Before editing an old configuration, restart Household to run migrations with a backup, or stop it and run `house migrate apply`.
