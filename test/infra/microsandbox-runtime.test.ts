import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { MAIN_JOB_LABEL, MicrosandboxRuntime, type MicrosandboxRun } from "../../src/infra/microsandbox-runtime";
import { ENVIRONMENT_SETUP_HOST_TIMEOUT_MS, environmentScript } from "../../src/infra/environment-setup";
import { GUEST_SERVICES_INSTALL, GUEST_SERVICES_READY, GUEST_SERVICES_SCRIPT } from "../../src/infra/guest-services";
import { GUEST_TRUST_SETUP } from "../../src/infra/guest-trust";
import { tempDir } from "../helpers";

function setup() {
  const calls: { command: string[]; options: Parameters<MicrosandboxRun>[1] }[] = [];
  const states = new Map<string, string>();
  const labels = new Map<string, Record<string, string>>();
  const jobStates = new Map<string, string>();
  const volumes = new Set<string>();
  const job = `job_${"a".repeat(32)}`;
  let digest = "sha256:old";
  let version = "0.7.13";
  let cancelled = 0;
  let exports = 0;
  let setupStatus: "complete" | "failed" | "skipped" = "complete";
  let setupTransportFailed = false;
  let guestDocker = false;
  let guestReady = true;
  const builder = { buildImage: async () => "sha256:new", exportImage: async (_tag: string, file: string) => { exports++; writeFileSync(file, "fake image"); }, cancel() { cancelled++; } };
  const run: MicrosandboxRun = async (command, options) => {
    calls.push({ command, options });
    if (command.includes(GUEST_SERVICES_INSTALL)) return { ok: true, stdout: guestDocker ? "installed\n" : "skipped\n", stderr: "" };
    if (command.includes(GUEST_SERVICES_READY)) return { ok: guestReady, stdout: "", stderr: "private startup error" };
    if (command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true))) return setupTransportFailed
      ? { ok: false, stdout: "private fixture output", stderr: "private fixture error", code: 1 }
      : { ok: true, stdout: `${setupStatus}\n`, stderr: "", code: 0 };
    const args = command.slice(1);
    let stdout = "";
    if (args[0] === "--version") stdout = `msb ${version}\n`;
    if (args[0] === "image") stdout = JSON.stringify({ config: { digest } });
    if (args[0] === "load") digest = "sha256:new";
    if (args[0] === "list") stdout = JSON.stringify([...states].map(([name, status]) => ({ name, status })));
    if (args[0] === "create") states.set(args[args.indexOf("--name") + 1]!, "Running");
    if (args[0] === "inspect") stdout = args.includes("--job")
      ? JSON.stringify({ id: args[args.indexOf("--job") + 1], state: jobStates.get(args[args.indexOf("--job") + 1]!) ?? "running" })
      : JSON.stringify({ name: args[1], status: states.get(args[1]!), config: { labels: labels.get(args[1]!) ?? { "household.owner": "test-owner", [MAIN_JOB_LABEL]: job }, runtime: { entrypoint: ["/image-entrypoint"], cmd: ["image-argument"] } } });
    if (args[0] === "modify") {
      const changed = { ...(labels.get(args[1]!) ?? { "household.owner": "test-owner" }) };
      args.forEach((arg, index) => { if (args[index - 1] === "--label") changed[arg.split("=")[0]!] = arg.slice(arg.indexOf("=") + 1); });
      labels.set(args[1]!, changed);
    }
    if (args[0] === "volume") {
      const [, action, name] = args as [string, string, string];
      if (action === "inspect") return { ok: volumes.has(name), stdout: "", stderr: "no such volume", code: volumes.has(name) ? 0 : 1 };
      if (action === "create") volumes.add(name);
      if (action === "remove") volumes.delete(name);
    }
    if (args[0] === "pause") states.set(args[1]!, "Paused");
    if (args[0] === "resume" || args[0] === "start") states.set(args[1]!, "Running");
    if (args[0] === "stop") states.set(args[1]!, "Stopped");
    if (args[0] === "remove") states.delete(args.at(-1)!);
    if (args[0] === "exec") stdout = args.includes("--detach") ? job : options.stdin ?? "";
    return { ok: true, stdout, stderr: "", code: 0 };
  };
  const homesDir = join(tempDir(), "homes");
  const runtime = new MicrosandboxRuntime({ builder, homesDir, proxyPort: 3128, relayPort: 8080, run });
  return { runtime, homesDir, calls, states, run, labels, jobStates, volumes, job, builder, exports: () => exports, cancelled: () => cancelled, version: (value: string) => { version = value; }, setupStatus: (value: typeof setupStatus) => { setupStatus = value; }, failSetupTransport: () => { setupTransportFailed = true; }, guestDocker: (ready = true) => { guestDocker = true; guestReady = ready; } };
}

test("VM creation is detached and default-deny, exposing only the two House ports with canonical uid-mapped mounts", async () => {
  const env = setup();
  const ro = join(tempDir(), "ca.crt"); writeFileSync(ro, "public CA");
  await env.runtime.runContainer({ name: "household.work.sibling", image: "house-agent:test", env: { HTTPS_PROXY: "http://host.microsandbox.internal:3128" },
    labels: { "household.owner": "test-owner" }, mounts: [{ type: "volume", source: "household.work.sibling.home", target: "/home/agent" }, { type: "bind", source: ro, target: "/etc/household/ca.crt", readOnly: true },
      { type: "disk", source: "household.work.sibling.docker", target: "/var/lib/docker", size: "10G" }], limits: { pids: 512, memory: "1G" } });
  const args = env.calls.find(({ command }) => command[1] === "create")!.command;
  expect(args.slice(0, 3)).toEqual(["msb", "create", "house-agent:test"]);
  expect(env.calls.some(({ command }) => command.join(" ") === "msb exec --detach --no-stdin --no-tty household.work.sibling -- /image-entrypoint image-argument")).toBe(true);
  expect(args).toContain("--no-net");
  // Docker's disk is a named ext4 volume, created before the VM and kept when it goes; no disk is the VM's own.
  expect(env.calls.map(({ command }) => command.join(" "))).toContain("msb volume create household.work.sibling.docker --kind disk --size 10G --quiet");
  expect(args.filter((arg, index) => args[index - 1] === "--mount-named")).toEqual(["household.work.sibling.docker:/var/lib/docker:kind=disk,size=10G"]);
  expect(args).not.toContain("--mount-owned");
  expect(args).toContain("household.env-keys=HTTPS_PROXY");
  expect(args.filter((arg) => arg.startsWith("allow@"))).toEqual(["allow@host:tcp:3128", "allow@host:tcp:8080"]);
  expect(args).not.toContain("--secret");
  expect(args).not.toContain("--proxy");
  expect(args).toContain(`${await realpath(ro)}:/etc/household/ca.crt:ro,uid=1000,gid=1000`);
  const home = await env.runtime.homePath("household.work.sibling.home");
  expect(args).toContain(`${home}:/home/agent:uid=1000,gid=1000`);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(env.runtime.host).toBe("host.microsandbox.internal");
  const setupIndex = env.calls.findIndex(({ command }) => command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true)));
  const mainIndex = env.calls.findIndex(({ command }) => command.includes("--detach"));
  expect(setupIndex).toBeGreaterThan(0);
  expect(setupIndex).toBeLessThan(mainIndex);
  expect(env.calls[setupIndex]!.options.timeoutMs).toBe(ENVIRONMENT_SETUP_HOST_TIMEOUT_MS);
  expect(env.calls[setupIndex]!.command).toEqual(["msb", "exec", "--stream", "--no-tty", "--timeout", "915s", "household.work.sibling", "--", "sh", "-c", environmentScript("setup", true)]);
});

test("ordinary setup failures still launch the agent on creation and start; transport failure stays fatal and private", async () => {
  for (const start of [false, true]) {
    const env = setup();
    env.setupStatus("failed");
    env.states.set("pet", "Stopped");
    await (start ? env.runtime.startContainer("pet") : env.runtime.runContainer({ name: "pet", image: "image" }));
    expect(env.calls.some(({ command }) => command.includes("--detach"))).toBe(true);
    expect(env.states.get("pet")).toBe("Running");
  }
  const env = setup(); env.failSetupTransport();
  await expect(env.runtime.runContainer({ name: "pet", image: "image" })).rejects.toThrow("microsandbox environment setup execution failed");
  expect(env.calls.some(({ command }) => command.includes("--detach"))).toBe(false);
  expect(env.states.get("pet")).toBe("Stopped");
});

test("setup can be repaired and retried without restarting the VM or live agent", async () => {
  const env = setup(); env.setupStatus("failed");
  expect(env.runtime.environmentSetupResult("pet")).toBeUndefined();
  await env.runtime.runContainer({ name: "pet", image: "image" });
  expect(env.runtime.environmentSetupResult("pet")?.status).toBe("failed");
  for (const status of ["failed", "complete", "skipped"] as const) {
    env.setupStatus(status);
    expect(await env.runtime.runEnvironmentSetup("pet")).toEqual({ status, logPath: "~/environment/setup.log", statusPath: "~/environment/setup.status" });
    expect(env.runtime.environmentSetupResult("pet")?.status).toBe(status);
  }
  expect(env.calls.filter(({ command }) => command[1] === "create")).toHaveLength(1);
  expect(env.calls.filter(({ command }) => command.includes("--detach"))).toHaveLength(1);
  expect(env.calls.some(({ command }) => ["stop", "start", "remove"].includes(command[1]!))).toBe(false);
  await env.runtime.removeContainer("pet");
  expect(env.runtime.environmentSetupResult("pet")).toBeUndefined();
});

test("startup serializes phases and concurrent explicit retries coalesce", async () => {
  const env = setup();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const started = new Promise<void>((done) => { entered = done; });
  let invocations = 0;
  const runtime = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command, options) => {
    if (command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true))) {
      invocations++;
      entered();
      await held;
    }
    return env.run(command, options);
  } });
  const launch = runtime.runContainer({ name: "pet", image: "image" });
  await started;
  const retry = runtime.runEnvironmentSetup("pet");
  const duplicate = runtime.runEnvironmentSetup("pet");
  const other = runtime.runEnvironmentSetup("other");
  release();
  await Promise.all([launch, retry, duplicate, other]);
  expect(invocations).toBe(4);
  await runtime.runEnvironmentSetup("pet");
  expect(invocations).toBe(5);
  expect(env.calls.filter(({ command }) => command.includes("--detach"))).toHaveLength(1);
});

test("setup protocol rejects unexpected output without disclosing it and permits a later retry", async () => {
  const env = setup();
  let malformed = true;
  const runtime = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command, options) => {
    if (malformed && command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true))) return { ok: true, stdout: "private fixture output", stderr: "private fixture error", code: 0 };
    return env.run(command, options);
  } });
  await expect(runtime.runEnvironmentSetup("pet")).rejects.toThrow("invalid microsandbox environment setup response");
  malformed = false;
  expect((await runtime.runEnvironmentSetup("pet")).status).toBe("complete");
});

test("homes outside the homes dir, or linked elsewhere, fail rather than weakening isolation", async () => {
  const env = setup();
  await expect(env.runtime.homePath("../outside")).rejects.toThrow("invalid Household home");
  mkdirSync(env.homesDir);
  symlinkSync(tempDir(), join(env.homesDir, "linked"));
  await expect(env.runtime.homePath("linked")).rejects.toThrow("plain host directory");
  expect(env.calls).toEqual([]);
});

test("image production is injected; imported config digest must match builder and repeated build skips export", async () => {
  const env = setup();
  expect(await env.runtime.buildImage("house-agent:test", "/context")).toBe("sha256:new");
  expect(env.exports()).toBe(1);
  const load = env.calls.find(({ command }) => command[1] === "load")!.command;
  const archive = load[load.indexOf("--input") + 1]!;
  expect(existsSync(archive)).toBe(false);
  expect(await env.runtime.buildImage("house-agent:test", "/context")).toBe("sha256:new");
  expect(env.exports()).toBe(1);
});

test("inventory, owner labels, pause/resume and stop/start match persistent VM state; missing removal is harmless", async () => {
  const env = setup(); env.states.set("pet", "Running");
  expect(await env.runtime.listContainers("household.owner=test-owner")).toMatchObject([{ name: "pet", state: "running", labels: { "household.owner": "test-owner" } }]);
  expect(env.calls.some(({ command }) => command.includes("--label") && command.includes("household.owner=test-owner"))).toBe(true);
  await env.runtime.pause("pet");
  expect((await env.runtime.container("pet"))!.state).toBe("paused");
  await env.runtime.unpause("pet");
  await env.runtime.unpause("pet");
  expect(env.calls.filter(({ command }) => command[1] === "resume")).toHaveLength(1);
  await env.runtime.stopContainer("pet");
  expect(await env.runtime.isRunning("pet")).toBe(false);
  await env.runtime.startContainer("pet");
  expect(await env.runtime.isRunning("pet")).toBe(true);
  await env.runtime.removeContainer("pet");
  await env.runtime.removeContainer("missing");
  expect(env.calls.filter(({ command }) => command[1] === "remove")).toHaveLength(1);
});

test("exec preserves all stdin and stdout whitespace in stream mode; attach alone allocates a terminal", async () => {
  const env = setup();
  const input = "\nfirst\u0000\r\n\nlast\n";
  expect(await env.runtime.exec("pet", ["cat"], input)).toEqual({ ok: true, output: input });
  const execution = env.calls.at(-1)!;
  expect(execution.command).toEqual(["msb", "exec", "--stream", "--no-tty", "--timeout", "5s", "pet", "--", "cat"]);
  expect(execution.options.stdin).toBe(input);
  expect(await env.runtime.attach("pet", ["sh"])).toBe(0);
  expect(env.calls.at(-1)!.options.inherit).toBe(true);
  expect(env.calls.at(-1)!.options.timeoutMs).toBeUndefined();
});

test("version drift refuses work and command failures never echo env credentials", async () => {
  const env = setup(); env.version("0.8.0");
  await expect(env.runtime.exec("pet", ["cat"])).rejects.toThrow("requires microsandbox 0.7.13");
  const runtime = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command) => command[1] === "--version" ? { ok: true, stdout: "msb 0.7.13", stderr: "" } : { ok: false, stdout: "", stderr: "HOUSE_TOKEN=private-value" } });
  await expect(runtime.runContainer({ name: "pet", image: "image", env: { HOUSE_TOKEN: "private-value" } })).rejects.toThrow("microsandbox create failed");
});

test("cancel aborts in-flight commands and image work while later commands receive a fresh signal", async () => {
  const env = setup();
  let firstSignal: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>((done) => { entered = done; });
  let hold = true;
  const runtime = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command, options) => {
    if (command[1] === "--version") return { ok: true, stdout: "msb 0.7.13", stderr: "" };
    if (hold) {
      firstSignal = options.signal; entered();
      await new Promise((done) => options.signal!.addEventListener("abort", done, { once: true }));
      return { ok: false, stdout: "", stderr: "" };
    }
    expect(options.signal!.aborted).toBe(false);
    expect(options.signal).not.toBe(firstSignal);
    return { ok: true, stdout: "later", stderr: "" };
  } });
  const pending = runtime.exec("pet", ["sleep", "100"]);
  await started;
  runtime.cancel();
  expect(await pending).toEqual({ ok: false, output: "" });
  expect(env.cancelled()).toBe(1);
  hold = false;
  expect(await runtime.exec("pet", ["echo", "later"])).toEqual({ ok: true, output: "later" });
});


test("adoption reports idle/dead-job VMs as exited and managed main jobs survive new runtime instances", async () => {
  const env = setup(); env.states.set("pet", "Running");
  expect(await env.runtime.isRunning("pet")).toBe(true);
  env.labels.set("pet", { "household.owner": "test-owner" });
  expect((await env.runtime.container("pet"))!.state).toBe("exited");
  env.labels.set("pet", { "household.owner": "test-owner", [MAIN_JOB_LABEL]: env.job });
  env.jobStates.set(env.job, "completed");
  expect((await env.runtime.container("pet"))!.state).toBe("exited");
  env.jobStates.set(env.job, "running");
  const adopted = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command, options) => {
    // Reuse the same persistent VM metadata, without creating or launching another image process.
    if (command[1] === "--version") return { ok: true, stdout: "msb 0.7.13", stderr: "" };
    if (command[1] === "list") return { ok: true, stdout: JSON.stringify([{ name: "pet", status: "Running" }]), stderr: "" };
    return command.includes("--job") ? { ok: true, stdout: JSON.stringify({ id: env.job, state: "running" }), stderr: "" } : { ok: true, stdout: JSON.stringify({ name: "pet", status: "Running", config: { labels: { [MAIN_JOB_LABEL]: env.job } } }), stderr: "" };
  } });
  expect(await adopted.isRunning("pet")).toBe(true);
});

test("stopped VM start launches the image command again, but starting a healthy running VM never duplicates it", async () => {
  const env = setup(); env.states.set("pet", "Stopped");
  await env.runtime.startContainer("pet");
  expect(env.calls.filter(({ command }) => command[1] === "exec" && command.includes("--detach"))).toHaveLength(1);
  expect(env.calls.filter(({ command }) => command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true)))).toHaveLength(2);
  await env.runtime.startContainer("pet");
  expect(env.calls.filter(({ command }) => command[1] === "exec" && command.includes("--detach"))).toHaveLength(1);
});

test("raw machine lifecycle stays running when a resident VM's managed workload has ended", async () => {
  const env = setup(); env.states.set("pet", "Running"); env.jobStates.set(env.job, "completed");
  expect((await env.runtime.container("pet"))!.state).toBe("exited");
  expect((await env.runtime.machine("pet"))!.state).toBe("running");
  env.labels.set("pet", { "household.owner": "test-owner" });
  expect((await env.runtime.container("pet"))!.state).toBe("exited");
  expect((await env.runtime.machine("pet"))!.state).toBe("running");
});

test("transient job inspection failures propagate instead of misclassifying a healthy VM for destructive recreation", async () => {
  const env = setup();
  const runtime = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command) => {
    if (command[1] === "--version") return { ok: true, stdout: "msb 0.7.13", stderr: "" };
    if (command[1] === "list") return { ok: true, stdout: JSON.stringify([{ name: "pet", status: "Running" }]), stderr: "" };
    if (command.includes("--job")) return { ok: false, stdout: "", stderr: "PRIVATE_TOKEN=do-not-print" };
    return { ok: true, stdout: JSON.stringify({ name: "pet", status: "Running", config: { labels: { [MAIN_JOB_LABEL]: env.job } } }), stderr: "" };
  } });
  await expect(runtime.container("pet")).rejects.toThrow("microsandbox main job inspection failed");
  expect((await runtime.machine("pet"))!.state).toBe("running");
});

test("stop/start preserves the VM identity and runs latest configured setup before relaunching main", async () => {
  const env = setup();
  await env.runtime.runContainer({ name: "pet", image: "image", environmentSetup: "old" });
  env.calls.length = 0;
  env.runtime.configureEnvironmentSetup("pet", "printf latest");
  await env.runtime.stopContainer("pet");
  await env.runtime.startContainer("pet");
  const commands = env.calls.map(({ command }) => command[1]);
  expect(commands).not.toContain("remove");
  expect(commands).not.toContain("create");
  expect(commands.indexOf("stop")).toBeLessThan(commands.indexOf("start"));
  const setupIndex = env.calls.findIndex(({ command }) => command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true)));
  const mainIndex = env.calls.findIndex(({ command }) => command.includes("--detach"));
  expect(env.calls[setupIndex]!.options.stdin).toBe("printf latest");
  expect(setupIndex).toBeLessThan(mainIndex);
  expect(env.states.get("pet")).toBe("Running");
});


test("guest Docker starts before setup/main and checks ordinary-user socket readiness; failure stops launch", async () => {
  for (const ready of [true, false]) {
    const env = setup(); env.guestDocker(ready);
    const launch = env.runtime.runContainer({ name: "pet", image: "image" });
    if (ready) await launch;
    else await expect(launch).rejects.toThrow("microsandbox exec failed");
    const install = env.calls.findIndex(({ command }) => command.includes(GUEST_SERVICES_INSTALL));
    const trust = env.calls.findIndex(({ command }) => command.includes(GUEST_TRUST_SETUP));
    expect(trust).toBeGreaterThan(-1);
    expect(trust).toBeLessThan(install);
    const daemon = env.calls.findIndex(({ command }) => command.includes("/etc/household/guest-services.sh"));
    const probe = env.calls.findIndex(({ command }) => command.includes(GUEST_SERVICES_READY));
    const setupCall = env.calls.findIndex(({ command }) => command.some(arg => arg === environmentScript("setup") || arg === environmentScript("setup", true) || arg === environmentScript("onStart", true)));
    expect(env.calls[install]!.options.stdin).toBe(GUEST_SERVICES_SCRIPT);
    expect(daemon).toBeGreaterThan(install);
    expect(probe).toBeGreaterThan(daemon);
    expect(env.calls[probe]!.command).not.toContain("sudo");
    if (ready) expect(setupCall).toBeGreaterThan(probe);
    else { expect(setupCall).toBe(-1); expect(env.states.get("pet")).toBe("Stopped"); }
  }
});


test("guest proxy and Docker readiness refresh before restarting an ended main workload", async () => {
  const env = setup(); env.guestDocker(true);
  env.states.set("pet", "Running");
  env.jobStates.set(env.job, "completed");
  await env.runtime.startContainer("pet");
  expect(env.calls.some(({ command }) => command.includes("/etc/household/guest-services.sh"))).toBe(true);
  expect(env.calls.some(({ command }) => command.includes(GUEST_SERVICES_READY))).toBe(true);
  expect(env.calls.filter(({ command }) => command.includes("--detach"))).toHaveLength(2);
});

test("session reset detaches only its pointer, tolerates missing state, and retains native history", async () => {
  const { runtime } = setup();
  const volume = "household.work.sibling.home";
  const home = await runtime.homePath(volume);
  writeFileSync(join(home, ".household-codex-thread"), "old-thread\n");
  writeFileSync(join(home, "history"), "retained");
  await runtime.resetSession(volume, ".household-codex-thread");
  expect(existsSync(join(home, ".household-codex-thread"))).toBe(false);
  expect(readFileSync(join(home, ".household-codex-thread.before-restart"), "utf8")).toBe("old-thread\n");
  expect(readFileSync(join(home, "history"), "utf8")).toBe("retained");
  await runtime.resetSession(volume, ".household-codex-thread");
  await expect(runtime.resetSession(volume, "../outside")).rejects.toThrow("invalid session pointer");
});

test("a Docker disk is created once, outlives the VM, and goes only when asked; disk names follow msb's rule", async () => {
  const env = setup();
  const disk = { type: "disk" as const, source: "household.work.sibling.docker", target: "/var/lib/docker", size: "10G" };
  await env.runtime.runContainer({ name: "pet", image: "image", mounts: [disk] });
  await env.runtime.removeContainer("pet");
  await env.runtime.runContainer({ name: "pet", image: "image", mounts: [disk] });
  expect(env.calls.filter(({ command }) => command[1] === "volume" && command[2] === "create")).toHaveLength(1);
  expect([...env.volumes]).toEqual(["household.work.sibling.docker"]);
  await env.runtime.removeDisk("household.work.sibling.docker");
  await env.runtime.removeDisk("household.work.sibling.docker");
  expect(env.volumes.size).toBe(0);
  expect(env.calls.filter(({ command }) => command[1] === "volume" && command[2] === "remove")).toHaveLength(1);
  await expect(env.runtime.runContainer({ name: "other", image: "image", mounts: [{ ...disk, source: "../escape" }] })).rejects.toThrow("invalid microsandbox disk");
  await expect(env.runtime.removeDisk("-flag")).rejects.toThrow("invalid microsandbox disk");
});

test("a stopped VM's launch configuration replaces Household's environment, dropping the keys it no longer sets", async () => {
  const env = setup();
  await env.runtime.runContainer({ name: "pet", image: "image", env: { MODEL: "small", ANTHROPIC_API_KEY: "placeholder" }, labels: { "household.launch": "old" } });
  env.labels.set("pet", { ...env.labels.get("pet"), "household.env-keys": "MODEL,ANTHROPIC_API_KEY" });
  const launch = { env: { MODEL: "big", CLAUDE_CODE_OAUTH_TOKEN: "placeholder-secret" }, labels: { "household.launch": "new" } };
  await expect(env.runtime.configureLaunch("pet", launch)).rejects.toThrow("stop the bot VM");
  await env.runtime.stopContainer("pet");
  env.calls.length = 0;
  await env.runtime.configureLaunch("pet", launch);
  expect(env.calls.at(-1)!.command).toEqual(["msb", "modify", "pet", "--env", "MODEL=big", "--env", "CLAUDE_CODE_OAUTH_TOKEN=placeholder-secret",
    "--env-rm", "ANTHROPIC_API_KEY", "--label", "household.launch=new", "--label", "household.env-keys=MODEL,CLAUDE_CODE_OAUTH_TOKEN"]);
  expect(env.labels.get("pet")).toMatchObject({ "household.launch": "new", "household.env-keys": "MODEL,CLAUDE_CODE_OAUTH_TOKEN" });
  // A failed modify never echoes the placeholders it carried.
  const failing = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080,
    run: async (command, options) => command[1] === "modify" ? { ok: false, stdout: "", stderr: "placeholder-secret" } : env.run(command, options) });
  await expect(failing.configureLaunch("pet", launch)).rejects.toThrow(/^microsandbox modify failed$/);
});

test("msb's passing VM statuses read as starting and stopping, of the VM and of its workload alike", async () => {
  const env = setup();
  for (const [status, state] of [["Starting", "starting"], ["Draining", "stopping"], ["Crashed", "crashed"]]) {
    env.states.set("pet", status!);
    expect((await env.runtime.container("pet"))!.state).toBe(state!);
    expect((await env.runtime.machine("pet"))!.state).toBe(state!);
  }
});

test("a main job in a state Household does not know shows as unknown without failing the inventory, and starting that VM refuses", async () => {
  const env = setup();
  env.states.set("pet", "Running");
  env.states.set("other", "Running");
  env.jobStates.set(env.job, "lost");
  expect((await env.runtime.listContainers("household.owner=test-owner")).map(({ state }) => state)).toEqual(["unknown", "unknown"]);
  await expect(env.runtime.startContainer("pet")).rejects.toThrow("unknown microsandbox main job state");
  expect(env.calls.some(({ command }) => command.includes("--detach"))).toBe(false);
});

test("a VM this runtime is starting or stopping shows so, its last boot's main job never inspected", async () => {
  const env = setup();
  const old = `job_${"b".repeat(32)}`;
  env.states.set("pet", "Stopped");
  env.labels.set("pet", { "household.owner": "test-owner", [MAIN_JOB_LABEL]: old });
  env.jobStates.set(old, "lost"); // what the new boot would say of it
  const trust = Promise.withResolvers<void>();
  const held = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command, options) => {
    if (command.includes(GUEST_TRUST_SETUP)) await trust.promise;
    return env.run(command, options);
  } });
  const starting = held.startContainer("pet");
  await Bun.sleep(5);
  expect(env.states.get("pet")).toBe("Running"); // booted, its agent not launched yet
  expect(await held.listContainers("household.owner=test-owner")).toMatchObject([{ name: "pet", state: "starting" }]);
  expect(env.calls.some(({ command }) => command.includes(old))).toBe(false);
  trust.resolve();
  await starting;
  expect((await held.container("pet"))!.state).toBe("running");

  const stop = Promise.withResolvers<void>();
  const stopping = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run: async (command, options) => {
    if (command[1] === "stop") await stop.promise;
    return env.run(command, options);
  } });
  const stopped = stopping.stopContainer("pet");
  await Bun.sleep(5);
  expect((await stopping.container("pet"))!.state).toBe("stopping");
  stop.resolve();
  await stopped;
  expect((await stopping.container("pet"))!.state).toBe("stopped");
});

function pulling(pulls: { ok: boolean; stderr?: string }[], released: string | null = "ghcr.io/underwear/house-agent:v1.0.0") {
  const env = setup();
  const cached = new Map<string, string>();
  const outcomes = [...pulls];
  const run: MicrosandboxRun = async (command, options) => {
    if (command[1] === "pull") {
      const outcome = outcomes.shift() ?? { ok: false };
      env.calls.push({ command, options });
      if (outcome.ok) cached.set(command.at(-1)!, "sha256:pulled");
      return { ok: outcome.ok, stdout: "", stderr: outcome.stderr ?? "", code: outcome.ok ? 0 : 1 };
    }
    if (command[1] === "image" && command[3]?.startsWith("ghcr.io/")) {
      env.calls.push({ command, options });
      const digest = cached.get(command[3]);
      return digest ? { ok: true, stdout: JSON.stringify({ config: { digest } }), stderr: "" } : { ok: false, stdout: "", stderr: "image not found" };
    }
    return env.run(command, options);
  };
  const runtime = new MicrosandboxRuntime({ builder: env.builder, homesDir: env.homesDir, proxyPort: 3128, relayPort: 8080, run, pullRetryMs: 1, released: async () => released ?? undefined });
  return { ...env, runtime, pulls: () => env.calls.filter(({ command }) => command[1] === "pull").length };
}

test("a released image is pulled from its registry, not built, and a cached one is not pulled again", async () => {
  const env = pulling([{ ok: true }]);
  expect(await env.runtime.prepareImage("house-agent:test", "/context")).toEqual({ ref: "ghcr.io/underwear/house-agent:v1.0.0", id: "sha256:pulled" });
  expect(await env.runtime.prepareImage("house-agent:test", "/context")).toEqual({ ref: "ghcr.io/underwear/house-agent:v1.0.0", id: "sha256:pulled" });
  expect(env.pulls()).toBe(1);
  expect(env.exports()).toBe(0);
});

test("a registry's passing refusal is retried", async () => {
  const env = pulling([{ ok: false, stderr: "OCI API error: retry-after" }, { ok: true }]);
  expect((await env.runtime.prepareImage("house-agent:test", "/context")).ref).toBe("ghcr.io/underwear/house-agent:v1.0.0");
  expect(env.pulls()).toBe(2);
});

test("an image that cannot be pulled is built here; one with no release is built without trying", async () => {
  const failing = pulling([], "ghcr.io/underwear/house-agent:v1.0.0");
  expect(await failing.runtime.prepareImage("house-agent:test", "/context")).toEqual({ ref: "house-agent:test", id: "sha256:new" });
  expect(failing.pulls()).toBe(3);
  const local = pulling([], null);
  expect(await local.runtime.prepareImage("house-agent:test", "/context")).toEqual({ ref: "house-agent:test", id: "sha256:new" });
  expect(local.pulls()).toBe(0);
});

test("when neither the pull nor the build works, the error says both", async () => {
  const env = pulling([{ ok: false, stderr: "denied\nmore" }, { ok: false, stderr: "denied" }, { ok: false, stderr: "denied" }]);
  env.builder.buildImage = async () => { throw new Error("docker build  failed: no docker"); };
  await expect(env.runtime.prepareImage("house-agent:test", "/context")).rejects.toThrow("could not pull ghcr.io/underwear/house-agent:v1.0.0 (denied); building it here failed too: docker build  failed: no docker");
});

test("resident maxima survive staged shrink and a new runtime instance; stopped VMs release them", async () => {
  const { ACTIVE_RESOURCES_LABEL } = await import("../../src/infra/microsandbox-runtime");
  const item = { name: "household.work.pet", status: "Running", config: { labels: { "household.owner": "me" } as Record<string,string>, resources: { cpus: 6, memory_mib: 6144 } } };
  const backend: MicrosandboxRun = async command => {
    const args = command.slice(1);
    if (args[0] === "--version") return { ok: true, stdout: "msb 0.7.13", stderr: "" };
    if (args[0] === "list") return { ok: true, stdout: JSON.stringify([{ name: item.name }]), stderr: "" };
    if (args[0] === "inspect") return { ok: true, stdout: JSON.stringify(item), stderr: "" };
    if (args[0] === "modify") {
      if (args.includes("--label")) {
        const label = args[args.indexOf("--label") + 1]!;
        item.config.labels[label.slice(0,label.indexOf("="))] = label.slice(label.indexOf("=")+1);
      }
      if (args.includes("--cpus")) item.config.resources.cpus = Number(args[args.indexOf("--cpus")+1]);
      if (args.includes("--memory")) item.config.resources.memory_mib = parseFloat(args[args.indexOf("--memory")+1]!);
    }
    if (args[0] === "stop") item.status = "Stopped";
    return { ok: true, stdout: "", stderr: "" };
  };
  const options = { homesDir: tempDir(), proxyPort: 3128, relayPort: 8080, builder: { buildImage: async () => "", exportImage: async () => {}, cancel() {} }, run: backend };
  const runtime = new MicrosandboxRuntime(options);
  await runtime.configureResources(item.name, { cpus: 2, memoryMiB: 1024 });
  expect(item.config.resources.cpus).toBe(2);
  expect(JSON.parse(item.config.labels[ACTIVE_RESOURCES_LABEL]!)).toEqual({ cpus: 6, memoryMiB: 6144 });
  const adopted = new MicrosandboxRuntime(options);
  expect((await adopted.machine(item.name))!.resources).toEqual({ cpus: 6, memoryMiB: 6144 });
  await adopted.configureResources(item.name, { cpus: 1, memoryMiB: 512 });
  expect((await adopted.machine(item.name))!.resources!.cpus).toBe(6);
  await adopted.stopContainer(item.name);
  expect((await adopted.machine(item.name))!.resources).toBeUndefined();
});
