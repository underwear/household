# Previews

A bot can show you a web app running in its VM, such as a site it is building, a dev server with live reload, or a dashboard, through a link you open in your browser. You approve each link, and it lives for 15 minutes.

## When it helps

- Look at a site or a UI change before you accept the bot's work, without cloning or building anything yourself.
- See a chart or report a bot rendered as a small web page.

## How it works

- **Off until you turn it on,** under **Workspace → Settings → Features → HTTP previews**. Turning it off closes open links.
- **The bot asks.** It starts the app in its VM and asks to show one port, with a title and a reason. You get a card in the chat: **Open for 15 minutes** or **Cancel**. Unanswered, it lapses after five minutes.
- **You get a link.** Pages, scripts and live reload work.
- **It closes** when the bot is done, when you close it, or after 15 minutes. The app keeps running in the VM; only the link stops, and showing it again needs a new approval.
- **Sideworkers** can show previews from their own VMs the same way.

Open links are listed on the bot's **Overview** and on **Workspace → Previews**.

## Who can open the link

Set it on **Workspace → Previews**:

- **This computer only** (the default): links on `127.0.0.1`, which open only on the machine Household runs on.
- **Another address:** Household listens on an address of this machine (say `0.0.0.0`) and writes links with the host people will open (say `mac-mini.local`). Who can reach it is up to your network and firewall: Household opens no ports or tunnels.

Keep the default unless you need to look from another device, such as your phone on your home network. Changing it closes the links open now.

⚠️ **Links have no login.** Anyone who can reach a link sees the app for those 15 minutes. Approve only what you would show on a shared screen.

## Limits

- One port of the bot's own VM per preview. Web pages and WebSockets work; other connections do not.
- 15 minutes at most. Asking again for an open port returns the same link with the same time left.
- Restarting the bot or Household closes its links.

## Put it to use

A coding partner: share `~/Projects/site` read-write as a [shared folder](../volumes/), let the bot hand a redesign to a [sideworker](../sideworkers/), and have it show the result as a preview before you merge.

From the terminal: `house features <workspace> preview=on`.

## Related

- [Shared folders](../volumes/): the project the bot works on
- [Sideworkers](../sideworkers/): helpers that can show previews too
