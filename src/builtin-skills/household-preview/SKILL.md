---
name: household-preview
description: Temporarily share an HTTP app or dev server from your own VM with your human, including WebSocket live reload.
---

# HTTP previews

Check the workspace feature status in your instructions. This skill remains available when previews are disabled; ask your human to enable HTTP previews in workspace settings. Never work around a disabled feature with tunnels or host listeners.

1. Start the application inside your VM. Verify it locally on its port. Docker containers must publish their port into the VM (`docker run -p 3000:3000 …`); the app inside the container generally binds to `0.0.0.0`.
2. Before publishing, check that the app exposes no secrets, private files, debugger, or unprotected administrative operations. Preview visitors have **no authentication**. A public port can be discovered quickly by scanning; a random port is not protection.
3. Call `preview_open({port:3000,title:"Website draft",reason:"Review the new landing page"})`. Describe exactly what will be exposed. Only your own VM's port is accepted. HTTP and WebSocket are supported, not arbitrary TCP.
4. The tool returns `pending` immediately. Household asks the owner and sends an internal result with URL and `expires_at`, or the reason it was not opened. Do other work while waiting; do not repeatedly request the same port.
5. Send the resulting URL to your human. Availability depends on the owner's bind/link addresses: default localhost works only on the Household computer. LAN/public availability depends on routing and firewall; do not promise internet access without checking it. No automatic tunnels, router or firewall changes are made.
6. Call `preview_list()` to inspect your pending/active previews, and `preview_close({id})` when finished.

Every publication needs owner approval and lasts at most 15 minutes from opening. Repeated requests return the same URL and deadline without extending it. A new publication after closure needs new approval. Closing or expiry cuts off HTTP streams and WebSockets; your app/container keeps running. Stopping/replacing your VM or restarting Household closes its previews. Sideworkers use these same tools for their own VM only.

For dev-server host checks, allow only the hostname Household returns. Configure HMR to use the preview page's host and port; do not hardcode your VM's internal address in browser URLs.
