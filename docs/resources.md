# Resources

Every bot, sideworker and scout runs in its own VM, which takes some of your computer's CPU and memory. Each workspace has one budget for all of them, so a busy afternoon of helpers cannot starve your bots or the machine.

## How the budget works

- **Each bot reserves its size**, running or not. Only making it smaller or removing it frees that share; disabling it does not.
- **Scouts and sideworkers share the rest.** Each holds its VM's full size from the moment it is requested until its VM is gone.
- **A start that doesn't fit is refused.** The bot is told what is free and can pick a smaller VM, wait, or close a helper. Nothing running is stopped to make room.

## How big to make things

| What | Default | Starting point |
| --- | --- | --- |
| A bot | 2 vCPU, 1 GiB | Enough to chat, read mail and run small scripts. A coding bot: 2–4 GiB. |
| A scout run | 2 vCPU, 2 GiB | Enough for a browser. |
| A sideworker | none | The bot sizes each one for its job. |

Leave room for the helpers you expect at once: four default bots fill a new workspace's 8 vCPU, and then no scout or sideworker can start.

Change the workspace's total on **Workspace → Resources**, and a bot's size on its **Resources** tab; a new bot size applies on its next restart.
