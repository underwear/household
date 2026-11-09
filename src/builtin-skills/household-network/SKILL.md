---
name: household-network
description: Reach a host your workspace does not allow yet, use another TCP port, or connect a non-HTTP client (SSH, a database) through the Household proxy. Use when a connection is refused, times out, or a domain is blocked.
---

# Network

Your VM has no direct route out. Every connection goes through the Household proxy, which lets through only the
workspace allowlist. `network_list` shows what your workspace can reach now.

## A host is blocked

1. Check `network_list`: maybe it is allowed under another name or port.
2. `network_request({domain, port?, reason})`: the exact DNS name (no wildcards, IPs or URLs), the TCP port (443
   unless given) and a reason your human can judge: what the host is and what you need it for.
3. Your human chooses: 15 minutes, permanently, or no. The tool waits for the answer. A refusal grants nothing:
   find another way or tell your human what you are blocked on.

Ask during your turn, not from a setup script. Each approval is one domain and one port: `example.com:443` does not
cover `example.com:80` or `api.example.com`.

## Clients

- HTTP and HTTPS: `HTTP_PROXY` and `HTTPS_PROXY` are set; most tools use them by themselves.
- SSH, databases and other TCP: the client needs a helper that opens a tunnel with HTTP CONNECT through the proxy
  in `HTTPS_PROXY`, sending the credentials in that URL. The host and port must be allowed like any other.
- UDP is unavailable, and so is anything that ignores proxies.
- Port 443 does not mean HTTPS, and an HTTPS approval does not cover plain HTTP on port 80.

## Docker

Builds and containers get a credential-free proxy inside the VM. Keep it: never copy `HTTPS_PROXY` (it carries
your VM's credentials) into a Dockerfile, build argument, Compose file or image. Prefer HTTPS package repositories;
a repository on HTTP needs its domain allowed on port 80.
