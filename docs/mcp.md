# MCP servers

MCP servers give an assistant new tools: your issue tracker, a wiki, a design tool, a database. Household has no page for adding MCP servers to a whole workspace. You don't need one: every bot runs a real Claude Code or Codex in its own VM, so you can ask the bot to add a server to itself, the same way you would set it up on your own machine.

## First, check what is already there

Some services don't need an MCP server at all:

- **Connectors.** Email, Google (Gmail, Drive, Calendar), Microsoft To Do and Slack can be connected once for the workspace and given to the bots you choose. See [Connectors](../connectors/).
- **Your Claude or ChatGPT account's connectors.** A bot that runs on a Claude or ChatGPT sign-in can use the connectors or apps already set up in that account (Drive, Jira, GitHub…). Turn on **Claude.ai connectors** or **ChatGPT apps** on the bot's **Harness** tab. See [Keys](../keys/).

## Ask your bot

For anything else, write to the bot as you would to a colleague:

> Add the Linear MCP server for yourself: https://mcp.linear.app/mcp

> Connect the Atlassian MCP server, so you can read our Jira and Confluence.

The bot adds the server the way its harness does and tells you when it needs something from you. Usually that is one of two things:

- **A host.** A bot's VM reaches only the hosts the workspace allows. For a remote server, the bot asks for the server's domain, and you answer on the card in the chat: **Allow 15 min**, **Allow forever** or **Deny**. You can also add the host yourself on **Workspace → Network**. See [Network](../network/).
- **A key.** For a server that needs a token, the bot asks you for a secret on a card in the chat. Answer its request with `/secret <value>`, or add the secret yourself on **Workspace → Secrets**. The bot only ever sees a placeholder; Household puts the real token into requests to that server's host on their way out.

A new server usually shows up in the bot's next session. If the bot does not see it, press **Restart** on the bot's page.

## It stays

A bot's MCP settings live in its home folder, which survives restarts and new VMs. If a server needs software in the VM (Node, Python, a browser), the bot adds it to its **Setup** script on the **Environment** tab, so a new VM gets it back.

## Good to know

- **Each bot for itself.** A server one bot added is not shared with the others. Ask each bot that needs it.
- **No more access than the bot.** A server runs inside the bot's VM or is reached through the workspace's network rules, so it can do only what the bot can.
- **Tokens in headers.** A secret works when the server takes its token in an HTTP header, as most do. A server that needs the raw value itself, to sign requests for example, cannot use the placeholder.
- **Browser sign-ins.** Servers that sign you in through a browser may not manage it from a VM. When there is a choice, give the bot a token instead.

## Think twice about a browser

You can ask a bot to install a browser server such as Playwright, and it works. We still wouldn't.

- **Pages talk back.** Any page can carry text written for an AI rather than for you: "ignore your instructions and…". This is called prompt injection, and no model is fully immune to it.
- **Your bot has a lot to lose.** Your projects, its memory, the hosts your workspace allows, the keys it can use. A page that talks it into something does so with all of that at hand.
- **A browser is a huge program** that reads whatever a page sends. Browser makers ship security fixes all the time, a hint at how often holes are found.

A scout is made for this: a fresh VM with nothing of yours in it, only the access you give it, deleted after the task, and its findings reach your bot only if you pass them on. When your bot needs a website, let it [call a scout](../scouts/).
