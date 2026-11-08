import { GUEST_DOCKER_PROXY_FUNCTIONS, GUEST_DOCKER_PROXY_URL } from "./guest-docker-network";

/** dockerd's output and the supervisor's notes, appended across starts; past 10 MiB it becomes `.1`. */
export const GUEST_SERVICES_LOG = "/var/log/household-docker.log";

// Provisioned through guest stdin so all agent images share one startup implementation.
export const GUEST_SERVICES_INSTALL = `set -e
if ! command -v dockerd >/dev/null 2>&1; then printf 'skipped\\n'; exit 0; fi
sudo -n sh -c 'umask 022; mkdir -p /etc/household; rm -f /run/household-guest-services.ready; cat > /etc/household/guest-services.sh; chmod 700 /etc/household/guest-services.sh'
printf 'installed\\n'`;

/**
 * The supervisor's shell functions, apart from what they supervise so tests run them with fake services. They read
 * `services_log`, `services_run` (its PID files), `proc` (/proc), `log_max_bytes`, and `backoff_first` and
 * `backoff_max` (seconds).
 */
export const GUEST_SUPERVISION = `
note() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$services_log"; }
# Copy, then truncate: writers keep the file open for appending, so they go on at its new end.
rotate_log() {
  [ -f "$1" ] && [ "$(wc -c < "$1")" -gt "$log_max_bytes" ] || return 0
  cp "$1" "$1.1" && : > "$1"
}
# The PID in file $1 when a live process holds it with $2 in its command line. A VM restart keeps rootfs PID files
# (another process may hold the PID by now), and a crash mid-write leaves one unparsable: neither counts.
live_pid() {
  pid=$(cat "$1" 2>/dev/null) || return 1
  case "$pid" in ''|*[!0-9]*) return 1;; esac
  case "$(tr '\\0' ' ' < "$proc/$pid/cmdline" 2>/dev/null)" in *"$2"*) printf '%s\\n' "$pid";; *) return 1;; esac
}
# Runs service $1 (its command line has $2) as the rest of the arguments, again whenever it exits: after
# backoff_first seconds, doubling up to backoff_max while it keeps failing; one that ran a minute starts over.
supervise() {
  name=$1 match=$2
  shift 2
  pidfile="$services_run/$name.pid" delay=$backoff_first
  while :; do
    # One left running when its supervisor died: wait it out rather than start a second.
    if pid=$(live_pid "$pidfile" "$match"); then
      note "$name: waiting for PID $pid, left by an earlier supervisor"
      while live_pid "$pidfile" "$match" >/dev/null; do sleep 5; done
    fi
    started=$(date +%s)
    "$@" 9>&- &
    pid=$!
    printf '%s\\n' "$pid" > "$pidfile"
    wait "$pid"
    status=$?
    rm -f "$pidfile"
    [ $(($(date +%s) - started)) -lt 60 ] || delay=$backoff_first
    note "$name exited with status $status; restarting in \${delay}s"
    sleep "$delay"
    delay=$((delay * 2 < backoff_max ? delay * 2 : backoff_max))
  done
}
`;

/** dockerd's start, apart so tests run it with a fake dockerd. It reads `docker_run` (/var/run) and `docker_proxy`. */
export const GUEST_DOCKERD_FUNCTIONS = `
dockerd_serve() {
  # dockerd refuses a PID file it cannot parse or whose PID is alive; its managed containerd leaves its own.
  live_pid "$docker_run/docker.pid" dockerd >/dev/null || rm -f "$docker_run/docker.pid"
  containerd_state=$docker_run/docker/containerd
  live_pid "$containerd_state/containerd.pid" containerd >/dev/null \\
    || rm -f "$containerd_state/containerd.pid" "$containerd_state/containerd.sock" "$containerd_state/containerd.sock.ttrpc"
  if [ -n "$docker_proxy" ]; then
    export HTTP_PROXY="$docker_proxy" HTTPS_PROXY="$docker_proxy" http_proxy="$docker_proxy" https_proxy="$docker_proxy"
    export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
  fi
  # msb may omit supplementary groups: use agent's primary group for its private socket.
  exec dockerd --host unix:///var/run/docker.sock --pidfile "$docker_run/docker.pid" --group "$(id -gn agent)"
}
`;

/**
 * Kept alive as a managed msb job, as root: it supervises dockerd and the guest proxy, restarting either when it dies
 * (an OOM kill, say). No systemd, host socket, or TCP Docker API is needed.
 */
export const GUEST_SERVICES_SCRIPT = `
services_log=${GUEST_SERVICES_LOG} services_run=/run/household-services docker_run=/var/run proc=/proc
log_max_bytes=10485760 backoff_first=1 backoff_max=60
${GUEST_SUPERVISION}
${GUEST_DOCKER_PROXY_FUNCTIONS}
${GUEST_DOCKERD_FUNCTIONS}
# One supervisor per VM: a relaunched agent's start finds this one in charge. Services never hold the lock, so one
# outliving its supervisor does not keep the next supervisor out.
mkdir -p "$services_run"
exec 9> "$services_run/lock"
if ! flock -n 9; then touch /run/household-guest-services.ready; exit 0; fi
rotate_log "$services_log"
note "guest services starting"
# Only the guest proxy gets the VM's authenticated upstream; dockerd gets the guest proxy, or none at all.
upstream=\${HTTPS_PROXY:-} docker_proxy=
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy
if [ -z "$upstream" ]; then
  note "no HTTPS_PROXY in the VM's environment: no guest proxy, so Docker cannot pull or build"
elif proxy_setup >> "$services_log" 2>&1; then
  docker_proxy=${GUEST_DOCKER_PROXY_URL}
  supervise docker-proxy 'docker-proxy.py serve' proxy_serve >> "$services_log" 2>&1 &
else
  note "guest proxy setup failed, so Docker cannot pull or build"
fi
supervise dockerd 'dockerd --host' dockerd_serve >> "$services_log" 2>&1 &
touch /run/household-guest-services.ready
while :; do sleep 60; rotate_log "$services_log"; done
`;

/** Readiness runs as the ordinary image user and verifies socket access without sudo. */
export const GUEST_SERVICES_READY = `set -e
for attempt in $(seq 1 120); do
  if [ -f /run/household-guest-services.ready ] && docker --host unix:///var/run/docker.sock info >/dev/null 2>&1; then exit 0; fi
  sleep .5
done
exit 1`;
