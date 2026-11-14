# Network and secrets

A bot's VM has no way to the internet of its own. Everything it sends goes through Household on your machine, which lets through only the hosts on the workspace's allowlist. Secrets travel the same road: the bot holds a placeholder, and Household puts the real token into its requests on the way out, only to the hosts you chose. A coding bot with `api.github.com` allowed and a GitHub token opens pull requests, but never sees the token and cannot post your files to a paste site.

## When it helps

- A bot that reads mail and web pages cannot send what it read to a stranger's server.
- A bot uses your GitHub or npm token without being able to leak it.
- A bot reaches one database on your home network, and nothing else there.
- A one-off need ("I need docs.rs") opens for 15 minutes, not for good.

## How it works

- **One way out.** Each bot runs in its own hardware-virtualised VM, whose only exit is Household's proxy. Web requests work for allowed hosts; other TCP (SSH, git over SSH, a database) works when that host and port are allowed. UDP and programs that ignore the proxy do not get out.
- **One allowlist per workspace,** shared by its bots and their sideworkers. [Scouts](../scouts/) get only the network their capabilities give.
- **Your local network stays closed.** Only an exact entry you write yourself, such as `nas.local:445`, reaches a private address. Wildcards, `*` and chat approvals reach public addresses only, so a name someone points at your router cannot open your network.
- **Your harness's hosts,** such as its model provider, are added for you.
- **Most traffic stays sealed.** For an ordinary host, the bot's HTTPS runs end to end: Household sees the host and port, not the content. For the hosts that get a key (the model provider, and each secret's hosts), Household terminates TLS with its own certificate authority, which every VM trusts, fills the key into the request header, and sends the request on.
- **Everything is logged** in the bot's **Logs**: allowed, denied or failed, and whether it was intercepted.

## How to think about the allowlist

The allowlist limits where data can go, not what goes there.

- **An allowed host is also a way out.** `github.com` means every repository on GitHub, not only yours: a bot tricked by a web page can push what it read to one the attacker owns, with a token the page hands it. The same holds for any host where anyone can upload, such as shared storage (`storage.googleapis.com`, in the Go preset) or paste sites. Allow the narrowest host that does the job.
- **Allow forever is for the whole workspace.** One tap on a bot's request opens the host to every bot and sideworker in it, today and later. For one bot's one-off need, choose **Allow 15 min**. Bots that need different reach belong in different workspaces.
- **`*` gives up the allowlist.** Any public host on port 443 (`*:*`: any port). A tricked bot can send what it read anywhere; bots stop asking, so the chat no longer shows you what they reach; secrets from the chat are refused. Your local network and this machine stay closed. Keep it for a workspace whose bots hold nothing worth taking.
- **Connectors are not on it.** A [connector](../connectors/) works from Household on your machine, and your Claude or ChatGPT account's connectors work through the provider, so the allowlist never sees the services they reach. A write connector is a way out the allowlist does not cover.

## The allowlist

**Workspace → Network.** Presets (Python, Node, Debian, Rust, Go, Docker Hub, GitHub) add ordinary entries you can remove one by one.

| Entry | Allows |
| --- | --- |
| `example.com` | one host, on port 443 |
| `example.com:22` | that host on another port: `:80` for plain HTTP, `:22` for SSH |
| `*.example.com` | its subdomains at any depth, not `example.com` itself |
| `*` | any public host on port 443; `*:*` on any port |

## When a bot asks for a host

A bot that needs a host asks in its chat, with its reason and the addresses the host points to now. **Allow 15 min** opens that host and port, at those addresses, to that bot only. **Allow forever** adds the host to the workspace's allowlist, after one more confirmation. Only owners can answer, and an unanswered request lapses after five minutes.

A bot can ask only for one exact host name, never a wildcard or an IP address; a name pointing into a private network is refused without asking you. A scout gets only **Allow 15 min**, for its run. Revoke a running grant under **Workspace → Network → Temporary access**.

## Secrets

A secret is a token saved with its hosts and a variable name, say `GITHUB_TOKEN` for `api.github.com`. Inside the VM the variable holds a placeholder, `household-secret-github`. When the bot sends it in a header to one of those hosts, Household swaps in the real token on the way out; login and password pairs, as git sends them, work too. Anywhere else the placeholder is a meaningless string. The real value never enters a VM, so a bot cannot leak it, even by accident.

**Add one** under **Workspace → Secrets**. Templates fill in GitHub, npm and Hugging Face; change the header under **Advanced** if the service does not use `Authorization`. A secret chooses where its value is filled in, never where bots may go: its hosts still have to be on the allowlist. A new secret works at once; a new variable reaches a bot at its next VM start.

**Who gets it.** Once the workspace has scout capabilities, a secret goes either to every bot and sideworker or only to scouts with a capability; the latter keeps even the placeholder away from bots.

**From the chat.** A bot that needs a token asks with a card; reply `/secret <value>` (`!secret` in Slack). Household deletes your message before the bot sees it, as it does with a token pasted by mistake, then asks you to confirm. In Slack, and in a Telegram group where the bot cannot delete messages, delete it yourself. Unasked, `/secret <name> <value> <domain>` saves one as `SECRET_<NAME>`. It never overwrites a secret, and is refused while the workspace allows `*`.

### What a placeholder cannot do

Substitution happens at egress, not inside the VM, so it works only for a token in an HTTP header to the secret's hosts. An SSH key, a database password, a request the bot signs itself (as with AWS keys), or a token in a URL or body needs the real value, and the bot tells you so first. Send it as is, knowing the bot and its model provider see it and it stays in the chat history, or give the job to a [scout](../scouts/), which holds the value in a throwaway VM the bot never sees.

## Put it to use

A coding bot reads issues from strangers and ships fixes. Give its workspace the GitHub preset and a GitHub token as a secret. Save your hosting provider's production token for **Only scouts with a capability**, so the bot that reads strangers' text never holds even its placeholder; a deploy [scout](../scouts/) uses it when you approve the run.

## From the terminal

```sh
house workspace allow|disallow <workspace> <host>
house workspace show <workspace>                  # includes temporary grants
house workspace revoke <workspace> <host[:port]>
house secret add <workspace> <name> --host h1,h2 --env VAR   # value from standard input
house secret set|rm …
```

## Related

- [Scouts](../scouts/): keys and networks a bot should not hold
- [Keys](../keys/): model keys, filled in the same way
- [Connectors](../connectors/): accounts, outside the allowlist
