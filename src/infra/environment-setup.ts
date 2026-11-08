import { INSTALL_ENV_FILE, INSTALL_ENV_FILE_TEXT, INSTALL_ENV_SUDOERS } from "../core/install-env";

/** Runs only in the guest. Never copy setup source or output into host diagnostics. */
/** A scout installs its capabilities' software on every run (a browser takes minutes): the limit allows for that. */
export const ENVIRONMENT_SETUP_SECONDS = 900;
export const ENVIRONMENT_SETUP_HOST_TIMEOUT_MS = 920_000;

export interface EnvironmentSetupResult {
  status: "complete" | "failed" | "skipped";
  /** False when boot reused a VM-local result without executing. */
  attempted?: boolean;
  logPath: string;
  statusPath: string;
}

/** Fixed root-owned guest source, outside the persistent host-mounted home. */
export const ENVIRONMENT_SETUP_PATH = "/etc/household/environment-setup.sh";

/** Receives the saved script on stdin; never interpolates it into a command or touches host files. */
function installScript(path: string): string { return `set -eu
umask 077
[ ! -L /etc/household ] && { [ ! -e /etc/household ] || [ -d /etc/household ]; } || exit 1
mkdir -p /etc/household
[ ! -L "${path}" ] && { [ ! -e "${path}" ] || [ -f "${path}" ]; } || exit 1
file=$(mktemp /etc/household/.environment-setup.XXXXXX)
trap 'rm -f "$file"' EXIT
cat > "$file"
chown root:root "$file"
chmod 644 "$file"
mv -fT "$file" "${path}"
`; }

export const ENVIRONMENT_SETUP_INSTALL = installScript(ENVIRONMENT_SETUP_PATH);

/**
 * Root's part before a setup runs (core/install-env.ts): /opt/household for what installers put there, the install
 * variables for commands run through sudo, and the sudoers rule that reads them (checked before it replaces the last
 * one). Every boot: the root filesystem is the image's again after a VM is recreated.
 */
const PREPARE_INSTALLS = `umask 022
mkdir -p /opt/household /etc/household
printf '%s' '${INSTALL_ENV_FILE_TEXT}' > ${INSTALL_ENV_FILE}
rule=/etc/sudoers.d/household-install-env
printf '%s\\n' '${INSTALL_ENV_SUDOERS}' > "$rule.next"
chmod 440 "$rule.next"
visudo -cf "$rule.next" >/dev/null && mv -f "$rule.next" "$rule"
`;

/** Debian images provide bash and coreutils. Output is drained after the first 64 KiB. */
function executionScript(phase: "setup" | "onStart"): string {
  const file = phase === "setup" ? "setup" : "on-start";
  const path = `/etc/household/environment-${file}.sh`;
  return `(
set -eu
umask 077
directory="$HOME/environment"
[ ! -L "$directory" ] && { [ ! -e "$directory" ] || [ -d "$directory" ]; } || exit 1
mkdir -p "$directory"
status="$directory/${file}.status"
log="$directory/${file}.log"
setup="${path}"
for file in "$status" "$log"; do
  [ ! -L "$file" ] && { [ ! -e "$file" ] || [ -f "$file" ]; } || exit 1
done
printf 'running\\n' > "$status"
chmod 600 "$status"
: > "$log"
chmod 600 "$log"
# Only this fixed guest installer runs as root. The saved source arrives on stdin, never in argv.
sudo -n sh -c '${installScript(path).replaceAll("'", "'\\''")}' >/dev/null 2>&1 || {
  printf 'failed (cannot install configured setup)\\n' > "$status"
  exit 1
}
# Even with no saved setup: what root installs, now or later (sudo npx playwright install), goes where the agent can run it; a failure here leaves the old ways, not a failed setup.
sudo -n sh -c '${PREPARE_INSTALLS.replaceAll("'", "'\\''")}' >/dev/null 2>&1 || true
if [ ! -s "$setup" ]; then
  printf 'skipped (no configured setup)\\n' > "$status"
  exit 10
fi
if [ -L "$setup" ] || [ ! -f "$setup" ] || [ ! -r "$setup" ]; then
  printf 'failed (configured setup must be a readable regular file)\\n' > "$status"
  exit 1
fi
result=$(mktemp)
trap 'rm -f "$result"' EXIT
# Keep the script's exit status across the logging pipe. Do not source it: its env changes must not
# alter the managed agent launch, and an exit in the script must not bypass failure reporting.
(
  set +e
  cd "$HOME"
  # The owner's script runs with the usual umask, not this wrapper's private one: what it installs (with sudo too)
  # must stay readable by the agent's own user.
  umask 022
  timeout --kill-after=10s ${ENVIRONMENT_SETUP_SECONDS}s bash "$setup"
  printf '%s\\n' "$?" > "$result"
) 2>&1 | tail -c 65536 > "$log"
code=$(cat "$result")
case "$code" in
  0) printf 'complete\\n' > "$status" ;;
  124|137) printf 'failed (timeout after ${ENVIRONMENT_SETUP_SECONDS}s)\\n' > "$status"; exit 1 ;;
  *) printf 'failed (exit %s)\\n' "$code" > "$status"; exit 1 ;;
esac
) >/dev/null 2>&1
code=$?
# Return only a controlled result. Script failures (including unsafe diagnostic paths) must not
# prevent the agent from starting to repair its home. A failed msb call still means transport failure.
case "$code" in
  0) printf 'complete\\n' ;;
  10) printf 'skipped\\n' ;;
  *) printf 'failed\\n' ;;
esac
`;
}

export const ENVIRONMENT_SETUP_SCRIPT = executionScript("setup");

/** VM-local state: never put the once marker in the persistent home. An interrupted run is failed. */
export function environmentScript(phase: "setup" | "onStart", automatic = false): string {
  const source = executionScript(phase);
  const state = `/etc/household/environment-${phase === "setup" ? "setup" : "on-start"}.state`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const guard = `set -eu
[ ! -L /etc/household ] && { [ ! -e /etc/household ] || [ -d /etc/household ]; } || exit 1
mkdir -p /etc/household
[ ! -L ${state} ] && { [ ! -e ${state} ] || [ -f ${state} ]; } || exit 1
save_state() {
  file=$(mktemp /etc/household/.environment-state.XXXXXX)
  trap 'rm -f "$file"' EXIT
  chmod 600 "$file"
  printf '%s\\n' "$1" > "$file"
  mv -fT "$file" ${state}
}
`;
  // Existing installations already attempted setup under the old every-boot policy. Adopt their
  // bounded status rather than unexpectedly repeating installations during the first upgraded boot.
  const probe = `${guard}
${automatic && phase === "setup" ? `if [ -f ${state} ]; then
  previous=$(head -c 32 ${state})
  case "$previous" in complete|failed|skipped) ;; *) previous=failed; save_state failed;; esac
  printf '%s\\n' "$previous"
  exit
fi
if [ -f ${ENVIRONMENT_SETUP_PATH} ]; then
  case "$(head -c 64 "$1/environment/setup.status" 2>/dev/null)" in
    complete*) previous=complete;; skipped*) previous=skipped;; *) previous=failed;;
  esac
  save_state "$previous"
  printf '%s\\n' "$previous"
  exit
fi` : ""}
save_state failed
printf 'run\\n'
`;
  return `decision=$(sudo -n sh -c ${quote(probe)} sh "$HOME") || exit 1
case "$decision" in
  complete|failed|skipped) printf 'existing:%s\\n' "$decision"; exit 0;;
  run) ;;
  *) exit 1;;
esac
outcome=$(sh -c ${quote(source)}) || exit 1
case "$outcome" in complete|failed|skipped) ;; *) exit 1;; esac
sudo -n sh -c ${quote(`${guard}save_state "$1"`)} sh "$outcome" || exit 1
printf '%s\\n' "$outcome"
`;
}
