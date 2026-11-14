# Shared folders

A bot lives in its own VM and sees only its own home. Share a folder of your computer and it appears at `/volumes/<name>` in the VMs of the bots you pick, read-only or read-write. What a bot writes there lands on your disk at once: share `~/Projects/site` read-write as `site`, and your coding bot edits the same files your editor has open.

## When it helps

- **A drop zone.** A folder where you drop scans, exports and downloads for a bot, and it leaves its results.
- **A reference library.** Your notes, manuals or photo archive, read-only: a bot searches and quotes them but cannot change them.
- **A shared project.** A repository you and a bot work on together.
- **A hand-off between bots.** One bot writes reports into a folder, another reads them.

## First, check what is already there

- **The bot's home** keeps its own working files across restarts and new VMs; it needs no shared folder for those.
- **A [connector](../connectors/)** reaches documents in your accounts, such as Google Drive, without any folder on your disk.
- **A shared folder** is for files on this computer that you use too.

## How it works

- **One folder, one access, a list of bots.** Every bot you pick gets the same access.
- **Always at `/volumes/<name>`,** never inside a bot's home or over system folders, so nothing is hidden or clashes. Each bot is told which folders it has and whether it may write.
- **Sideworkers see their bot's folders. Scouts get none,** so a scout's work on untrusted sites never touches your files.
- **A change restarts the bots it touches,** and their sideworkers, because folders are attached when a VM starts. Each bot gets a few minutes to finish its turn. Homes stay; running programs and anything installed outside the home do not, and the bot's Setup script brings software back.
- **Stopping sharing deletes nothing.** The folder and its files stay on your computer.
- **The files are yours, not Household's.** Backups (`house export`) leave shared folders out, and Household cannot undo a bot's changes.
- **Checked at every start.** A folder that has since become a link, or leads into Household's own data, is not attached.

## What you decide

- **Read-only or read-write.** Read-only unless the bot's job is to make or change files there.
- **Which bots.** Only those whose job needs the folder. A bot that reads strangers' mail or web pages can be tricked, so keep your archive away from it, read-write above all.
- **What is in it.** Whatever a bot can read, it can send to any host the workspace allows, and it goes to the model provider as the bot reads it. Read-only stops changes, not reading.

⚠️ **Read-write means the bot can change and delete what is in the folder.** Share read-write only what you would hand to someone working for you, and keep a copy of anything you cannot lose.

## Share a folder

**Workspace → Volumes → + Share folder**, or a bot's **Volumes** tab. The name becomes `/volumes/<name>`; a folder that does not exist yet is created. Before you confirm, Household shows how many files the folder holds and which bots will restart, and warns about folders that often hold credentials, like `~/.ssh`, `~/.aws`, `~/.config` or `~/Library`.

A bot can also ask for a folder, a change or giving one up. You approve or deny it on a card in the chat; it expires after 10 minutes.

## What can't be shared

- The root of the file system.
- Household's own data (its config, its install, the bots' homes and keys) and the VM runtime's, or any folder that contains them, so no bot can reach keys or another bot's home. With a standard install, this rules out your whole home folder.
- A path with `:` or `,`, which the VM runtime cannot attach.
- A folder inside a read-write shared folder, or a read-write folder that contains another shared folder, in any workspace. Share the outer folder instead.

<details>
<summary>Why are nested folders refused?</summary>

A bot that can write to the outer folder could swap the inner one for a link to anywhere on your computer, say `~/.ssh`, just as another VM attaches it. Household checks every folder at each start, but the check and the attach are two steps; keeping writable folders apart leaves nothing to swap.

</details>

## Good to know

- **Unplugged disks.** A folder missing when a VM starts is skipped, and the bot starts without it; after plugging the disk back in, restart the bot. Household creates a folder only when you first share or move it, never for an unplugged disk.
- **Bot homes** are listed under **Workspace → Volumes** too, for information: where each is on your computer.

## Put it to use

A paperwork bot: share `~/Scans` read-write as `scans`, and give the bot a [scheduled task](../schedules/) at 9:00: "Rename new scans by date and sender, file them under `/volumes/scans/sorted`, and tell me which bills are due."

## From the terminal

```sh
house volume add home photos --path ~/Pictures --bots sibling
house volume add home projects --path ~/Projects/shared --access write --bots sibling,helper
house volume set home photos --access write
house volume ls home
house volume rm home photos          # stops sharing; the files stay
```

`add` and `set` ask before sharing a folder that is not empty (`--yes` skips the question).

## Related

- [Sideworkers](../sideworkers/): helpers that share their bot's folders
- [Previews](../previews/): show what a bot built in a shared project
- [Back up and move](../backup/): what a backup holds, and what it leaves out
