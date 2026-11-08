# Pet image for the claude-code-tmux adapter: the claude binary of a pinned release, checked against its checksum.
# The base by digest (the tag only names it): a rebuild starts from these bytes until the digest is bumped.
ARG BASE_IMAGE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${BASE_IMAGE} AS builder
# Bumping the version takes its checksums from https://downloads.claude.ai/claude-code-releases/<version>/manifest.json.
ARG CLAUDE_VERSION=2.1.296
ARG CLAUDE_SHA256_ARM64=f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa
ARG CLAUDE_SHA256_X64=24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN case "$(dpkg --print-architecture)" in \
      arm64) platform=linux-arm64 checksum=$CLAUDE_SHA256_ARM64 ;; \
      amd64) platform=linux-x64 checksum=$CLAUDE_SHA256_X64 ;; \
      *) echo "no claude build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /claude "https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION/$platform/claude" \
 && echo "$checksum  /claude" | sha256sum -c - \
 && chmod 755 /claude \
 && /claude --version | grep -q "^$CLAUDE_VERSION "

FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git tmux procps curl jq sudo \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /claude /usr/local/bin/claude
COPY seed/ /opt/household/seed/
COPY --chmod=755 entrypoint.sh /usr/local/bin/household-entrypoint
# Hooks and the MCP server come from root-owned files passed with --settings and --mcp-config: managed settings
# would be replaced by the organisation's remote settings, and the agent user cannot edit these files.
# (mkdir first: COPY --chmod would give a directory it creates the file's mode, 644.)
RUN mkdir -p /etc/household
COPY --chmod=644 claude-settings.json /etc/household/claude-settings.json
COPY --chmod=644 mcp.json /etc/household/mcp.json
COPY --chmod=755 household-hook /usr/local/bin/household-hook
RUN useradd -m -u 1000 agent
# Root is confined to this pet's microVM; package setup may manage the guest freely.
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
# Without DISABLE_AUTOUPDATER claude downloads a newer version into ~/.local despite the pin.
ENV DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 TERM=xterm-256color
USER agent
WORKDIR /home/agent
ENTRYPOINT ["household-entrypoint"]
