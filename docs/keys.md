# Provider keys

A provider key is the model account your bots run on: a Claude or ChatGPT subscription or a pay-per-use API key. One Claude Max sign-in can run all the family bots. Bots never hold it; Household adds it to their requests, like any [secret](../network/).

## Subscription or API key

- **A subscription** costs its monthly price and no more. Its use comes in windows, such as 5 hours and 7 days, shared by every bot on the key and your own use of that account. When a window is used up, the bots get no answers until it resets. Best for personal bots and everyday use.
- **An API key** is billed per token, with no windows and no refusals. A bot that wakes for every inbox event adds up. Best for a busy, unattended bot, or to keep bots off your own subscription.

Start with a sign-in. Move a bot to an API key or a second subscription when it crowds out your own use.

| Kind | For | Billed | Renew | Account connectors |
| --- | --- | --- | --- | --- |
| **Sign in to Claude** | Claude Pro, Max or Team | Subscription | Sign in again about once a month | claude.ai connectors |
| **Claude subscription token** (`claude setup-token`) | Claude Pro, Max or Team | Subscription | After a year | None |
| **Sign in to ChatGPT** | ChatGPT Plus or Pro | Subscription | Household keeps it fresh | ChatGPT apps |
| **Anthropic API key** / **OpenAI API key** | Your Console or Platform account | Per use | Never | None |

Claude keys fit Claude Code; ChatGPT and OpenAI keys fit Codex. A sign-in doesn't touch the Claude Code or ChatGPT on your computer.

## What you decide

- **Overage.** Once a Claude window is used up, Household refuses the bots' requests. Turn on **Go on in overage** under the key's **Edit** if a bot must not stop; Claude bills the extra usage apart.
- **Which workspaces.** Every workspace may use every key unless you tick the ones it is for under **Edit**.
- **Account connectors.** A bot on a sign-in can use the connectors or apps set up in that account: a switch on its **Harness** tab, off by default. Its sideworkers get them too; scouts never do.

⚠️ With account connectors, the bot acts as you, with every connector of that account and whatever access you gave each one there. For narrower access, such as read-only on one mailbox, use the workspace's own [Connectors](../connectors/).

## Set it up

Add keys under **Household → Settings → Keys** and pick one on a bot's **Harness** tab. A sign-in gives a link to open on any device; an API key comes from the [Claude Console](https://platform.claude.com/settings/keys) or [OpenAI Platform](https://platform.openai.com/api-keys).

Before a Claude sign-in ends, Household reminds you in the bots' chats; once it has, press **Sign in again**. Do the same after a [restore](../backup/).
