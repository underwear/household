---
name: household-secrets
description: Use a token, password or other credential, or ask your human for one. Use before you put a credential in a command, file, config or request.
---

# Secrets

Credentials your human gives the house are kept by Household, not by you. In your VM a secret is a placeholder:
an environment variable (its name chosen in the request, like `GITHUB_TOKEN`) holding `household-secret-<name>`.
When a request to that secret's hosts carries the placeholder in the secret's header, the Household proxy puts the
real value there on the way out. The value is not placed in your VM. Use only the intended service: a malicious service could echo credentials back in its response.

## Use one

- Send the placeholder exactly where a real token would go: `Authorization: Bearer $GITHUB_TOKEN`, or as the
  password in `https://user:$GITHUB_TOKEN@github.com/...` (git's Basic credentials work).
- It works only on the secret's own hosts, in its header. Anywhere else the placeholder goes out as the text it is.
- A secret does not open the network: if its host is not allowed, ask with `network_request` too.
- Do not try to read, print or test the value: you will only ever see the placeholder.

## Ask for one

For external HTTPS services that authenticate via an HTTP header, offer a managed secret first.
Call `secret_request({name, env, domains, reason})`, for example:

```json
{"name":"github-atlas-read","env":"ATLAS_GITHUB_TOKEN","domains":["api.github.com"],"reason":"Read Atlas issues with a read-only repository token"}
```

Choose a unique secret name and a unique env name for the house. Multiple tokens may use the same domains;
select the appropriate placeholder for each task. Collisions are refused, never silently overwritten.
Household creates a request and tells the owner to send `/secret <value>`, then confirm the
name, env, domains and masked value. There is only one active request per house (including confirmation),
with a shared 10-minute deadline. The owner can cancel it. The tool returns promptly; wait for Household's
internal notification. Do not ask the owner to compose domain lists.
Without an active request the owner can still use `/secret <name> <value> <domain>[,<domain>…]` manually.
Never ask your owner to paste a token as a normal message, and never put a real value in a tool argument.

When approved, use the supplied `household-secret-<name>` directly in the Authorization header. It works
immediately without a VM restart; the environment variable is populated at the next VM start. Until then you may export the supplied placeholder under the requested env name in your shell. Secrets are
shared by the house, including sideworkers. Network access is separate: request `network_request` if needed.
An existing name cannot be overwritten from chat; ask your owner to rotate it in the admin. For a custom header,
use the admin secret editor. Open-network houses cannot request secrets.

Telegram command entry is not end-to-end encrypted. Household deletes the command before processing it and
keeps its value out of pet sessions, journals and logs, but it has already passed through Telegram's servers.

## When the proxy cannot help

The proxy can only fill in HTTP headers. A database password, an SSH key, a request signature (AWS SigV4) or
anything the program reads from a file or puts in a request body has to be the real value in your VM.

Before you ask for such a credential, tell your human plainly:
- you would hold the real value, in your files or environment;
- if you are ever compromised (a malicious page, file or message that takes you over), it could be sent anywhere
  your network reaches;
- what a narrower option would be: a read-only user, a short-lived token, a key for this one machine.

Let them decide. If they agree, keep the value out of chat replies, logs, memory, commits, skills and setup
scripts: put it in one file in your home with `chmod 600`, or wherever the tool expects it, and say where. Your
home is in Household's exports and your sideworkers see it: say so too.
