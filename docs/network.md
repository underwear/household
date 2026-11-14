# Network and secrets

A bot's VM has no way to the internet of its own. Everything it sends goes through Household on your machine, which lets through only the hosts on the workspace's allowlist. Secrets travel the same road: the bot holds a placeholder, and Household puts the real token in on the way out, only to the hosts you chose. A coding bot with a GitHub token opens pull requests but never sees the token.

## How it works

- **One way out,** through Household's proxy. Web requests and other TCP (SSH, a database) reach allowed hosts and ports only.
- **One allowlist per workspace,** shared by its bots and their sideworkers. Your harness's hosts, such as its model provider, are added for you.
- **Your local network stays closed.** Only an exact entry you write yourself, such as `nas.local:445`, reaches a private address. Wildcards, `*` and chat approvals reach public addresses only, so a name someone points at your router cannot open your network.
- **Household sees the host, not the content,** except where it fills in a key.
- **[Connectors](../connectors/) are not on it,** so a connector that can change things is a way out the allowlist does not cover (unless it asks you first).

The allowlist limits where data can go, not what goes there:

- **An allowed host is also a way out.** `github.com` means every repository on GitHub, not only yours: a bot tricked by a web page can push what it read to an attacker's repository. So does any host where anyone can upload, such as paste sites. Allow the narrowest host that does the job.
- **Allow forever is for the whole workspace.** It opens the host to every bot and sideworker in it, today and later. For one bot's one-off need, choose **Allow 15 min**. Bots that need different reach belong in different workspaces.
- **`*` gives up the allowlist.** A tricked bot can send what it read anywhere, bots stop asking so the chat no longer shows what they reach, and secrets from the chat are refused. Keep it for a workspace whose bots hold nothing worth taking.

## The allowlist

**Workspace → Network.** Presets (Python, Node, GitHub and more) add entries in one go.

| Entry | Allows |
| --- | --- |
| `example.com` | one host, on port 443 |
| `example.com:22` | that host on another port, such as SSH |
| `*.example.com` | its subdomains at any depth, not `example.com` itself |
| `*` | any public host on port 443; `*:*` on any port |

## When a bot asks for a host

A bot asks in its chat for one exact host name, never a wildcard or an IP address. **Allow 15 min** opens it to that bot only. **Allow forever** adds it to the workspace's allowlist. Only owners can answer.

## Secrets

A secret is a token saved with its hosts and a variable name, say `GITHUB_TOKEN` for `api.github.com`. In the VM the variable holds a placeholder; when the bot sends it in a header to one of those hosts, Household swaps in the real token. The real value never enters a VM, so a bot cannot leak it.

**Add one** under **Workspace → Secrets**. A secret chooses where its value is filled in, not where bots may go: its hosts still have to be allowed. With scout capabilities, you can give a secret to scouts only, keeping even the placeholder from bots.

**From the chat.** When a bot asks for a token, reply `/secret <value>` (`!secret` in Slack). Household deletes your message before the bot sees it. In Slack, and in a Telegram group where the bot cannot delete messages, delete it yourself.

<details>
<summary>Advanced: other headers, and saving a secret unasked</summary>

A service that does not use `Authorization` gets its header under **Advanced**. Unasked, `/secret <name> <value> <domain>` saves `SECRET_<NAME>`, never overwriting one.

</details>

### What a placeholder cannot do

Substitution happens on the way out, so it works only for a token in an HTTP header to the secret's hosts. An SSH key, a database password, a request the bot signs itself (as with AWS keys), or a token in a URL or body needs the real value. The bot tells you so first. Send it as is, knowing the bot and its model provider see it and it stays in the chat history, or give the job to a [scout](../scouts/), which holds the value in a throwaway VM the bot never sees.
