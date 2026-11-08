# Household

Run Claude Code and Codex agents as personal assistants in Telegram, each in its own microVM, with network access
and credentials under your control.

## Requirements

macOS on Apple silicon, or Linux with `/dev/kvm` (your machine, a VM with nested virtualization, or a KVM VPS);
openssl and python3. The installer brings the rest: microsandbox, Codex, the web UI. No Bun, no Docker.

## Quick start

```sh
curl -fsSL https://agents-household.dev/install.sh | sh
house onboard      # a key, a house, its Telegram bot, a pet, scouts and sideworkers, step by step
house start
```

`house update` moves to the newest release. `house dashboard` signs you in to the web admin; `house --help` lists everything else.
