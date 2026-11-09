# Household

Run personal assistant bots in Telegram using Claude Code or Codex as their harness, each in its own microVM, with network access
and credentials under your control.

## Requirements

macOS on Apple silicon, or Linux with `/dev/kvm` (your machine, a VM with nested virtualization, or a KVM VPS);
openssl and python3. The installer brings the rest: microsandbox, Codex, the web UI. No Bun, no Docker.

## Quick start

```sh
curl -fsSL https://agents-household.dev/install.sh | sh
house onboard      # a key, a workspace, its Telegram channel, an assistant bot, scouts and sideworkers, step by step
house start
```

`house update` moves to the newest release. `house dashboard` signs you in to the web admin; `house --help` lists everything else.

A **workspace** groups bots, channels, network rules and secrets. A **bot** is your persistent assistant; its **harness** is the runtime it uses, such as Claude Code or Codex. The CLI remains `house`, with `house workspace` and `house bot` commands, and `--harness` for runtime selection. Existing configuration keys (`houses`, `pets`, `agent`) remain compatible.

## Slack

Talk to your bots in a Slack bot DM, alongside Telegram: the default bot in Messages, others in threads, progress, Stop and decisions with buttons. No public URL; tokens stay on the host. See [connecting Slack](docs/slack.md).

## Inboxes

A workspace can watch mail, feeds, health checks, Grafana and Datadog alerts, a Telegram bot or your own endpoint, and hand new events to the bots you choose, from the admin. See [inboxes](docs/inboxes.md).
