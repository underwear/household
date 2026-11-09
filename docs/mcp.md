# Adding MCP servers

Household does not connect MCP servers for a whole workspace yet. But every bot runs a real Claude Code or Codex in its own VM, so you can simply ask it: it will add any MCP server to its own harness, from the inside. 🤖

## Ask your bot

Write to it as you would to a colleague:

> Add the Linear MCP server for yourself: https://mcp.linear.app/mcp

> Connect the Atlassian Rovo MCP server, so you can read our Jira and Confluence.

> Install the Playwright MCP server and use it for the tickets site.

<details>
<summary>⚠️ We believe giving your bot a browser is a bad idea. Why?</summary>

It works. We still wouldn't. The internet is not a friendly place, and a browser takes your bot right into it.

- **Pages talk back.** Any page can carry text written for an AI rather than for you: "ignore your instructions and…". This is prompt injection, and no model is fully immune to it.
- **Your bot has a lot to lose.** Your projects, its memory, the hosts your workspace allows, the keys it can use. A page that talks it into something talks it into it with all of that at hand.
- **A browser is a huge program.** Millions of lines of code that read whatever a page sends. Browser makers ship security fixes all the time, which is good news, and also a hint at how often holes are found.

A scout is made for exactly this: a fresh VM with nothing of yours in it, only the access you give it, deleted after the task, and its findings reach your bot only if you pass them. So when your bot needs a website, let it [call a scout](../scouts/).

</details>

The bot adds the server the way its harness does (`claude mcp add …` in Claude Code, `codex mcp add …` in Codex) and tells you if it needs something from you. Usually that is one of two things:

- **A host.** A bot's VM reaches only what the workspace allows. For a remote server it asks for the server's domain, and you answer in the chat: for 15 minutes, for good, or no. You can also add the host yourself on the workspace's **Network** page.
- **A key.** For a server that needs a token, the bot asks you for a Workspace secret. You paste the value; the bot only ever sees a placeholder, and Household puts the real token into requests to that server's host on their way out.

## It stays

A bot's MCP settings live in its home folder, which survives restarts and new VMs. If a server needs a system package (Node, Python, a browser), the bot adds it to its environment setup, so a new VM gets it back.

A new server usually shows up in the bot's next session. If the bot does not see it, press **Restart** on its page.

## Good to know

- **Each bot for itself.** A server one bot added is not shared with the others: ask each bot that needs it.
- **No more access than the bot.** A server runs inside the bot's VM, or is reached through the workspace's network rules, so it can do only what the bot can.
- **Tokens in headers.** A secret works when the server sends its token in an HTTP header, as most do. A server that needs the raw value itself, to sign requests for example, cannot use the placeholder.
- **Browser logins.** Servers that sign in through a browser (OAuth) may not manage it from a VM: when there is a choice, give the bot a token instead.

Household-wide MCP servers, set up once for every bot in a workspace, may come later. Until then, your bots are happy to help. 🙂
