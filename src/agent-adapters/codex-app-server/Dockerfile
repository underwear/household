# Pet image for the codex-app-server adapter. The base by digest (the tag only names it): a rebuild starts from these
# bytes until the digest is bumped.
ARG BASE_IMAGE=oven/bun:1.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e
FROM ${BASE_IMAGE}
# Codex and everything it pulls in come at the versions and checksums of codex/bun.lock (bump with `bun add` there).
COPY codex/package.json codex/bun.lock /opt/codex/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client procps curl ripgrep sudo tmux \
 && rm -rf /var/lib/apt/lists/* \
 && bun install --cwd /opt/codex --frozen-lockfile --production \
 && printf '#!/bin/sh\nexec bun /opt/codex/node_modules/@openai/codex/bin/codex.js "$@"\n' > /usr/local/bin/codex \
 && chmod 755 /usr/local/bin/codex \
 && codex --version
RUN usermod -l agent -d /home/agent bun && mkdir -p /home/agent /etc/household && chown 1000:1000 /home/agent
# The pet owns its isolated guest, including system packages. No host Docker socket is mounted.
RUN printf 'agent ALL=(ALL:ALL) NOPASSWD: ALL\nDefaults:agent env_keep += "HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy"\n' > /etc/sudoers.d/household-agent \
 && chmod 440 /etc/sudoers.d/household-agent && visudo -cf /etc/sudoers.d/household-agent \
 && for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
      [ ! -f "$source" ] || sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' "$source"; \
    done
# Docker lives entirely inside this microVM, every package of it pinned, from Docker's Debian repository whose
# signing key must have Docker's published fingerprint.
ARG DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
ARG DOCKER_VERSION=29.9.3
ARG CONTAINERD_VERSION=2.4.2-3
ARG BUILDX_VERSION=0.38.1-1
ARG COMPOSE_VERSION=5.7.0-1
RUN apt-get update && apt-get install -y --no-install-recommends python3 iproute2 gpg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && export GNUPGHOME="$(mktemp -d)" \
 && test "$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = "$DOCKER_KEY_FINGERPRINT" \
 && rm -rf "$GNUPGHOME" \
 && chmod 644 /etc/apt/keyrings/docker.asc \
 && . /etc/os-release \
 && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && suffix="~debian.${VERSION_ID}~${VERSION_CODENAME}" \
 && apt-get install -y --no-install-recommends "docker-ce=5:${DOCKER_VERSION}-1$suffix" "docker-ce-cli=5:${DOCKER_VERSION}-1$suffix" \
      "containerd.io=${CONTAINERD_VERSION}$suffix" "docker-buildx-plugin=${BUILDX_VERSION}$suffix" "docker-compose-plugin=${COMPOSE_VERSION}$suffix" \
 && usermod -aG docker agent \
 && install -d -m 0755 /etc/docker \
 && docker --version && docker compose version \
 && rm -rf /var/lib/apt/lists/*
# Containers' logs rotate (json-file keeps three files of 10 MB each): they share the VM's Docker disk.
COPY --chmod=644 docker-daemon.json /etc/docker/daemon.json
COPY --chmod=644 entrypoint.ts control.ts modes.ts models.ts /etc/household/
USER agent
WORKDIR /home/agent
ENTRYPOINT ["bun", "/etc/household/entrypoint.ts"]
