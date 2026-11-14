# Shared folders

A bot lives in its own VM and sees only its own home. To give it a folder of your computer, such as a projects folder, your photos, or a drop zone for downloads, share it as a volume. The bot sees it at `/volumes/<name>`, and what it writes there lands on your computer at once.

## How sharing works

- **One folder, one access, a list of bots.** Each shared folder is **Read-only** or **Read-write**, and every bot you pick gets the same access.
- **Always at `/volumes/<name>`.** Never inside a bot's home or over system folders, so nothing is hidden or clashes.
- **The bot knows.** Each bot is told which folders it has and whether it may write to them.
- **Sideworkers see their bot's folders.** Scouts get none.
- **A change restarts the bots it touches.** Folders are attached when a VM starts. The bots' homes stay; running programs and anything installed outside the home do not. The bot's Setup script brings software back.
- **Stopping sharing never deletes anything.** The folder and every file in it stay on your computer.
- **The files are yours, not Household's.** Backups (`house export`) do not include shared folders, and Household cannot undo a bot's changes.

⚠️ **Read-write means the bot can change and delete what is in the folder.** Share read-write only what you would hand to someone working for you, and keep a copy of anything you cannot lose.

## Share a folder

**In the admin:** open **Workspace → Volumes → + Share folder** and fill in:

- **Name** — the folder's name in the VM: `projects` becomes `/volumes/projects`.
- **Folder on this computer** — a full path or `~/…`. A folder that does not exist yet is created.
- **Access** — **Read-only** or **Read-write**.
- **Bots** — who gets it.
- **Note** — for you only.

Press **Next**. Household shows how many files the folder holds and which bots will restart, and warns you about folders that often hold credentials, like `~/.ssh`, `~/.config` or `~/Library`. Confirm with **Share it**.

**On a bot's page:** the **Volumes** tab lists every shared folder of the workspace with a switch to mount or unmount it for this bot, and **+ Share folder** for a new one.

**From the command line:**

```sh
house volume add home photos --path ~/Pictures --bots sibling
house volume add home projects --path ~/Projects/shared --access write --bots sibling,helper
house volume set home photos --access write
house volume ls home
house volume rm home photos          # stops sharing; the files stay
```

`add` and `set` tell you how many files the folder holds and ask before sharing one that is not empty (`--yes` skips the question).

To change a folder, use **Edit** next to it in **Workspace → Volumes**. To stop sharing, use **Remove**, then **Stop sharing**, or `house volume rm`.

## When a bot asks for a folder

A bot can ask you for a folder itself, or for a change to one it has. A card in the chat shows:

- the folder, how many files it holds (or that it will be created), the access and the bots;
- for a change, what it is now and what it would be;
- which bots will restart.

Choose **Approve** (or **Stop sharing**, when the bot asks to give a folder up) or **Deny**. The card expires after 10 minutes. When you approve, the bots involved finish what they are doing, restart with the folder attached, and the bot that asked is told.

## What can't be shared

- The root of the file system.
- Household's own data (its config, its install, the bots' homes and keys) and the VM runtime's data, or any folder that contains them. With a standard install, this rules out your whole home folder.
- A path with `:` or `,` in it.
- A folder inside a read-write shared folder, or a read-write folder that contains another shared folder. Share the outer folder instead.

Each time a VM starts, Household checks every folder again. One that has since become a link, or leads into Household's own data, is not attached.

## Unplugged disks

If a folder is missing when a VM starts, such as one on an unplugged disk, it is skipped and the bot still starts. **Workspace → Volumes** marks it as **Folder missing**. Plugging the disk back in does not restart anything: press **Restart** on the bot's page to attach it again. Household creates a folder only when you first share it or move it to a new path, never for an unplugged disk.

## Bot homes

**Workspace → Volumes** also lists each bot's home: where it is on your computer and where the bot sees it. This list is for information only. Homes belong to Household and survive restarts and new VMs.
