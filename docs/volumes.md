# Shared folders

A bot lives in its own VM and sees only its own home. Share a folder of your computer and it appears at `/volumes/<name>` in the VMs of the bots you pick, read-only or read-write. What a bot writes there lands on your disk at once: share `~/Projects/site` read-write, and your coding bot edits the files your editor has open.

## First, check what is already there

- **The bot's home** keeps its own working files; it needs no shared folder for those.
- **A [connector](../connectors/)** reaches documents in your accounts, such as Google Drive.
- **A shared folder** is for files on this computer that you use too.

## How it works

- **One folder, one access, a list of bots.** [Sideworkers](../sideworkers/) see their bot's folders; [scouts](../scouts/) get none.
- **Share it** under **Workspace → Volumes**, or approve a bot's request on a card in the chat.
- **A change restarts the bots it touches,** because folders are attached when a VM starts. See [what survives a restart](../bots/#what-survives-what).
- **Stopping sharing deletes nothing.** The files stay on your computer.
- **The files are yours, not Household's.** Backups leave shared folders out, and Household cannot undo a bot's changes.
- **A missing folder is skipped,** such as one on an unplugged disk; restart the bot once it is back.

## Choose the access

Read-only unless the bot's job is to change files there, and only for the bots that need it. A bot that reads strangers' mail or web pages can be tricked, so keep your archive away from it. Whatever a bot can read, it can send to any host the workspace allows, and its model provider sees it. Read-only stops changes, not reading.

⚠️ **Read-write means the bot can change and delete what is in the folder.** Share read-write only what you would hand to someone working for you, and keep a copy of anything you cannot lose.

## What can't be shared

- Household's own data (config, bots' homes, keys), the file system root, or any folder containing them: with a standard install, your whole home folder.
- A folder inside a read-write shared folder, or a read-write folder that contains another shared folder. Share the outer folder instead.

<details>
<summary>Why are nested folders refused?</summary>

A bot that can write to the outer folder could swap the inner one for a link to anywhere on your computer, say `~/.ssh`, just as another VM attaches it. Household checks every folder at each start, but the check and the attach are two steps; keeping writable folders apart leaves nothing to swap.

</details>
