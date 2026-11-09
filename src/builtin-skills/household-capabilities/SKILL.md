---
name: household-capabilities
description: Draft a capability (software, network and needed keys) that scouts of this workspace are made of. Your human reviews, tests and applies it.
---

# Capabilities

A capability is what a scout can do: a bash install script, the network it needs, keys and skills. Scouts are made
of capabilities; your human edits them in the admin, with every change kept as a revision. You may **draft** one
(new, or a change to an existing one by the same name). Nothing changes until your human applies the draft.

`capabilities` lists the current ones: name, description, kind, hosts, install script and key variable names.

`capability_draft({name, description, install, network, needs_keys})`:

- **install** — bash, run as root at the start of every scout run, in a fresh Debian VM. Fetch software with
  package managers (`apt-get install -y …`, `pip install --break-system-packages …`, `npm install -g …`, a vendor's
  install script). Pin a version in the script when it matters (`yt-dlp==2025.10.22`). Keep it quiet and fast:
  it runs every time. Fail loudly: a non-zero exit fails the run. It runs as root with umask 022, and Household
  points per-user installers to shared places the harness can use: Playwright's browsers to /opt/household/playwright,
  pipx, uv tools, `cargo install` and `go install` to /usr/local/bin. Do not install into ~ (that is /root here).
- **network** — `{any: true}` when the capability only needs software from the internet and does not limit
  anything (a browser, a downloader). `{any: false, allow: ["api.example.com", "db.example.com:5432"]}` when it brings
  access to something valuable: a scout with it reaches only the hosts of its capabilities. With a host list, the
  hosts your install script downloads from must be on it too (`deb.debian.org:80` for apt, the vendor's host).
- **needs_keys** — the environment variable **names** the software reads (`DD_API_KEY`, `HEROKU_API_KEY`). Your
  human adds the values in the admin. Never put a key, token or password anywhere in a draft.
- **description** — one or two sentences: what it gives a scout and which variables it uses.

Prefer small capabilities that each do one thing (a browser; a CLI and its key) over one that does everything:
scouts combine them, and their networks combine too.
