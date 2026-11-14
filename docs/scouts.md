# Scouts

A scout is a specialist your bots can call for one task: "buy two bus tickets", "read the reviews on this unfamiliar site", "check last night's errors in production". It works in a fresh VM with only the access you gave it, and is deleted when the task is done.

Scouts let your bots reach what is risky or valuable without holding it themselves: the open, untrusted internet, a production key, a closed network. A bot never sees a scout's keys, and a scout sees none of the bot's files or memory. Nothing a scout says reaches the bot unless you pass it on.

## Turn on scouts

Scouts are off in a new workspace. Open **Workspace → Settings**, switch on **Scouts** under **Features**, and **Save**. Or from the command line:

```sh
house features home scouts=on
```

The first time, the workspace gets three ready-made capabilities (a browser, media tools and developer tools) and the **General** scout made of them: a helper on the open internet with no keys of its own. Your bots can call it right away.

## How a run goes

1. **A bot calls a scout** by name, with a short task and what counts as success.
2. **You approve it.** A card shows in the chat: which bot calls which scout, the task, the capabilities, the network it will reach, any keys inside its VM, and the names of any secrets the bot hands over. Nothing starts until you press **Run**. Press **Cancel**, or leave it for 10 minutes, and it does not run.
3. **It works in its own thread.** Use **Open thread** on the card to follow it. You can talk to it there, and its results (text and files) come to you in that thread.
4. **You decide what the bot gets.** The calling bot learns only how the run is going and how it ended. When the scout wants to send the bot its findings, you get a card: **Pass text** or **Drop**. Each file asks separately: **Send to** the bot, or **Skip**. Whatever you pass is treated as untrusted.
5. **It says it is done**, with an outcome: success, failed or blocked. On that card, **Close** deletes its VM; **Keep** leaves it running for more work.

A scout has no time limit. If it sits idle for 30 minutes, the bot that called it is reminded and should stop it once it is finished or stuck.

**Workspace → Scouts** lists what is **Running** and the **Recent runs**.

## Make your own scout

Open **Workspace → Scouts → + New scout**:

- **Name** — what bots call it by, like `prod-ops`. **Title** and an emoji are for display.
- **Description** — when to call it. Bots choose a scout by this text, so say plainly what it is for.
- **Capabilities** — tick the **Shared ones it has**, and **A setup of its own** for access only this scout should get, such as a production key or an account.

Then press **Create scout**. Its page has four tabs:

- **Overview** — a summary, and what it **Runs on**. **Change…** gives it its own harness, model, CPU and memory.
- **Instructions** — how it should work.
- **Access** — its shared capabilities, its own setup, and an optional repository cloned fresh for every run.
- **Runs** — its past runs.

**Settings** on the Scouts page sets the defaults for every scout: the **Harness** they run on and the CPU and memory of **Each run**. A bot can choose another size for a run, within what the workspace has free. See [Resources](../resources/).

## Capabilities

A capability is one thing a scout can do. It has an install script (bash, run as root at the start of every run), a network rule, keys, and optional skills. Keep them small, like "a browser" or "the Heroku CLI and its key": a scout combines several.

They live on the **Capabilities** tab of the Scouts page. **+ New capability** can **Start from** a ready-made one: Browser (Playwright), Media (yt-dlp, ffmpeg), Developer tools, Heroku CLI, or PostgreSQL client. On a capability's page:

- **Install** — the script. **Test install** runs the saved script in a fresh VM and shows how it went.
- **Network** — **Any host**, for a tool that only needs software (a browser, a downloader). Or **Only these hosts**, for access to something valuable: a scout with such a capability reaches only the hosts of its capabilities, so a scout holding a production key cannot wander off to the open internet. List the hosts the install script downloads from too.
- **Keys** — **+ Add key**. You type the value; bots never see it. Choose how the scout gets it: **Through the gateway** (the scout sees a placeholder, and Household adds the real value to requests to the hosts you list) or **Inside its VM** (the real value, for database clients and some command-line tools; a tricked scout could reveal it).
- **History** — every save is a revision you can restore.

Bots can propose a capability they need. It shows under **New from bots**; **Review** it, then apply it or **Discard draft**. Nothing changes until you apply it.

## Secrets

You decide every secret a scout gets:

- Keys of capabilities are set by you in the admin. Bots never see them.
- A bot that hands a scout a secret it knows (a card number, an email for a new account) names it on the Run card. You approve it with the run.
- A scout that needs a secret mid-task asks you in its thread. Reply `/secret <value>` there within 10 minutes. Household deletes your message, asks you to confirm, and gives the value to that run only.

## After a run

A scout's thread stays as history. A bot can ask to delete it: a card with **Delete thread** and **Keep** asks you. Deleting stops the scout if it still runs and removes the thread with its messages and files for good. Channels that cannot delete threads keep the history.

## Run one yourself

You can start a scout from the command line, without a Run card:

```sh
house scout run home general --task "Find the opening hours of the town library"
```

Its thread opens in a bot's channel, and that bot hears nothing of it. `house scout --help` lists the commands to follow, message and cancel runs.
