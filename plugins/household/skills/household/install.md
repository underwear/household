# Installing Household

Done when the user writes to their Telegram bot and a pet answers. `house doctor` checks most of the way there.

## Checklist

1. **Host**: macOS on Apple silicon, or Linux with `/dev/kvm` usable by the user — the user's machine, a VM with
   nested virtualization, or a VPS that offers KVM. Intel Macs only through such a Linux VM.
2. **Household**: `curl -fsSL https://agents-household.dev/install.sh | sh` installs the newest release into
   `~/.household` (its own microsandbox and Codex inside; no Bun, Docker or sudo) and says what is missing:
   `~/.household/bin` on `PATH`, `python3` and `openssl` on the machine. `house --version` shows the release.
3. **Check the host**: `house doctor` says whether microVMs can run here.

Steps 4–8 are what `house onboard` asks for, one at a time, in a terminal; the user can run it instead of you
doing them (it needs a real terminal, it asks questions).

4. **A key** for the agent the user wants:
   - Claude subscription: the user runs `claude setup-token`; the token goes to
     `house key add claude --provider anthropic` (stdin). Or an Anthropic API key, the same way.
   - ChatGPT subscription: `house key codex codex --local` copies the login of the Codex on this machine;
     `house key codex codex` signs in with a code instead. Or an OpenAI API key with `--provider openai`.
5. **A house**: `house create my-house`, and `house allow` for the hosts the user's work needs.
6. **A pet**: `house pet add my-house assistant --key <key> --title Assistant`
   (`--agent codex-app-server` for Codex).
7. **Scouts on**: `house features my-house scouts=on`.
8. **A Telegram bot** for the house:
   - the user creates it with @BotFather and turns on **Threaded Mode** in BotFather's Mini App (Bot Settings →
     Threads Settings), with users not allowed to create threads; Household refuses a bot without threads;
   - the user presses Start in a private chat with the bot;
   - `house owner add my-house telegram <their numeric user id>` (e.g. from @userinfobot);
   - `house channel add my-house --kind telegram-private --chat <user id> --pets assistant` (token on stdin).
9. **Running for good**: `house start` as a launchd / systemd user service that restarts on failure and whose
   `PATH` finds `openssl` and `python3`. Only one daemon at a time.
10. **Check**: `house doctor` all ✓, `house status` shows the pet `running` (the first start downloads its image).
11. **Web UI**: `house dashboard` prints a one-time sign-in link (60 s) and opens it; the UI is at
    http://127.0.0.1:8780, on that machine only. On a remote one: `ssh -L 8780:127.0.0.1:8780 <host>` (the same
    port on both ends), then `house dashboard --no-open` there and open the link locally.
