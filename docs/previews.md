# Previews

A bot can show you a web app running in its VM, such as a site it is building, through a link you open in your browser. You approve each link.

## How it works

- **Off until you turn it on,** under **Workspace → Settings → Features → HTTP previews**.
- **The bot asks** to show one port of its VM, with a reason. You answer on a card in the chat: **Open for 15 minutes** or **Cancel**.
- **You get a link.** Pages, live reload and WebSockets work; other connections do not.
- **It closes** when the bot is done, when you close it, when the bot or Household restarts, or after 15 minutes at most. The app keeps running; showing it again needs a new approval.
- **[Sideworkers](../sideworkers/)** can show previews the same way.

## Who can open the link

Set it on **Workspace → Previews**:

- **This computer only** (the default): links on `127.0.0.1` that open only on this machine.
- **Another address:** Household listens on an address of this machine (say `0.0.0.0`) and writes links with the host people will open (say `mac-mini.local`). Who can reach it is up to your network and firewall: Household opens no ports or tunnels.

Keep the default unless you need another device, such as your phone at home.

⚠️ **Links have no login.** Anyone who can reach a link sees the app while it is open. Approve only what you would show on a shared screen.
