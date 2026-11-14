# Keys

A key is what your bots run on: your access to Claude or ChatGPT. It can be your subscription, signed in through Household, a subscription token you paste, or a pay-per-use API key. You add keys once, under Household's settings, and then pick one for each bot. Household keeps every key on your machine; the bots themselves never get to see it.

## Which key to choose

Claude Code bots run on Claude keys, and Codex bots on ChatGPT / OpenAI keys:

| | Claude Code | Codex |
| --- | --- | --- |
| Sign in (recommended) | **Sign in to Claude**: Pro, Max or Team | **Sign in to ChatGPT**: Plus or Pro |
| Pasted token | **Claude subscription token** from `claude setup-token` | — |
| Pay per use | **Anthropic API key** | **OpenAI API key** |

- **Sign in** is the easiest, and the only kind that brings the account's connectors (see [Account connectors](#account-connectors)). A Claude sign-in needs renewing about once a month.
- **Claude subscription token** lasts a year with nothing to renew, but has no claude.ai connectors.
- **API keys** are billed per use by Anthropic or OpenAI, with no subscription to run out of.

You can have as many keys as you like, several of one provider too. Give each bot the one it should spend.

## Add a key

1. In the admin, open the **Household** card in the sidebar, then **Settings**. Under **Keys**, press **+ Add key**.
2. Choose the provider: **Claude** or **ChatGPT / OpenAI**.
3. Choose how it signs in. The recommended way is marked.
4. Name the key under **Key name** (for example `claude`, or `claude-work` for a second account), then follow the steps in the dialog:
   - **Sign in to Claude**: press **Get sign-in link**. Household starts Claude Code's own sign-in and shows a link. Open it on any device, your phone too, and sign in to the account your bots should use. Paste the code Claude shows under **Code** and press **Connect**. The link works once, for 10 minutes. The very first sign-in downloads a VM image of about 1.4 GB, so it can take a few minutes.
   - **Sign in to ChatGPT**: press **Sign in with ChatGPT**. Open the link shown, sign in and enter the code. The dialog finishes by itself. If ChatGPT refuses device codes, allow them in its security settings.
   - **Claude subscription token**: on any computer with Claude Code, run `claude setup-token`, sign in, and paste the token it prints (`sk-ant-oat01-…`).
   - **API key**: create one in the [Claude Console](https://platform.claude.com/settings/keys) or on the [OpenAI Platform](https://platform.openai.com/api-keys) and paste it. They show it only once.

The key now appears in the list with its provider and kind, and **Used in** shows which bots run on it. Pick it for a bot under **Key** when you add the bot, or later on its **Harness** tab.

`house onboard` asks for a key the same way when you set up Household.

## What "the bot never sees it" means

A key stays on your machine, in Household's config. Inside the bot's VM there is only a stand-in value. When the bot talks to Claude or ChatGPT, its request goes through Household on the way out, and Household puts the real key in at that moment. So even if a bot were tricked into printing everything it has, your key would not be in it. The same holds for the secrets you give a workspace.

You can still see a pasted key yourself: **Reveal** in the list shows it in full. A signed-in key has nothing to reveal; its tokens stay with Household.

## Signed-in keys

Household keeps a sign-in fresh by itself. The list shows whose account it is and the date to sign in again by.

Claude ends a sign-in about once a month. From five days before, Household posts a reminder once a day in the chats of the bots that use it. When the day comes, press **Sign in again** next to the key and repeat the sign-in. If you sign in to another account, the key's bots move to it. Once a sign-in has ended, its bots get no answers until you sign in again.

This sign-in belongs to Household alone. The Claude Code or ChatGPT on your own computer is not touched. A [backup](../backup/) does not carry it either: after restoring on a new machine, the key says it is not signed in, and **Sign in again** fixes it.

## Allowance and overage

A Claude subscription has usage windows, such as 5 hours and 7 days. For Claude subscription keys, signed in or pasted, the list shows how much of each window is used and when it resets.

When a window is used up, Claude may go on in "extra usage" and bill it apart from the subscription. Household does not let that happen by surprise: by default it refuses the bots' requests on that key until the window resets. To let them go on and pay for it, press **Edit** on the key and tick **Go on in overage (billed apart from the subscription)** under **Past its allowance**.

API keys have no allowance: you pay for what you use.

## Limit a key to some workspaces

By default every workspace's bots may run on every key. To keep a key for some workspaces only, press **Edit** on it and tick them under **Workspaces**. With none ticked, it is for every workspace. Bots in other workspaces won't see it in their **Key** list.

**Edit** also has a **Note**, which only you see (for example "Max subscription"), and for a pasted key its value. **Remove** deletes a key, but only once no bot runs on it.

## Account connectors

A signed-in key brings the connectors of its account. On claude.ai you may already have connected Google Drive, Jira, GitHub and the like; in ChatGPT these are called apps. A bot on that key can use them too, as that account.

This is off by default, one switch per bot: on its **Harness** tab, under **Harness options**, turn on **Claude.ai connectors** (Claude Code) or **ChatGPT apps** (Codex). The bot's sideworkers get them too. Scouts never do. A pasted token or an API key has no connectors, so the switch is greyed out on those.

⚠️ The bot acts as you in those services, with every connector of that account and whatever access you gave each one there. For finer control, such as read-only access to one mailbox, use the workspace's own [Connectors](../connectors/) instead.

## From the terminal

On a server without a browser at hand, the `house` command does the same:

- `house key claude <name>` signs in to Claude. It prints the link and asks for the code. Run it again to sign in anew.
- `house key codex <name>` signs in to ChatGPT with a code.
- `house key add <name> --provider anthropic|openai` adds a pasted token or API key. It asks for the value without showing it.
- `house key set <name> --allow-overage on|off` and `--workspaces a,b` change the settings above.
- `house key rm <name>` removes a key.
