# Scouts

A scout is a helper your bot calls for one errand it shouldn't do itself: "buy me a bus ticket for Friday", "read the reviews on this unfamiliar site". It starts in a fresh VM with only what that errand needs, waits for your OK, and is deleted when it's done. Turn scouts on in workspace settings.

## Why not let the bot do it

Your bot holds a lot: your files, its memory, your connected accounts. A web page can carry text written to trick an AI. A scout goes there instead, carrying nothing of yours but what the errand needs, so a tricked scout has little to give away, and what it read reaches your bot only if you pass it on.

## How an errand goes

Say you ask your bot to buy a bus ticket.

1. **The bot calls a scout** with a browser and hands it only what the purchase needs, such as your card details and the booking site's login.
2. **You approve it.** A card in the chat shows the task, where the scout may go and which secrets it gets. Its network line comes first: 🔒 only the hosts it lists, or 🌐 the open internet, with a warning when real secrets would travel with it. Nothing starts until you press **Run**.
3. **It does the errand** in its own thread, where you can follow it and talk to it. Anything more your bot wants to tell it waits in the bot's chat for your **Pass**: once it runs, nothing reaches a scout unread (unless you made it routine, below).
4. **It reports** done, failed or blocked. Your bot learns how it went, but the scout's words and files reach the bot only when you pass them on. You get a card to **Close** it, which deletes its VM, or **Keep** it for more (a routine run closes itself, below); nothing carries over to the next run.

## Scouts to start with

- **General** (built in): a browser and everyday tools, the open internet, no keys. For reading sites you don't trust: tricked, it has nothing of yours to give away.
- **A shopper**: a browser with your card details for one run, allowed to reach only the shop.

## What you decide

**Capabilities.** A scout is built from capabilities, each one small thing it can do: a tool to install, the hosts it may reach, the keys it gets. Your bot can draft one for you, or a whole scout (below); nothing changes until you apply it. A scout whose network is limited still installs its tools: the hosts an install script downloads from are open while it runs and closed before the scout starts work.

**Any host or only these hosts.** **Any host** suits a scout that only reads the web. A scout that carries a card or a password should reach **only these hosts**, the ones its errand needs; mid-task it can ask you for one more, for that run only.

**Secrets.** Most keys stay hidden even from the scout: it holds a placeholder, and Household fills in the real value on the way out (see [Network and secrets](../network/)). Card details typed into a page need the real value inside the scout's VM; Household hides it in what the scout posts, and the VM is deleted after the run. Give a scout like that **only these hosts**.

**One more secret, mid-errand.** A scout that turns out to need another credential asks the bot that called it, never you. The bot judges whether the errand needs it: it hands over a value it has (you confirm), refuses, or asks you. Then you type the value in the scout's thread, for that run only, or ignore the request.

A run holds CPU and memory from the moment it waits for **Run**; see [Resources](../resources/).

## Routine scouts

Some errands are small and the same every time, often on a schedule: submit the meter reading on your utility's site each month. Pressing **Run** for each one adds nothing. For a scout like that you can name the bots that run it **without asking**.

**What you give up.** Those bots start it with no **Run** card, and what they tell it reaches it without your **Pass**. A routine scout does whatever these bots tell it, with its access, and a bot can be tricked by something it read. When the scout says it is done, the run closes itself: there is no **Close** or **Keep** for you. Household still posts a notice where the bot called it, so each run is in the chat.

**What stays.** Everything the scout sends back still waits for your **Pass**. A secret the bot hands it still needs your **Allow**, and one more host still needs you.

**When not to.** A scout with production access or your card. Tick a bot only when the worst a tricked bot could do with that scout is acceptable.

**What Household holds it to.**

- **Exact hosts only.** The scout reaches only hosts named in full: not the open internet, and not a wildcard such as `*.github.io`, under which anyone can put up a site.
- **One run at a time** for each bot: a second one while the first is going waits for **Run**.
- **Approval comes back.** A run the bot passes secrets to asks for **Run**. Allowing a run one more host, or taking the bot off the list, makes the rest of that run ask like any other.

## Letting a bot propose a scout

You don't have to set a scout up yourself. Describe the errand to your bot, say "submit my meter reading every month", and when no scout fits, it drafts one: what it is for, its instructions, the capabilities it needs, and a setup of its own with the least access it thinks the errand takes. Nothing exists until you apply it. Household tells you in the bot's chat that a draft is waiting, with the facts it computed itself: where the scout could go and which keys it would hold.

**What you read.** The review sets out what you decide on, in order: what the scout is for (and, in the bot's own words, why), what it runs (its instructions and its own install script, in full; the shared capabilities it ticks keep the install scripts you gave them), where it can go (with the hosts it doesn't reach today marked), and what it holds (every key, wherever it comes from). For a change to a scout you have, each part shows how it is now and what the bot proposes. Key values never come from the bot: the draft names the variables it needs, and you add the values after applying.

**Running without asking.** A bot can ask to run its scout without asking, but only you grant that, and only for a scout on exact hosts. Applying a change never keeps that trust on its own: if the scout was routine before, it asks every time again unless you tick its bots once more. A bot that rewrites a scout's hosts or instructions can't take along a trust you gave it for the old ones.

**Keys that would reach somewhere new.** A key whose value sits inside the scout's VM can reach every host the scout reaches. When a change would let such a key go somewhere it couldn't before, adds an install script that runs beside it, or brings in a capability with one, you choose whether the key stays with the scout. If you take your own setup's keys off, they stay among the workspace's secrets.

**A draft that is out of date.** If you have changed the scout since the bot drafted, applying the draft would undo that. Household tells you what changed, and applies it only when you confirm. And if anything you decided on moves while you review (a host, a key, a change of yours), it asks you to look again rather than apply what you didn't see. You can also decline a draft. Either way, the bot is told what you decided.
