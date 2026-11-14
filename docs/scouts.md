# Scouts

A scout is a specialist your bots call for one task they should not do themselves: "buy two bus tickets", "read the reviews on this unfamiliar site", "check last night's errors in production". It runs in a fresh VM with only the access you gave it, nothing of the bot's, starts only when you press **Run**, and is deleted when done. Turn scouts on in workspace settings.

## How it works

1. **A bot calls a scout** with a task and what counts as success, picking by the scout's description: say there when to call it.
2. **You approve it.** A card shows the task, capabilities, network, keys and names of secrets the bot hands over. Nothing starts until you press **Run**.
3. **It works in its own thread**, where you follow and talk to it.
4. **Its bot gets facts, not text:** status, steps, tools, domains and secrets used, file handles. Its words and files reach the bot only when you pass them, one decision each, as untrusted input, keeping hostile content away from all the bot can reach.
5. **It reports success, failure or blocked.** **Close** deletes its VM; nothing carries over.

## Example scouts

- **General** (built in): a browser, media and developer tools, open internet, no keys. Tricked, it has nothing of yours to give away.
- **prod-ops**: the Heroku CLI and a read-only database connection, reaching only those two hosts.
- **shopper**: buys tickets on sites without an API, with card details for one run only.

## What you decide

**Capabilities.** Each is one small thing a scout can do, like "the Heroku CLI and its key": an install script (run as root at every start), a network rule, keys, skills. Scouts combine several. Bots can draft one; nothing changes until you apply it.

**Any host or only these hosts.** **Any host** suits a tool that needs only software. **Only these hosts** is for access: a scout with one reaches only its capabilities' hosts, even if it also has the browser. Give every capability with a key a host list, including its install script's download hosts. Mid-task it can ask for one more host, for that run only. Private hosts must always be listed.

**Through the gateway or inside its VM**, for each key:

- **Through the gateway.** The scout sees a placeholder; Household adds the real value to HTTPS headers to the key's hosts, so the key must go in a header. A tricked scout cannot reveal what it never held: use it whenever you can.
- **Inside its VM.** The real value, for database clients, SSH and tools that need it. Household masks it in what the scout posts, but a tricked scout could still disclose it. Pair it with **Only these hosts** and a read-only or limited key.

Secrets the bot hands over are named on the Run card; the scout asks you in its thread for any it needs mid-task. They stay in that run's VM.

A run holds CPU and memory from the moment it waits for **Run**; see [Resources](../resources/).

## Put it to use

**A night ops bot.** A [Grafana inbox](../inboxes/#alerts) wakes your ops bot when an alert fires. It calls **prod-ops**; you press **Run** from your phone and pass on the findings only if the bot should act.
