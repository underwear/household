# Previews

A bot can show you a web app running in its VM, such as a site it is building, a dev server with live reload, or a dashboard, through a link you open in your browser. You approve each link, and it lives for 15 minutes.

## Turn them on

Previews are off in a new workspace. Open **Workspace → Settings**, switch on **HTTP previews** under **Features**, and **Save**. Or from the command line:

```sh
house features home preview=on
```

Turning them off closes any open links.

## How a preview goes

1. **The bot starts the app** in its VM and asks to show it to you: which port, a title, and why.
2. **You approve.** A card in the chat says which bot wants to show what, the port, where the link will be, and that it has no login. Choose **Open for 15 minutes** or **Cancel**.
3. **You get the link.** The card changes to show it, and the bot is told. Open it in your browser. Pages, images, scripts and live reload all work.
4. **It closes** when the bot is done, when you press **Close**, or after 15 minutes. The app keeps running in the VM; only the link stops. Showing it again needs a new approval.

Open previews are listed on the bot's **Overview** and on **Workspace → Previews**, each with **Close**.

Sideworkers can show previews from their own VM the same way.

## Who can open the link

Set this on **Workspace → Previews** under **Who can open the links**:

- **This computer only** (the default) — links on `127.0.0.1`. They open only on the machine Household runs on.
- **Another address** — Household listens on an address of this machine (**Listen on**, for example `0.0.0.0`) and puts the host people will open in the links (**Links use**, for example `mac-mini.local`). Who can actually reach it depends on your network and firewall: Household opens no ports or tunnels for you.

Changing this closes the links that are open now.

⚠️ **Links have no login.** Anyone who can reach a link sees the app for those 15 minutes. Approve only what you would show on a shared screen, and keep **This computer only** unless you need more.

## Limits

- One port of the bot's own VM per preview. Web pages and WebSockets work; other kinds of connections do not.
- 15 minutes at most. If the bot asks again for a port that is already open, it gets the same link with the same time left.
- Restarting the bot or Household closes its links.
