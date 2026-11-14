# Scouts

A scout is a specialist your bots call for one task they should not do themselves: "buy two bus tickets", "read the reviews on this unfamiliar site", "check last night's errors in production". It works in a fresh VM with only the access you gave it and nothing of the bot's, starts only when you press **Run**, and is deleted when the task is done.

## When it helps

- **The untrusted internet,** where pages can carry text written to steer an AI.
- **A key the bot should not hold:** production, payments, admin.
- **A closed network:** a database or an internal host.
- **Software you'd rather keep out of the bot's VM:** a browser, a downloader, a vendor's CLI.

## How it works

1. **A bot calls a scout** by name, with a task and what counts as success. It chooses by the scout's description, so say there when to call it: "production incidents on Heroku".
2. **You approve it.** A card in the chat shows the task, capabilities, network, keys inside the VM and the names of secrets the bot hands over. Nothing starts until you press **Run**; unanswered for 10 minutes, the run is cancelled.
3. **It works in its own thread**, where you follow it, talk to it and get its results.
4. **Its bot gets facts, not text:** status, steps, how many tools and domains it used, which secrets it asked for, handles of its files. A scout's words and files reach the bot only when you pass them, one decision each, as untrusted input. So hostile content from untrusted sites stays out of the bot's context, away from everything the bot can reach.
5. **It says it is done**: success, failed or blocked. **Close** deletes its VM; nothing carries over to the next run. There is no time limit; an idle scout reminds its bot every 30 minutes.

## Three example scouts

**General** comes with scouts: a browser, media and developer tools on the open internet, no keys. For research, downloads and sites without an API. Tricked, it has nothing of yours to give away.

**prod-ops** serves a night ops bot: the Heroku CLI with an API key through the gateway, and a PostgreSQL client with a read-only connection string inside its VM. Both list their hosts, so the scout reaches only Heroku's API and the database and cannot carry your key anywhere else.

**shopper** buys tickets on sites without an API: the browser, the open internet, and instructions like "show the basket and total before paying". It stores no card: the bot hands the details over for one run, named on the Run card, or the scout asks you in its thread.

## What you decide

**Turn scouts on.** They are off in a new workspace: **Workspace → Settings → Features**.

**Its capabilities.** A capability is one thing a scout can do: an install script (bash, run as root at the start of every run), a network rule, keys and optional skills. Keep them small, like "the Heroku CLI and its key"; a scout combines several. Access meant for one scout only goes into **A setup of its own**.

**Any host or only these hosts.** **Any host** suits a tool that needs only software. **Only these hosts** is for access: a scout with such a capability reaches only the hosts of its capabilities, even if it also has the browser. Give every capability that carries a key a host list, including where its install script downloads from. Mid-task, a scout can ask you for one more host, for that run only.

**Through the gateway or inside its VM**, for each key:

- **Through the gateway.** The scout sees a placeholder; Household puts the real value into HTTPS headers on requests to the key's hosts. Substitution happens at egress, not inside the VM, so it works only for HTTP APIs that take the key in a header. A tricked scout cannot reveal what it never held. Use it whenever the tool allows.
- **Inside its VM.** The real value, for database clients, SSH and tools that need the key itself. Household masks the exact value in what the scout posts, but a tricked scout could still disclose it. Pair it with **Only these hosts** and a read-only or limited key.

## Set it up

Scouts live under **Workspace → Scouts**, capabilities on its **Capabilities** tab, starting from ready-made ones (browser, media, developer tools, Heroku CLI, PostgreSQL client). Test a capability's install before a bot depends on it. Bots can draft a capability they need; nothing changes until you apply it.

## Secrets

You decide every secret a scout gets. Capability keys you set yourself. A secret the bot hands over is named on the Run card. A scout that needs one mid-task asks in its thread; reply `/secret <value>` within 10 minutes and confirm. Either way the value stays in that run's VM only.

## Put it to use

**A night ops bot.** A [Grafana inbox](../inboxes/#alerts) wakes your ops bot when an alert fires. It calls **prod-ops**; you press **Run** from your phone and pass the findings to the bot only if you want it to act.

## Good to know

- On the open internet a scout reaches public addresses only; a private host has to be on a capability's host list.
- A run holds its CPU and memory from the moment it waits for **Run** until its VM is gone. See [Resources](../resources/).
- `house scout run <workspace> <scout> --task "…"` starts a run from the terminal, with no Run card and no bot told. `house scout --help` and `house capability --help` list the rest.

## Related

- [Bots](../bots/): bots, sideworkers and scouts compared.
- [Network and secrets](../network/): the gateway and placeholders.
- [MCP servers](../mcp/): why the browser belongs with a scout.
