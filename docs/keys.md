# Keys

A key is the model account your bots run on: a Claude or ChatGPT subscription you sign in to through Household, a subscription token you paste, or a pay-per-use API key. One key signed in to your Claude Max plan can run all the family bots. Keys stay on your machine; bots never see them.

## What you'd use it for

- **Run bots on the subscription you already pay for.**
- **Keep spending apart**: one key per account or budget, limited to the workspaces that may use it.
- **Give a bot your account's connectors**: claude.ai connectors or ChatGPT apps you already set up.
- **Avoid surprise bills**: a used-up subscription key stops instead of running into extra usage.

## Subscription or API key

This choice sets your cost.

- **A subscription** (a sign-in or a pasted token) costs its monthly price and no more. Its use comes in windows, such as 5 hours and 7 days, and every bot on the key draws from the same windows as your own use of that account. When a window is used up, the bots get no answers until it resets, unless you allow overage. Best for personal bots and everyday use.
- **An API key** is billed per token, with no windows. A bot that wakes for every inbox event or runs a task every half hour adds up. Best for a busy, unattended bot, or to keep bots out of the subscription you use yourself.

Start with a sign-in. Move a bot to an API key, or to a second subscription, when it starts crowding out your own use.

| Kind | For | Billed | Renew | Account connectors |
| --- | --- | --- | --- | --- |
| **Sign in to Claude** | Claude Pro, Max or Team | Subscription | Sign in again about once a month | claude.ai connectors |
| **Claude subscription token** (`claude setup-token`) | Claude Pro, Max or Team | Subscription | After a year | None |
| **Sign in to ChatGPT** | ChatGPT Plus or Pro | Subscription | Household keeps it fresh | ChatGPT apps |
| **Anthropic API key** / **OpenAI API key** | Your Console or Platform account | Per use | Never | None |

A key fits the harness that uses its provider: Claude keys for Claude Code, ChatGPT and OpenAI keys for Codex.

## How it works

- **The bot never holds it.** The key stays in Household's config on your machine. Inside the VM there is a stand-in; Household puts the real key into the bot's model requests on the way out. A bot tricked into printing everything it has still can't print your key.
- **Household's own sign-in.** It is a session of its own: the Claude Code or ChatGPT on your computer is not touched. Household renews its tokens itself.
- **One list for the whole Household**, under **Household → Settings → Keys**. Every workspace's bots may use every key unless you limit it.
- **Allowance metering** (Claude subscriptions). Household reads each window's use from Claude's answers, shows it next to the key, and by default refuses the bots' requests once a window is used up, until it resets.

## What else you decide

- **Overage.** Claude can go on past a used-up window in "extra usage", billed apart. Off by default; turn on **Go on in overage** under the key's **Edit** if a bot must not stop.
- **Which workspaces.** Under the key's **Edit**, tick workspaces to keep it for them only.
- **Account connectors.** A bot on a sign-in can use the connectors (claude.ai) or apps (ChatGPT) set up in that account (Drive, Jira, GitHub…): one switch per bot on its **Harness** tab, off by default. Its sideworkers get them too; scouts never do.

⚠️ With account connectors, the bot acts as you, with every connector of that account and whatever access you gave each one there. For narrower access, such as read-only on one mailbox, use the workspace's own [Connectors](../connectors/).

## Set it up

**Household → Settings → Keys → + Add key** (`house onboard` asks for the first one). Then pick it for a bot when you add it, or on its **Harness** tab. What to know per kind:

- **Sign in to Claude**: open the link on any device and sign in to the account the bots should use. The link works once, for 10 minutes. The first sign-in downloads a VM image of about 1.4 GB.
- **Sign in to ChatGPT**: if ChatGPT refuses device codes, allow them in its security settings.
- **Claude subscription token**: run `claude setup-token` on any computer with Claude Code and paste the `sk-ant-oat01-…` token.
- **API key**: from the [Claude Console](https://platform.claude.com/settings/keys) or the [OpenAI Platform](https://platform.openai.com/api-keys). They show it only once.

## Limits and good to know

- **Claude sign-ins end about monthly.** From 5 days before, Household posts a daily reminder in the chats of the key's bots. Once it has ended, they get no answers until you press **Sign in again**. Signing in to another account there moves the key's bots to it.
- **Backups don't carry a Claude sign-in.** After a restore, press **Sign in again**. See [Back up and move](../backup/).
- **API keys are never refused**; you pay for what you use.
- A key can be removed only once no bot runs on it.

From the terminal: `house key claude <name>` or `house key codex <name>` signs in; `house key add <name> --provider anthropic|openai` adds a pasted token or API key; `house key set <name> --allow-overage on|off`, with `--workspaces a,b` on `add` or `set`; `house key rm <name>`.

## Put it to use

Two keys, two budgets: your Claude Max sign-in as `claude` for the family bots, and an Anthropic API key as `ops`, limited to the ops workspace. The night ops bot that wakes on every Grafana [inbox](../inboxes/) alert then never uses up the windows your family bots and your own Claude Code share.

## Related

[Bots](../bots/) · [Connectors](../connectors/) · [Network and secrets](../network/)
