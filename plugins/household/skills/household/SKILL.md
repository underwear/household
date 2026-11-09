---
name: household
description: Install, set up, run, update and debug Household (github.com/underwear/household), the daemon that runs bots powered by Claude Code and Codex harnesses in microVMs and talks to them through Telegram. Use when the user wants to install or deploy Household, add a workspace, bot, Telegram bot, key or secret, set up scouts and capabilities, run it as a service, update it, or find out why a bot, scout or channel does not work.
---

# Household

A daemon (`house`) on the user's Mac or Linux machine. It runs bots powered by AI harnesses in microVMs, sends all their
traffic through a per-workspace allowlist, puts keys and secrets into requests on the way out (bots see only
placeholders) and connects each workspace to a Telegram bot.

- **workspace** — a trust zone: allowlist, secrets, a Telegram bot (channel), owners.
- **bot** — an assistant in a workspace, powered by a harness (`claude-code-tmux` on an Anthropic key, `codex-app-server` on an OpenAI key), in its
  own VM with a persistent home and memory, with its own thread in the chat.
- **harness** — the runtime that powers a bot: Claude Code or Codex.
- **scout** — a one-task VM built from **capabilities** (install script, network, keys). Bots call scouts by name.
- **sideworker** — an extra VM a bot starts for a long task.

`house --help` (and `--help` on every group) lists every command. The config is
`~/.config/household/household.yaml`; CLI commands and the web UI edit it and reload the daemon.

- Install and first setup: [install.md](install.md)
- Everyday changes and updates: [operate.md](operate.md)
- Something does not work: [debug.md](debug.md)
