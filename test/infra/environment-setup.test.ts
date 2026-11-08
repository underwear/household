import { expect, test } from "bun:test";
import { MicrosandboxRuntime, type MicrosandboxRun } from "../../src/infra/microsandbox-runtime";
import { ENVIRONMENT_SETUP_HOST_TIMEOUT_MS, environmentScript } from "../../src/infra/environment-setup";
import { tempDir } from "../helpers";

// Do not execute saved shell source on the host. Guest execution is covered by the isolated VM smoke.
function fixture(status = "complete", ok = true) {
  const calls: { command: string[]; options: Parameters<MicrosandboxRun>[1] }[] = [];
  const run: MicrosandboxRun = async (command, options) => {
    calls.push({ command, options });
    return command.includes("--version")
      ? { ok: true, stdout: "msb 0.7.13\n", stderr: "" }
      : { ok, stdout: status, stderr: "private guest output" };
  };
  const builder = { buildImage: async () => "image", exportImage: async () => {}, cancel() {} };
  const runtime = new MicrosandboxRuntime({ builder, homesDir: tempDir(), proxyPort: 3128, relayPort: 8080, run });
  return { runtime, calls };
}

test("saved setup is sent literally over guest stdin, never interpolated into host commands", async () => {
  const env = fixture();
  const source = "echo '$HOME `private-source` $(private-command)'\nexit 0\n";
  await env.runtime.runEnvironmentSetup("pet", source);
  const invocation = env.calls.find(({ command }) => command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true)))!;
  expect(invocation.command).toEqual(["msb", "exec", "--stream", "--no-tty", "--timeout", "915s", "pet", "--", "sh", "-c", environmentScript("setup")]);
  expect(invocation.options.stdin).toBe(source);
  expect(invocation.options.timeoutMs).toBe(ENVIRONMENT_SETUP_HOST_TIMEOUT_MS);
  expect(env.calls.every(({ command }) => !command.join(" ").includes(source))).toBe(true);
});

test("saving replaces the next startup source without executing; explicit clear cannot run stale source", async () => {
  const env = fixture("skipped");
  env.runtime.configureEnvironmentSetup("pet", "first source");
  env.runtime.configureEnvironmentSetup("pet", "current saved source");
  expect(env.calls).toHaveLength(0);
  await env.runtime.runEnvironmentSetup("pet");
  await env.runtime.runEnvironmentSetup("pet", undefined);
  const invocations = env.calls.filter(({ command }) => command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true)));
  expect(invocations.map(({ options }) => options.stdin)).toEqual(["current saved source", ""]);
});

test("guest setup failure remains repairable and protocol or transport output remains private", async () => {
  const env = fixture("failed\n");
  expect((await env.runtime.runEnvironmentSetup("pet", "exit 1")).status).toBe("failed");
  const malformed = fixture("private script output");
  await expect(malformed.runtime.runEnvironmentSetup("pet", "echo private")).rejects.toThrow("invalid microsandbox environment setup response");
  const disconnected = fixture("private script output", false);
  await expect(disconnected.runtime.runEnvironmentSetup("pet")).rejects.toThrow("microsandbox environment setup execution failed");
});


test("a newer saved version requested during a run waits and then executes that version", async () => {
  const sources: (string | undefined)[] = [];
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const started = new Promise<void>((done) => { entered = done; });
  const runtime = new MicrosandboxRuntime({
    builder: { buildImage: async () => "image", exportImage: async () => {}, cancel() {} },
    homesDir: tempDir(), proxyPort: 3128, relayPort: 8080,
    run: async (command, options) => {
      if (command.includes("--version")) return { ok: true, stdout: "msb 0.7.13", stderr: "" };
      sources.push(options.stdin);
      if (sources.length === 1) { entered(); await gate; }
      return { ok: true, stdout: "complete", stderr: "" };
    },
  });
  const first = runtime.runEnvironmentSetup("pet", "first");
  await started;
  const second = runtime.runEnvironmentSetup("pet", "new saved version");
  expect(sources).toEqual(["first"]);
  release();
  await Promise.all([first, second]);
  expect(sources).toEqual(["first", "new saved version"]);
});

test("the owner's setup runs with the usual umask; only the wrapper's own log and status are private", async () => {
  const { ENVIRONMENT_SETUP_SCRIPT: script } = await import("../../src/infra/environment-setup");
  expect(script).toContain("umask 077"); // its log and status
  expect(script.indexOf("umask 022")).toBeGreaterThan(script.indexOf('chmod 600 "$log"'));
  expect(script.indexOf("umask 022")).toBeLessThan(script.indexOf('bash "$setup"'));
});

test("installs through sudo go where the agent can run them; the agent's own commands keep their homes", async () => {
  const { ENVIRONMENT_SETUP_SCRIPT: script } = await import("../../src/infra/environment-setup");
  const { INSTALL_ENV, INSTALL_ENV_SUDOERS } = await import("../../src/core/install-env");
  expect(script).toContain("mkdir -p /opt/household /etc/household");
  for (const [name, value] of Object.entries(INSTALL_ENV)) expect(script).toContain(`${name}=${value}`); // in sudo's env_file
  expect(INSTALL_ENV_SUDOERS).toBe("Defaults:agent env_file=/etc/household/install-env");
  expect(script).toContain("visudo -cf"); // a broken rule never replaces the last one
  expect(script.indexOf("env_file")).toBeLessThan(script.indexOf('if [ ! -s "$setup" ]')); // also for a pet with no saved setup
  expect(script).not.toContain("export CARGO_HOME"); // the owner's own (non-sudo) commands are left alone
});
