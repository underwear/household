import source from "./guest-docker-proxy.py" with { type: "text" };

/** An address owned by the guest, routable from Docker/BuildKit without container DNS. */
export const GUEST_DOCKER_PROXY_URL = "http://169.254.254.1:3128";

/**
 * Shell functions of the guest services (guest root, `note` theirs). `proxy_setup` installs the proxy and points the
 * Docker clients at it; `proxy_serve` runs it with the authenticated upstream (`$upstream`) in its own environment
 * only, never in argv or in a client configuration.
 */
export const GUEST_DOCKER_PROXY_FUNCTIONS = `
proxy_setup() {
  install -d -m 755 /etc/household || return 1
  cat > /etc/household/docker-proxy.py <<'HOUSEHOLD_GUEST_PROXY_SOURCE'
${source}
HOUSEHOLD_GUEST_PROXY_SOURCE
  chmod 644 /etc/household/docker-proxy.py || return 1
  ip address show dev lo | grep -q '169.254.254.1/32' || ip address add 169.254.254.1/32 dev lo || return 1
  python3 /etc/household/docker-proxy.py configure /root/.docker/config.json || note "root Docker client proxy configuration needs repair"
  # The agent's own home: a sideworker's is /home/worker (its parent's /home/agent is shared, and left to the parent).
  user_home=/home/agent
  [ -d /home/worker ] && user_home=/home/worker
  if python3 /etc/household/docker-proxy.py configure "$user_home/.docker/config.json"; then
    chown 1000:1000 "$user_home/.docker" "$user_home/.docker/config.json"
  else
    note "agent Docker client proxy configuration needs repair"
  fi
}
proxy_serve() {
  HOUSEHOLD_UPSTREAM_PROXY="$upstream" exec python3 /etc/household/docker-proxy.py serve
}
`;
