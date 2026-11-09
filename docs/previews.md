# HTTP previews

A pet can show you a web app running in its VM — a site it is building, a dev server with live reload, a dashboard — by a link you open in your browser. Each link needs your approval and lives 15 minutes.

## How it goes

1. **The pet starts the app** in its VM and asks to show it: the port, a title and why.
2. **You approve.** A card in the chat says who wants to show what, the port, where the link will be and that it has no login. Choose **Open for 15 minutes** or **Cancel**.
3. **The pet sends you the link.** Open it in your browser. Pages, assets and WebSockets (live reload) work.
4. **It closes** when the pet is done, when you press **Close**, or after 15 minutes. The app keeps running in the VM; only the link stops. Showing it again needs a new approval.

Open previews show on the pet's **Overview** and on **House → Previews**, with **Close** for each.

## Who can open the link

Set in **House → Settings → HTTP previews**:

- **This computer only** (default) — links on `127.0.0.1`: they open only on the machine Household runs on.
- **Another address** — listen on an address of this machine and give the host people will open, like `mac-mini.local`. Who can reach it depends on your network and firewall: Household opens no ports or tunnels.

⚠️ **There is no login.** Anyone who can reach the link sees the app for those 15 minutes. Approve only what you would show on a shared screen.

## Limits

- One port of the pet's own VM per preview; HTTP and WebSocket only, not other TCP.
- 15 minutes at most. Asking again for the same port returns the same link, without extending it.
- Restarting the pet or Household, or turning previews off, closes its links. Changing who can open them closes the open ones too.
- Sideworkers can show previews of their own VM the same way.
