# Resources

Every bot, sideworker and scout runs in its own VM, which takes some of your computer's CPU and memory. Each workspace has one budget for all of them, 8 vCPU and 8 GiB of RAM in a new workspace, so a busy afternoon of scouts and sideworkers cannot starve your bots or the machine.

## How the budget works

- **Each bot reserves its size**, whether it runs or not, so its room is always there. Only making it smaller or removing it frees that share; disabling it does not. Bots together cannot reserve more than the total.
- **Scouts and sideworkers share the rest.** Each holds its VM's full size from the moment it is requested, a scout waiting for your **Run** included, until its VM is gone. There is no limit on how many run at once, only on the total.
- **A start that doesn't fit is refused.** The bot is told what is free and can choose a smaller VM, wait, or close a helper. Nothing running is stopped or shrunk to make room.

The numbers are the most each VM may use, not what it uses right now.

## How big to make things

| What | Default | Starting point |
| --- | --- | --- |
| A bot | 2 vCPU, 1 GiB | Fine for a bot that chats, reads mail and runs small scripts. A coding bot that builds, tests or runs containers: 2–4 GiB. Under 1 GiB a harness may run out of memory. |
| A scout run | 2 vCPU, 2 GiB | Enough for a browser. A bot may pick another size for a run. |
| A sideworker | none | The bot sizes each one for its job. |

**Leave room for helpers.** Keep enough free for the scouts and sideworkers you expect at the same time. With default sizes CPU runs out first: four default bots reserve all 8 vCPU of a new workspace, and no scout or sideworker can start. Three leave 2 vCPU and 5 GiB, room for one default scout run. If your bots start sideworkers often, raise the total or make the bots smaller.

Budgets are per workspace, and the totals of several workspaces can add up to more than your computer has.

## Set it up

- **The workspace's total:** **Workspace → Resources → Change capacity…**. You cannot set more than this computer has, or less than what is held right now.
- **A bot's size:** its **Resources** tab, or when you create it. The new size applies on its next restart; until then the budget counts whichever is larger, the old size or the new one.
- **Scouts:** the default size is in **Settings** on **Workspace → Scouts**; a scout can have its own.

From the terminal, `house bot set <workspace> <bot> --cpus 4 --memory 4` sizes a bot (memory in GiB), and `house scout settings <workspace> --cpus 2 --memory 2` sets the scouts' default.

## Good to know

- If the total ends up below what is held, for example after you edit the config by hand, **Workspace → Resources** says **Over capacity**. Nothing running is stopped; new scouts and sideworkers wait until some close or you raise the total.

## Related

- [Sideworkers](../sideworkers/) and [Scouts](../scouts/): the helpers that draw from the shared part.
- [Bots](../bots/): sizing when you add a bot.
