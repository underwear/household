---
name: household
description: Install, set up, run, update and debug Household (github.com/underwear/household), the daemon that runs Claude Code and Codex agents ("pets") in microVMs and talks to them through Telegram. Use when the user wants to install or deploy Household, add a house, pet, Telegram bot, key or secret, set up scouts and capabilities, run it as a service, update it, or find out why a pet, scout or channel does not work.
---

# Household

Household is a daemon (`house`) on the user's Mac or Linux machine. It runs AI agents ("pets") in microVMs,
proxies all their network traffic through an allowlist, puts keys and secrets into requests on the way out (pets
only ever see placeholders) and connects each house to a Telegram bot.

- **house** — a trust zone: network allowlist, secrets, a Telegram bot (channel), owners.
- **pet** — an agent in a house: `claude-code-tmux` (Anthropic key) or `codex-app-server` (OpenAI key), each in its
  own VM with a persistent home and memory, with its own thread in the chat.
- **scout** — a specialist VM for one task, built from **capabilities** (install script, network, keys). Pets call
  scouts by name; the owner approves every run, or starts one with `house scout run`.
- **sideworker** — an extra VM a pet starts for a long task.

## What to read

- Installing or deploying it, first setup, keys, the Telegram bot, running as a service: [install.md](install.md)
- Everyday changes — pets, network, secrets, scouts and capabilities, updates: [operate.md](operate.md)
- Something does not work: [debug.md](debug.md)

## Rules

- **Secrets go from the user straight to `house`, never through you.** Agent keys, bot tokens and secret values
  are read from stdin. Give the user the exact command to run in their own terminal (`pbpaste | house key add …`);
  do not ask them to paste a secret into the chat, and never put one on a command line or in a file.
- **Sign-ins are the user's.** `claude setup-token`, `house key codex` and BotFather need the user in a browser or
  in Telegram: say what to do, wait for them.
- **Ask before anything destructive or costly:** `house pet rm`, `house delete`, `house pet set --agent` (a new VM),
  `house pet restart` / `disable` (the agent's session ends), `house import --force`, `house migrate restore`,
  `house allow <house> '*'`, `house capability key add`, starting a scout.
- **Read before you change.** `house doctor`, `house status`, `house show <house>` and `house ls` change nothing.
- **Every group has help:** `house --help`, `house scout --help`, `house capability --help`, `house features --help`.
  Scout, capability and features commands take `--json`.
- The config is `~/.config/household/household.yaml` (mode 600; it holds keys and tokens). Prefer CLI commands to
  editing it: they check every change and reload the daemon. After a hand edit run `house reload`.
