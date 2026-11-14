# Back up and move

One command saves your whole Household (every workspace and every bot) into a single file. Another puts it back, on this computer or a new one. Use it for regular backups and to move Household to another machine.

Backups are made from the command line. There is no backup of a single workspace or bot yet, and no backup button in the admin (**Backup** in its menu is marked *soon*).

## Make a backup

```sh
house export                          # household-YYYYMMDD-HHMM.tar.gz in the current folder
house export ~/backups/house.tar.gz   # or where you say
```

Household can keep running. Each bot pauses for a moment while its files are copied, and messages to it wait. Close all sideworkers first: the export refuses to run while any are open. It never writes over an existing file.

A backup holds:

- your settings: workspaces, bots, channels, owners, network rules, inboxes, keys, secrets and bot tokens;
- chat history, the bots' memory, scheduled tasks and inbox events;
- every bot's home folder: its projects, sessions, skills, instructions, and anything it installed there;
- the workspace's shared skills, ChatGPT sign-ins, and the certificate the bots trust.

It does not hold:

- logs;
- what a bot installed outside its home. Its **Setup** script brings that back on the first start;
- [shared folders](../volumes/). Those are your own files: back them up the way you back up the rest of your computer.

⚠️ **A backup contains your keys and tokens in plain form.** Household saves it readable only by you, but anyone who gets the file gets your keys. Keep it like a password file.

## Restore

Stop Household first: `Ctrl-C` in its terminal, or through your service if you run it as one (see [Start](../start/)). Then:

```sh
house import household-20261109-0300.tar.gz
house doctor
house start
```

On a machine that already has a Household, import refuses to overwrite anything. Add `--force` to replace it: your current settings, database and certificate are moved aside as `*.bak-…` files, and the bots' home folders are replaced. If a bot's VM is still running, import says which one and how to stop it.

A backup from an older Household restores with a warning. One from a newer Household is refused: run `house update` first.

## Move to another machine

1. Run `house export` on the old machine.
2. [Install Household](../start/) on the new one. Skip `house onboard`: your settings come from the backup.
3. Copy the archive over, then run `house import <file>` and `house start`.

Stop Household on the old machine before you start it on the new one. Otherwise both would answer the same bots.

## Just the settings

All your settings are in one plain file, `~/.config/household/household.yaml`. You can keep a copy of it, edit it by hand, and run `house reload` to apply your changes. It does not hold chat history, memory or the bots' files: for those, use `house export`.

## Updates

When a new version has to convert your settings or database, Household copies both aside first, as it starts. To go back to one of those copies:

```sh
house migrate backups                # the copies, newest first
house migrate restore <name>         # put one back (Household stopped)
```
