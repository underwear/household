# Shared folders (volumes)

A bot lives in its own VM and sees only its home. To give it a folder of your computer — a projects folder, your photos, a drop zone for downloads — share it as a **volume**. It appears in the bot's VM at `/volumes/<name>`.

## How it works

- **One folder, one access, a list of bots.** A volume is a folder of this computer, **read-only** or **read-write**, mounted for the bots you pick. All of them get the same access.
- **Always at `/volumes/<name>`.** Never inside a bot's home, never over system folders, so nothing is hidden or clashes. A bot that needs it somewhere else can make a link to it.
- **The bot is told.** Its system prompt names each mounted folder and its access. Claude Code and Codex get the same text.
- **Sideworkers see their parent's folders.** Scouts get none.
- **A change restarts the bots it touches.** Mounts are fixed when a VM starts. Their homes and Docker disks stay; running processes and anything installed outside home do not.
- **Removing a volume only unmounts it.** The folder and every file in it stay on your computer.
- **The files are yours, not Household's.** What a bot writes lands on your computer at once. Backups (`house export`) do not include shared folders, and Household cannot undo a change.

⚠️ **Read-write means the bot can change and delete what is in the folder.** Share read-write only what you would hand to someone working for you, and keep a copy of anything you cannot lose.

## Sharing a folder

**In the admin:** **Workspace → Volumes → + Share folder**. Give it a name (its folder in the VM), the folder on this computer (`~/…` works), the access and the bots. A folder that does not exist yet is created. A folder that already has files shows how many before you confirm, along with a warning for folders that usually hold credentials (`~/.ssh`, `~/.config`, `~/Library`, …).

**From the command line:**

```sh
house volume add home photos --path ~/Pictures --bots sibling
house volume add home projects --path ~/Projects/shared --access write --bots sibling,helper
house volume set home photos --access write
house volume ls home
house volume rm home photos          # unmounts; the files stay
```

`add` and `set` print how many files the folder holds and ask before sharing one that is not empty (`--yes` skips the question).

**On a bot's page:** the **Volumes** tab lists every folder of the workspace, with a switch to mount or unmount each one for this bot, and **+ Share folder** for a new one.

## When a bot asks

A bot can ask for a folder itself, and for changes or removal, with its `volume_request` tool. You get a card in the chat that shows:

- the folder, how many files it holds (or that it will be created), the access and the bots;
- for a change, before and after;
- which bots restart.

Choose **Approve** or **Deny**. The card expires after 10 minutes. On approval, Household asks the bots it touches to finish their turn, restarts them with the folder mounted, and tells the bot that asked. Household refuses requests for its own folders without asking you.

## What can't be shared

- The root of the file system.
- Household's own folders and any folder that holds one: its state (the bots' homes, keys and certificates), its config, its install (`~/.household`), and microsandbox's VMs (`~/.microsandbox`). This rules out sharing your whole home folder too.
- A path with `:` or `,`, which microsandbox cannot mount.
- A folder inside a read-write volume, or a read-write folder that holds another volume. A bot could otherwise swap the inner folder for a link to anywhere on your computer before it is mounted. Share the outer folder instead.

Each time a VM starts, Household checks every folder again. One that is now a link, or leads into Household's own data, is not mounted.

## Bot homes

**Workspace → Volumes** also lists each bot's home: where it is on this computer and where the bot sees it. The list is read-only and shows what is where. Homes are Household's own and stay when a VM is recreated. A sideworker sees its parent's home as well as its own.

## In the config

Volumes live under their workspace in `household.yaml`:

```yaml
houses:
  home:
    volumes:
      photos:
        path: /Users/me/Pictures
        access: read          # or write
        bots: [sibling]
        note: family photos   # only you see it
```

A folder that is missing when a VM starts (an unplugged disk, say) is skipped, so the bot still starts. Plugging it back in restarts nothing: **Restart** on the bot's page mounts it again (so does any change to its folders). Household creates a folder only when it is first shared or moved to a new path, never for an unplugged disk.
