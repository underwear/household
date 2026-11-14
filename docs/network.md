# Network and secrets

A bot can only reach the hosts its workspace allows. Everything else is closed. This matters because a bot reads things you did not write: web pages, mail, forwarded messages. If one of them tricks it, the bot still cannot send your files to a stranger's server. When a bot needs a new host, it asks you in the chat.

Secrets work the same way. You give a bot a token (GitHub, npm and so on) as a placeholder it cannot read. Household puts the real value into the bot's requests on their way out, and only to the hosts you chose.

## How bots reach the internet

Every bot runs in its own VM with no direct way out. All its traffic goes through Household on your machine, which checks each connection against the workspace's allowlist:

- Web requests (HTTP and HTTPS) work for any allowed host.
- Other TCP connections, such as SSH, git over SSH or a database, work too, as long as that host and port are allowed. `example.com:22` allows SSH to one host.
- UDP and programs that ignore the VM's proxy settings do not get out.
- Your local network stays closed unless you add one of its hosts to the allowlist yourself, by its exact name.

Each workspace has its own allowlist, temporary access and secrets. A bot in one workspace never gets another workspace's.

To see what a bot tried to reach, open the bot, press **Logs** and turn on **Network**. Every request is there: allowed, denied or failed.

## The allowlist

Go to **Workspace → Network**. **Domains allowlist** lists every host the workspace's bots can reach.

- **Add a host.** Type it in the field and press **Add host**, then confirm.
- **Add from a preset.** Pick one under **Add from a preset…**. You see the hosts it adds before anything changes, and press **Add hosts**. A preset only adds ordinary entries, which you can remove one by one later. Presets: Python · PyPI, Node · npm, Debian · apt, Rust · Cargo / rustup, Go · modules, Docker Hub · container images and GitHub · source / releases.
- **Remove a host.** Remove it from the list, and the workspace's bots are denied it.

Hosts tagged **by harness** are the ones the bots' harness needs, such as its model provider. Household adds them, and you cannot remove them here. Hosts marked **approved in chat · public addresses only** are ones you allowed forever from a bot's request.

How to write an entry (**Domain formats** on the page shows the same):

| Entry | Allows |
| --- | --- |
| `example.com` | one host, on port 443 (HTTPS) |
| `example.com:80` | that host over plain HTTP; `:22` for SSH, any other port the same way |
| `*.example.com` | its subdomains at any depth, not `example.com` itself |
| `*` | any public host on port 443; `*:*` any port |

⚠️ **`*` opens the whole internet.** A bot tricked by a web page or a forwarded message can then send what it has read anywhere. Household asks you to confirm with **I understand the risk**. Your local network and this machine stay closed even then.

From the command line: `house workspace allow <workspace> <host>` and `house workspace disallow <workspace> <host>`.

## When a bot asks for a host

When a bot needs a host that is not allowed, it asks you in its chat. The card shows which bot, which host and port, why it needs it (in the bot's own words) and the addresses the host points to right now. You have three answers:

- **Allow 15 min.** Only this bot, only this host and port, only at the addresses shown, for 15 minutes. Then it closes by itself.
- **Allow forever.** Household asks once more (**Yes, forever**). The host joins the workspace's allowlist, so every bot in the workspace can reach it until you remove it.
- **Deny.** The bot gets nothing.

Only owners can answer. If nobody answers within five minutes, the request lapses and nothing is allowed.

A bot can only ask for one exact host name, never a wildcard or an IP address. A name that points into a private network is refused without asking you, and you are told. If you do want a bot to reach such a host, add it to the allowlist yourself.

A [scout](../scouts/) can ask too, but only for its current run: you see **Allow 15 min** and **Deny**, with no "forever".

### See and revoke temporary access

**Workspace → Network → Temporary access** lists every 15-minute grant: the host and port, the bot, the minutes left and the bot's reason. Press **Revoke** to end one now. Only that bot loses access to that host and port.

From the command line: `house workspace show <workspace>` lists them, and `house workspace revoke <workspace> <host[:port]>` ends one.

## Secrets

A secret is a token of yours that bots use without seeing it: a GitHub token, an npm token, an API key for a service.

Here is what happens:

1. You save the secret with the hosts it is for, say `api.github.com`, and a variable name, say `GITHUB_TOKEN`.
2. Inside each bot's VM, `GITHUB_TOKEN` holds a placeholder, `household-secret-github`, not the token.
3. The bot uses the variable as usual, for example in an `Authorization` header.
4. On the way out, when a request goes to one of the secret's hosts, Household swaps the placeholder in that header for the real token. Login and password pairs, as git sends them, work too.

Sent anywhere else, the placeholder is just a meaningless string. The real token never enters a VM, so a bot cannot leak it, even by accident.

### Add a secret

1. Go to **Workspace → Secrets → + Add secret**.
2. Under **Start from**, pick **GitHub**, **npm** or **Hugging Face** to fill in the hosts and variable, or **Custom** to start empty.
3. Fill in the **Name**, the **Variable** where bots find it, the **Value** and the **Hosts**: exact hosts, comma-separated.
4. Under **Advanced**, change the **Header** if the service does not use `Authorization`.
5. Press **Add secret**.

Saving a secret does not open its hosts. If a host is not on the allowlist, the secret's row says **Not allowed in Network**, with an **Allow** button next to it.

A new secret works right away. A new variable reaches each bot at its next VM start. Removing a secret takes effect right away; the bots keep running. **Reveal** shows a secret's value, and **Edit** changes it.

**Who gets it** appears when the workspace has scout capabilities. **Every bot in this workspace** is the default; sideworkers share their bot's secrets. **Only scouts with a capability** keeps it from bots and sideworkers altogether, not even as a placeholder. See [Scouts](../scouts/).

From the command line: `house secret add <workspace> <name> --host h1,h2 --env VAR`. Leave out `--value`, and the value is read from standard input, so it stays out of your shell history. `house secret set` changes one and `house secret rm` removes one.

### Secrets from the chat

When a bot needs a token you have not saved, it asks you in the chat. The card says what for, which hosts, which variable, and why. Reply with `/secret <value>` (in Slack, `!secret <value>`). Household deletes your message before the bot sees it, then asks you to confirm with **Yes, save**. The request expires after 10 minutes, and **Cancel request** drops it.

You can also save one without being asked: `/secret <name> <value> <domain>`, with several domains separated by commas. Bots find it in the variable `SECRET_<NAME>`: `/secret github ghp_… api.github.com` gives them `SECRET_GITHUB`.

If you paste something that looks like a token into the chat by mistake, Household deletes it before the bot sees it and offers to save it as a secret. You can still send it as is, after a warning.

Notes:

- In Slack, and in a Telegram group where the bot cannot delete messages, delete your message yourself.
- `/secret` never overwrites an existing secret. Change it on the **Secrets** page.
- A bot can ask to change a secret's hosts, variable or header, or to remove it. You approve each change in the chat.
- Secrets from the chat need an allowlist. While the workspace allows the whole internet (`*`), they are refused.
- Reaching the secret's hosts is a separate question. If they are not allowed yet, the bot asks for them too.

### What a placeholder cannot do

Household can only fill a secret into an HTTP header of a request to one of the secret's hosts. Anything else needs the real value, which is the placeholder's whole point to avoid:

- An SSH key or a database password is used inside the VM, not sent as a header.
- A request the bot has to sign itself (as with AWS keys) needs the real key to compute the signature.
- A token sent in a URL or a request body is not filled in.

For these, the bot tells you before it goes on. You can send it the value in the chat as is, knowing that the bot and its model provider then see it and it stays in the chat history. Or you can give the job to a [scout](../scouts/), which holds the value in a throwaway VM and never shows it to the bot.

Model keys for the harness itself are not secrets. They live on the [Keys](../keys/) page and work the same way: the bot never sees them.
