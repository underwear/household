# Back up and move

One command saves your whole Household (every workspace and every bot) into a single file. Another puts it back, on this computer or a new one.

## What a backup holds

Your settings, keys, secrets and bot tokens; chat history, memory, scheduled tasks and connected accounts; every bot's home folder; the shared skills, ChatGPT sign-ins and the certificate the bots trust.

It does not hold:

- **Claude sign-ins.** Each renewal ends the one before, so a copy would be dead within hours. After a restore, use **Sign in again** on the **Keys** page.
- **What a bot installed outside its home.** Its setup script brings that back.
- **[Shared folders](../volumes/).** Back up your own files the way you back up the rest of your computer.
- **Logs.**

⚠️ **A backup contains your keys and tokens in plain form.** Anyone who gets the file gets your keys. Keep it like a password file.

## Make a backup

```sh
house export                          # household-YYYYMMDD-HHMM.tar.gz in the current folder
house export ~/backups/house.tar.gz   # or where you say
```

Household can keep running; each bot pauses for a moment while its files are copied. Close all [sideworkers](../sideworkers/) first: they share their bots' files, so the export refuses to run while any are open.

## Restore or move

1. To move, [install Household](../start/) on the new machine but skip setup: your settings come from the backup.
2. Stop Household, then run `house import <file>`, `house doctor` and `house start`.
3. Sign in to Claude again if your keys use a Claude sign-in.

Import refuses to overwrite an existing Household. `--force` replaces it: your current settings, database and certificate are moved aside as `*.bak-…` files, and the bots' home folders are replaced. A backup from a newer Household is refused: run `house update` first.

⚠️ When you move, stop Household on the old machine before you start it on the new one. Otherwise both would answer the same bots.
