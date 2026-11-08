# Household

Run Claude Code and Codex agents as personal assistants in Telegram, each in its own microVM, with network access
and credentials under your control.

## Requirements

Bun, [microsandbox](https://microsandbox.dev) 0.7.13, Docker, openssl, python3. macOS on Apple
silicon, or Linux with `/dev/kvm`.

## Quick start

```sh
git clone https://github.com/underwear/household && cd household
git checkout "$(git tag --sort=-v:refname | head -1)"   # the newest release
bun run setup
alias house="bun $PWD/src/cli/main.ts"
house doctor
house --help
```
