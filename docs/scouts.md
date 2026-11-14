# Scouts

A scout is a helper your bot calls for one errand it shouldn't do itself: "buy me a bus ticket for Friday", "read the reviews on this unfamiliar site". It starts in a fresh VM with only what that errand needs, waits for your OK, and is deleted when it's done. Turn scouts on in workspace settings.

## Why not let the bot do it

Your bot holds a lot: your files, its memory, your connected accounts. A web page can carry text written to trick an AI. A scout goes there instead, carrying nothing of yours but what the errand needs, so a tricked scout has little to give away, and what it read reaches your bot only if you pass it on.

## How an errand goes

Say you ask your bot to buy a bus ticket.

1. **The bot calls a scout** with a browser and hands it only what the purchase needs, such as your card details and the booking site's login.
2. **You approve it.** A card in the chat shows the task, where the scout may go and which secrets it gets. Nothing starts until you press **Run**.
3. **It does the errand** in its own thread, where you can follow it and answer if it asks for something more.
4. **It reports** done, failed or blocked. Your bot learns how it went, but the scout's words and files reach the bot only when you pass them on. **Close** deletes its VM; nothing carries over.

## Scouts to start with

- **General** (built in): a browser and everyday tools, the open internet, no keys. For reading sites you don't trust: tricked, it has nothing of yours to give away.
- **A shopper**: a browser with your card details for one run, allowed to reach only the shop.

## What you decide

**Capabilities.** A scout is built from capabilities, each one small thing it can do: a tool to install, the hosts it may reach, the keys it gets. Your bot can draft one for you; nothing changes until you apply it.

**Any host or only these hosts.** **Any host** suits a scout that only reads the web. A scout that carries a card or a password should reach **only these hosts**, the ones its errand needs; mid-task it can ask you for one more, for that run only.

**Secrets.** Most keys stay hidden even from the scout: it holds a placeholder, and Household fills in the real value on the way out (see [Network and secrets](../network/)). Card details typed into a page need the real value inside the scout's VM; Household hides it in what the scout posts, and the VM is deleted after the run. Give a scout like that **only these hosts**.

A run holds CPU and memory from the moment it waits for **Run**; see [Resources](../resources/).
