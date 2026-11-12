# Installing Household

Done when the user writes to their bot in their messenger and it answers. `house doctor` checks most of the way there.

## Checklist

1. **Host**: macOS on Apple silicon, or Linux with `/dev/kvm` usable by the user — the user's machine, a VM with
   nested virtualization, or a VPS that offers KVM. Intel Macs only through such a Linux VM.
2. **Household**: `curl -fsSL https://agents-household.dev/install.sh | sh` installs the newest release into
   `~/.household` (its own microsandbox and Codex inside; no Bun, Docker or sudo) and says what is missing:
   `~/.household/bin` on `PATH`, `python3` and `openssl` on the machine. `house --version` shows the release.
3. **Check the host**: `house doctor` says whether microVMs can run here.

Steps 4–8 are what `house onboard` asks for, one at a time, in a terminal; the user can run it instead of you
doing them (it needs a real terminal, it asks questions).

4. **A key** for the harness the user wants. Ask which account: the bots work as it, and use its plan.
   - **Claude subscription, recommended: Household's own sign-in.** It needs the daemon (`house start`, step 9,
     first). `house key claude claude --link` prints a link; the user opens it on any device, signs in, and gives
     you the code Claude shows; then `house key claude claude --code '<code>'` within 10 minutes. Claude Code
     itself signs in, in a short-lived VM; the Claude on the user's machine is untouched. Household renews it by
     itself; Claude ends it about once a month, and Household says so in the bots' chats a few days before: the
     same two commands then. Bots on it can use the account's claude.ai connectors (step 6).
   - Or a Claude token for a year, without connectors: the user runs `claude setup-token`; the token goes to
     `house key add claude --provider anthropic` (stdin). Or an Anthropic API key, the same way.
   - **ChatGPT subscription**: `house key codex codex` prints a link and a code; the user enters the code there,
     on any device, and the command ends once they have. Or an OpenAI API key with `--provider openai`.
5. **A workspace**: `house workspace create my-workspace`, and `house workspace allow` for the hosts the user's work needs.
6. **A bot**: `house bot add my-workspace assistant --key <key> --title Assistant`
   (`--harness codex-app-server` for Codex). On a sign-in key, the account's connectors are one setting away, if
   the user wants the bot to act as that account in them: `--setting claudeAiConnectors=true` (Claude's
   claude.ai connectors) or `--setting chatgptApps=true` (ChatGPT's apps). A pasted token or an API key has none.
7. **Scouts on**: `house features my-workspace scouts=on`.
8. **A channel** for the workspace. Recommended: a **Telegram group with topics**:
   - the user creates a bot with @BotFather, makes a group with **Topics** on, and adds the bot as an admin
     with Manage topics and Delete messages; the group's id (`-100…`) is after `#` in its Telegram Web address;
   - the user presses Start in a private chat with the bot;
   - `house owner add my-workspace telegram <their numeric user id>` (e.g. from @userinfobot);
   - `house channel add my-workspace --kind telegram-group --chat <group id> --bots assistant` (token on stdin).

   Other kinds, the same way: `telegram-private` (the bot's own threads: Telegram's Threaded Mode, still beta,
   turned on in BotFather's Mini App → Bot Settings → Threads Settings; the chat is the user's id),
   `telegram-dm` (one plain chat; the chat is the user's id) or a Slack DM (see docs/slack.md).
9. **Running for good**: `house start` as a launchd / systemd user service that restarts on failure and whose
   `PATH` finds `openssl` and `python3`. Only one daemon at a time.
10. **Check**: `house doctor` all ✓, `house status` shows the bot `running` (the first start downloads its image).
11. **Web UI**: `house dashboard` prints a one-time sign-in link (60 s) and opens it; the UI is at
    http://127.0.0.1:8780, on that machine only. On a remote one: `ssh -L 8780:127.0.0.1:8780 <host>` (the same
    port on both ends), then `house dashboard --no-open` there and open the link locally.
