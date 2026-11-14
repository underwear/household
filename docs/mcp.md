# MCP servers

MCP servers give a bot new tools: an issue tracker, a wiki, a database. Each bot runs a real coding-agent harness (Claude Code, Codex…) in its own VM, so you ask the bot to add a server to itself, as on your own machine.

## First, check what is already there

Some services don't need an MCP server at all:

- **Connectors.** Email, Google (Gmail, Drive, Calendar), Microsoft To Do and Slack can be connected once for the workspace and given to the bots you choose. See [Connectors](../connectors/).
- **Your Claude or ChatGPT account's connectors.** A bot that runs on a Claude or ChatGPT sign-in can use the connectors or apps already set up in that account (Drive, Jira, GitHub…). Turn on **Claude.ai connectors** or **ChatGPT apps** on the bot's **Harness** tab. See [Provider keys](../keys/).

## Ask your bot

For anything else, ask the bot:

> Add the Linear MCP server for yourself: https://mcp.linear.app/mcp

> Install the Playwright MCP server and use it for the tickets site.

<details>
<summary>⚠️ We believe giving your bot a browser is a bad idea. Why?</summary>

It works. We still wouldn't. The internet is not a friendly place, and a browser takes your bot right into it.

- **Pages talk back.** Any page can carry text written for an AI rather than for you: "ignore your instructions and…". This is prompt injection, and no model is fully immune to it.
- **Your bot has a lot to lose.** Your projects, its memory, the hosts your workspace allows, the keys it can use. A page that talks it into something talks it into it with all of that at hand.
- **A browser is a huge program.** Millions of lines of code that read whatever a page sends. Browser makers ship security fixes all the time, which is good news, and also a hint at how often holes are found.

A scout is made for exactly this: a fresh VM with nothing of yours in it, only the access you give it, deleted after the task, and its findings reach your bot only if you pass them. So when your bot needs a website, let it [call a scout](../scouts/).

</details>

The bot tells you when it needs something:

- **A host.** It asks to reach the server's domain; you answer on the card. See [Network](../network/).
- **A key.** It asks for a secret and only ever sees a placeholder. See [Secrets](../network/#secrets).

A new server shows up in the bot's next session, or after a restart.

## Good to know

- **Each bot for itself.** Servers aren't shared between bots.
- **It stays** across restarts and new VMs; software it needs goes into the bot's **Setup** script. See [What survives what](../bots/#what-survives-what).
- **No more access than the bot** has.
- **Tokens in headers.** A placeholder can't serve a server that needs the raw value, for example to sign requests.
- **Browser sign-ins** may fail from a VM; use a token.
