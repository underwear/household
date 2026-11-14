# Resources

Every bot, sideworker and scout runs in its own VM, and each VM takes some of your computer's CPU and memory. Each workspace has one budget for all of them, so a busy afternoon of scouts and sideworkers cannot starve your bots or the machine. Bots keep a fixed share; scouts and sideworkers use what is left.

## How the budget works

- **The workspace has a total**, such as 8 vCPU and 8 GiB of RAM (the default for a new workspace).
- **Each bot reserves its size**, whether it is running or not, so its room is always there. Bots together cannot reserve more than the total.
- **Scouts and sideworkers share the rest.** Each holds its VM's full size while it exists, even when idle, and gives it back once its VM is gone. There is no limit on how many run at once, only on the total.
- **A start that doesn't fit is refused.** The bot is told how much is free and can choose a smaller VM, wait, or close a helper it no longer needs. Nothing running is ever stopped or shrunk to make room.

The numbers are what each VM may use at most, not what it uses right now.

## See what is in use

**Workspace → Resources** shows a bar for CPU and one for RAM: what bots reserve, what scouts and sideworkers hold, and what is free. Below, **In use** lists each bot, scout and sideworker with its size and state, updated every few seconds. The workspace's **Overview** shows **Free resources** at a glance.

## Set the workspace's total

On **Workspace → Resources**, press **Change capacity…** and set **CPU** (whole vCPUs) and **RAM** (in GiB). You cannot set more than this computer has, or less than what bots and helpers hold right now: make a bot smaller or close a helper first.

Budgets are per workspace. If you run several workspaces, their totals together can add up to more than your computer has, so choose them with that in mind.

## Size a bot

Open the bot's **Resources** tab. **Usage** shows what its VM uses now; **Allocation** sets its **CPU** and **RAM**. Saving doesn't interrupt the bot: the new size applies on its next **Restart**. Until then, the budget counts whichever is larger, the old size or the new one.

You can also set a bot's size when you create it, or from the command line:

```sh
house bot set home sibling --cpus 4 --memory 4
```

Memory there is in GiB. A bot needs at least 0.5 GiB, but under 1 GiB a harness may run out of memory.

## Size scouts and sideworkers

- **Sideworkers** have no default size: the bot that starts one chooses its CPU and memory for the job.
- **Scouts** use the default from **Settings** on **Workspace → Scouts**, or a scout's own size. A bot may choose another size for a run.

A scout waiting for your **Run** approval already holds its share, and so does a test of a capability's install script. A scout or sideworker being removed keeps its share until its VM is gone.

If the total ever ends up below what is held, for example after you edit the config by hand, the **Resources** page says **Over capacity**. Nothing running is stopped; new scouts and sideworkers wait until some close or you raise the total.

See [Sideworkers](../sideworkers/) and [Scouts](../scouts/).
