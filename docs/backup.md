# Back up and move

One command saves your whole Household (every workspace and every bot) into a single file. Another puts it back, on this computer or a new one. Use it for regular backups, before a risky change, and to move Household to another machine.

Backups are made from the terminal. There is no backup of a single workspace or bot yet, and no backup button in the admin.

## What a backup holds

- your settings: workspaces, bots, channels, owners, network rules, inboxes, keys, secrets and bot tokens;
- chat history, the bots' memory, scheduled tasks, inbox events and connected accounts;
- every bot's home folder: its projects, sessions, skills, instructions, and anything it installed there;
- the workspace's shared skills, ChatGPT sign-ins, and the certificate the bots trust.

It does not hold:

- **Claude sign-ins.** They renew every few hours and each renewal ends the one before, so a copy would be dead within hours. After a restore, use **Sign in again** on the **Keys** page.
- **What a bot installed outside its home.** Its **Setup** script brings that back on the first start.
- **[Shared folders](../volumes/).** Those are your own files: back them up the way you back up the rest of your computer.
- **Logs.**

⚠️ **A backup contains your keys and tokens in plain form.** Household saves it readable only by you, but anyone who gets the file gets your keys. Keep it like a password file.

## Make a backup

```sh
house export                          # household-YYYYMMDD-HHMM.tar.gz in the current folder
house export ~/backups/house.tar.gz   # or where you say
```

Household can keep running: each bot pauses for a moment while its files are copied, and messages to it wait. Close all [sideworkers](../sideworkers/) first: they share their bots' files, so the export refuses to run while any are open. It never writes over an existing file.

## Restore

Stop Household first (see [Updates and troubleshooting](../operating/)), then:

```sh
house import household-20261109-0300.tar.gz
house doctor
house start
```

On a machine that already has a Household, import refuses to overwrite anything. `--force` replaces it: your current settings, database and certificate are moved aside as `*.bak-…` files, and the bots' home folders are replaced.

A backup from an older Household restores with a warning. One from a newer Household is refused: run `house update` first.

## Move to another machine

1. Run `house export` on the old machine.
2. [Install Household](../start/) on the new one. Skip `house onboard`: your settings come from the backup.
3. Copy the archive over, then run `house import <file>` and `house start`.
4. Sign in to Claude again if your keys use a Claude sign-in.

Stop Household on the old machine before you start it on the new one. Otherwise both would answer the same bots.

## Good to know

- **Settings only:** all of them are in one plain file, `~/.config/household/household.yaml`. Keep a copy, or edit it and run `house reload`. It holds no chat history, memory or bot files.
- **Before an update** converts your settings or database, Household copies both aside. `house migrate backups` lists the copies; `house migrate restore <name>` puts one back while Household is stopped.

## Related

- [Updates and troubleshooting](../operating/): stopping, starting and updating Household.
- [Quick start](../start/): installing on a new machine.
