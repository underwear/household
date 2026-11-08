/**
 * Where software installed as root inside a VM goes, so the agent (its own user) can run it. Install scripts run
 * through sudo, and sudo sets HOME to /root: anything a tool installs "for the user" (Playwright's browsers, pipx,
 * uv tools, cargo, go) would land in /root, which the agent cannot read. These variables send programs to
 * /usr/local/bin (on every PATH) and their data to /opt/household, readable by all. A VM has one tenant and the
 * agent has sudo, so a shared directory gives nothing away.
 *
 * Not set on purpose: XDG_* (root's own config and caches would land in a shared place, and the agent's caches would
 * become unwritable), an npm prefix (Debian's npm already installs globals under /usr/local), HOME, and pip's
 * (`--break-system-packages` as root already installs under /usr/local).
 */
export const INSTALL_ENV: Readonly<Record<string, string>> = {
  // apt asks nothing: a prompt would hang the setup until its time runs out.
  DEBIAN_FRONTEND: "noninteractive",
  PLAYWRIGHT_BROWSERS_PATH: "/opt/household/playwright",
  PIPX_HOME: "/opt/household/pipx",
  PIPX_BIN_DIR: "/usr/local/bin",
  UV_TOOL_DIR: "/opt/household/uv/tools",
  UV_TOOL_BIN_DIR: "/usr/local/bin",
  UV_PYTHON_INSTALL_DIR: "/opt/household/uv/python",
  CARGO_HOME: "/opt/household/cargo",
  RUSTUP_HOME: "/opt/household/rustup",
  CARGO_INSTALL_ROOT: "/usr/local",
  GOPATH: "/opt/household/go",
  GOBIN: "/usr/local/bin",
};

/**
 * What the agent itself needs to find what was installed: Playwright looks for its browsers, rustup for its
 * toolchains. Only these: the agent's own `cargo build`, `go build` or `pipx` must keep writing to its home, so
 * CARGO_HOME, GOPATH and PIPX_HOME stay the installers' alone.
 */
export const AGENT_TOOL_ENV: Readonly<Record<string, string>> = {
  PLAYWRIGHT_BROWSERS_PATH: INSTALL_ENV.PLAYWRIGHT_BROWSERS_PATH!,
  RUSTUP_HOME: INSTALL_ENV.RUSTUP_HOME!,
};

/** `export NAME='value'` lines for a shell script. */
export const installExports = () => Object.entries(INSTALL_ENV).map(([name, value]) => `export ${name}='${value}'`).join("\n");

/**
 * Where sudo reads these variables from, for every command the agent runs through it (`sudo pip install`, `sudo npx
 * playwright install`, in a pet's saved setup or later), and the sudoers rule that points it there. Only through sudo:
 * the agent's own commands (`cargo build`, `go install`) keep their homes. sudo adds a variable the command's
 * environment has not already got.
 */
export const INSTALL_ENV_FILE = "/etc/household/install-env";
export const INSTALL_ENV_FILE_TEXT = Object.entries(INSTALL_ENV).map(([name, value]) => `${name}=${value}`).join("\n") + "\n";
export const INSTALL_ENV_SUDOERS = `Defaults:agent env_file=${INSTALL_ENV_FILE}`;
