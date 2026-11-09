<div align="center">

<a href="https://agents-household.dev"><img src="landing/favicon.svg" width="88" alt="Household logo"></a>

# Household

**A home for your bots.**

Household runs each bot with a harness like Claude Code or Codex in its own sandbox,<br>
and lets you talk to it from the messenger you already use.

[![Website](https://img.shields.io/badge/agents--household.dev-1f1d1a?style=flat-square&logo=homeassistantcommunitystore&logoColor=72c191)](https://agents-household.dev)
[![Docs](https://img.shields.io/badge/docs-read-f2f0eb?style=flat-square)](https://agents-household.dev/docs/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-72c191?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/macOS%20%C2%B7%20Linux%2BKVM-1f1d1a?style=flat-square&logo=linux&logoColor=white)](#requirements)

[Quick start](#quick-start) · [What's inside](#whats-inside) · [Docs](https://agents-household.dev/docs/) · [Website](https://agents-household.dev)

<br>

<img src=".github/assets/hero.svg" width="760" alt="The Ops bot's Telegram thread: Grafana fires at 3 am, the bot frees the disk, restarts the API and reports in the morning">

</div>

<br>

## ✨ Why Household

- 🔒 **Its own microVM.** Every bot runs in a separate sandbox, away from your machine and from the other bots.
- 🌐 **Network on your terms.** A bot reaches only the hosts the workspace allows, and asks you when it needs one more.
- 🔑 **Secrets it never sees.** The bot holds only placeholders; Household puts the real keys into requests on their way out, to the hosts you chose.
- 🕵️ **Dangerous jobs go to scouts.** A bot hands risky work to a throwaway VM with only the access it needs: "find this movie on a torrent site" sends a scout onto untrusted sites without exposing the bot’s files or secrets.
- 💬 **Where you already are.** Talk to your bots in Telegram threads: progress, Stop and decisions come as buttons.
- 🧰 **Real harnesses.** Each bot is a real Claude Code or Codex, so anything they can do, your bot can do.
- 📬 **Wakes up on its own.** Inboxes hand mail, feeds, health checks and Grafana or Datadog alerts to the bots you choose.

## 🚀 Quick start

**With your harness** — give Claude Code or Codex this prompt:

```text
Read https://agents-household.dev/llms.txt and help me set up Household on my machine.
```

**Or do it yourself:**

```sh
curl -fsSL https://agents-household.dev/install.sh | sh
house onboard   # a key, a workspace, its Telegram channel, an assistant bot — step by step
house start
```

`house dashboard` signs you in to the web admin, `house update` moves to the newest release, `house --help` lists everything else.

### Requirements

| Runs on | |
|---|---|
| 🍎 Your Mac | Apple silicon |
| 🐧 Your Linux machine | with `/dev/kvm` |
| ☁️ A VM or a VPS | Linux with KVM inside: nested virtualization or a KVM-enabled VPS |

Plus `openssl` and `python3`. The installer brings the rest: microsandbox, Codex, the web UI. No Docker.

## 🧩 What's inside

| | |
|---|---|
| **Workspace** | Groups bots, channels, network rules and secrets. |
| **Bot** | Your persistent assistant, on a **harness** — Claude Code or Codex. |
| **Scouts** | Specialists a bot calls for one task — "buy two bus tickets", "find this movie on a torrent site" — in a fresh VM with only the access you allow. |
| **Sideworkers** | Extra hands a bot starts for one job, while it keeps talking to you. |
| **Inboxes** | Sources that hand new events to your bots. |
| **Previews** | Open a web app running in a bot's VM by a link, with your approval. |

| Harnesses | Messengers |
|---|---|
| ✅ Claude Code | ✅ Telegram — bot, threaded mode |
| ✅ Codex | 🕒 More coming soon |
| 🕒 More coming soon | |

## 📚 Documentation

Everything else — bots, scouts, sideworkers, inboxes, previews, backup — is in the **[docs](https://agents-household.dev/docs/)**.

<div align="center">
<sub>Made for people who'd rather sleep through the 3 am incident.</sub>
</div>
