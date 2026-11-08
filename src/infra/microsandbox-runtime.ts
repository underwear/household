import type { EnvironmentPhase } from "../core/environment";
import { GUEST_SKILLS_SETUP } from "./guest-skills";
import { GUEST_TRUST_SETUP } from "./guest-trust";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ContainerInfo, ContainerSpec, ImageBuilder, PetRuntime } from "./runtime";
import { ENVIRONMENT_SETUP_HOST_TIMEOUT_MS, environmentScript, type EnvironmentSetupResult } from "./environment-setup";
import { GUEST_SERVICES_INSTALL, GUEST_SERVICES_READY, GUEST_SERVICES_SCRIPT } from "./guest-services";

export const MICROSANDBOX_VERSION = "0.7.13";
export const MAIN_JOB_LABEL = "household.main-job";
/** The keys of the environment Household gave a VM, so a later launch configuration can drop the ones it no longer sets. */
export const ENV_KEYS_LABEL = "household.env-keys";
/** msb's own rule for volume names. */
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const JOB_ID = /^job_[a-f0-9]{32}$/;
/** msb's VM statuses on their way up or down, in Household's state words; the others are lowercased as they are. */
const PASSING_STATUS: Record<string, string> = { Starting: "starting", Draining: "stopping" };
/** Main job states: the agent's process is live, or it is over. */
const LIVE_JOB = ["running", "created", "starting", "queued", "pending"];
const OVER_JOB = ["completed", "failed", "cancelled", "exited", "killed", "timed_out", "stopped"];
type RunOptions = { stdin?: string; timeoutMs?: number; signal?: AbortSignal; inherit?: boolean };
type RunResult = { ok: boolean; stdout: string; stderr: string; code?: number };
export type MicrosandboxRun = (command: string[], options: RunOptions) => Promise<RunResult>;

/** Preserve bytes through msb's stream mode; terminal allocation is reserved for explicit attach. */
const run: MicrosandboxRun = async (command, options) => {
  try {
    const child = Bun.spawn(command, {
      stdin: options.inherit ? "inherit" : options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: options.inherit ? "inherit" : "pipe", stderr: options.inherit ? "inherit" : "pipe",
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      signal: options.signal, killSignal: "SIGKILL",
    });
    const [stdout, stderr, code] = await Promise.all([
      options.inherit ? "" : new Response(child.stdout).text(),
      options.inherit ? "" : new Response(child.stderr).text(), child.exited,
    ]);
    return { ok: code === 0, stdout, stderr, code };
  } catch { return { ok: false, stdout: "", stderr: "" }; }
};

export interface MicrosandboxOptions {
  builder: ImageBuilder;
  /** Stable host home dirs, indexed by the existing Household volume names. */
  homesDir: string;
  proxyPort: number;
  relayPort: number;
  cpus?: number;
  run?: MicrosandboxRun;
}

/** Detached per-pet microVMs. No guest has direct internet, LAN, or arbitrary host-port access. */
export class MicrosandboxRuntime implements PetRuntime, ImageBuilder {
  readonly host = "host.microsandbox.internal";
  private running = new AbortController();
  private version?: Promise<void>;
  private readonly run: MicrosandboxRun;
  private readonly setupScripts = new Map<string, string>();
  private readonly setupRunSources = new Map<string, string>();
  private readonly setupRuns = new Map<string, Promise<EnvironmentSetupResult>>();
  private readonly setupResults = new Map<string, EnvironmentSetupResult>();
  /**
   * VMs this runtime is starting or stopping now. Their main job label is the last boot's until a launch replaces
   * it, so their state is this, never their job's.
   */
  private readonly passing = new Map<string, "starting" | "stopping">();

  constructor(private readonly options: MicrosandboxOptions) {
    for (const port of [options.proxyPort, options.relayPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid House service port");
    if (!Number.isInteger(options.cpus ?? 2) || (options.cpus ?? 2) < 1) throw new Error("invalid microsandbox CPU limit");
    this.run = options.run ?? run;
  }

  cancel(): void {
    this.running.abort();
    this.running = new AbortController();
    this.options.builder.cancel();
  }

  private async ready(): Promise<void> {
    if (!this.version) this.version = (async () => {
      const result = await this.run(["msb", "--version"], { timeoutMs: 5000, signal: this.running.signal });
      if (!result.ok || result.stdout.trim() !== `msb ${MICROSANDBOX_VERSION}`) throw new Error(`Household requires microsandbox ${MICROSANDBOX_VERSION}`);
    })().catch((error) => { this.version = undefined; throw error; });
    return this.version;
  }

  private async msb(args: string[], options: RunOptions = {}): Promise<RunResult> {
    await this.ready();
    return this.run(["msb", ...args], { timeoutMs: 60_000, ...options, signal: this.running.signal });
  }

  private async checked(args: string[], options: RunOptions = {}): Promise<string> {
    const result = await this.msb(args, options);
    // Create args contain per-pet authentication env. Never include command lines or raw stderr in failures.
    if (!result.ok) throw new Error(`microsandbox ${args[0]} failed`);
    return result.stdout;
  }

  async buildImage(tag: string, contextDir: string): Promise<string> {
    await this.ready();
    const id = (await this.options.builder.buildImage(tag, contextDir)).trim();
    const cached = await this.msb(["image", "inspect", tag, "--format", "json"]);
    if (cached.ok && this.json(cached.stdout).config?.digest === id) return id;
    const dir = await mkdtemp(join(tmpdir(), "household-msb-image-"));
    try {
      const archive = join(dir, "image.tar");
      await this.options.builder.exportImage(tag, archive);
      await this.checked(["load", "--input", archive, "--tag", tag, "--quiet"], { timeoutMs: 30 * 60_000 });
      const imported = this.json(await this.checked(["image", "inspect", tag, "--format", "json"]));
      if (imported.config?.digest !== id) throw new Error("microsandbox imported a different image than the builder produced");
      return id;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  exportImage(tag: string, file: string): Promise<void> { return this.options.builder.exportImage(tag, file); }

  /** Maps old stable volume names to host paths; no Docker volume is mounted into a VM. */
  async homePath(volume: string): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(volume)) throw new Error("invalid Household home name");
    const root = await lstat(this.options.homesDir).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (root && !root.isDirectory()) throw new Error("Household homes root must be a plain host directory");
    await mkdir(this.options.homesDir, { recursive: true, mode: 0o700 });
    const path = join(await realpath(this.options.homesDir), volume);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (await realpath(path) !== path) throw new Error("Household home must be a plain host directory");
    return path;
  }

  async resetSession(volume: string, file: string): Promise<void> {
    if (!/^\.[a-zA-Z0-9_-]+$/.test(file)) throw new Error("invalid session pointer filename");
    const home = await this.homePath(volume);
    try { await rename(join(home, file), join(home, `${file}.before-restart`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  runContainer(spec: ContainerSpec): Promise<void> {
    return this.pass(spec.name, "starting", () => this.create(spec));
  }

  private async create(spec: ContainerSpec): Promise<void> {
    this.configureEnvironmentSetup(spec.name, spec.environmentSetup, spec.environmentOnStart);
    const args = ["create", spec.image, "--name", spec.name, "--pull", "never", "--cpus", String(spec.cpus ?? this.options.cpus ?? 2), "--memory", spec.limits?.memory ?? "1G", "--no-net"];
    for (const port of new Set([this.options.proxyPort, this.options.relayPort])) args.push("--net-rule", `allow@host:tcp:${port}`);
    for (const [key, value] of Object.entries(spec.env ?? {})) args.push("--env", `${key}=${value}`);
    for (const [key, value] of Object.entries({ ...spec.labels, [ENV_KEYS_LABEL]: Object.keys(spec.env ?? {}).join(",") })) args.push("--label", `${key}=${value}`);
    for (const mount of spec.mounts ?? []) {
      if (!isAbsolute(mount.target) || /[:,\x00-\x1f]/.test(mount.target)) throw new Error("invalid microsandbox mount target");
      if (mount.type === "disk") {
        await this.ensureDisk(mount.source, mount.size);
        args.push("--mount-named", `${mount.source}:${mount.target}:kind=disk,size=${mount.size}`);
        continue;
      }
      const source = mount.type === "volume" ? await this.homePath(mount.source) : await realpath(mount.source);
      if (/[:,\x00-\x1f]/.test(source)) throw new Error("invalid microsandbox mount source");
      const info = await stat(source);
      if (!info.isDirectory() && !info.isFile()) throw new Error("microsandbox mounts require ordinary files or directories");
      args.push(info.isDirectory() ? "--mount-dir" : "--mount-file", `${source}:${mount.target}:${mount.readOnly ? "ro," : ""}uid=1000,gid=1000`);
    }
    await this.checked(args);
    try { await this.launchMain(spec.name); } catch (error) {
      await this.checked(["stop", spec.name]).catch(() => {});
      throw error;
    }
  }

  /** msb create/start boots an idle VM; launch the effective image command as a durable managed job. */
  private async launchMain(name: string): Promise<void> {
    const item = this.json(await this.checked(["inspect", name, "--format", "json"]));
    const config = item.config?.runtime;
    if (!Array.isArray(config?.entrypoint ?? []) || !Array.isArray(config?.cmd ?? [])) throw new Error("invalid microsandbox image command");
    const command = [...(config?.entrypoint ?? []), ...(config?.cmd ?? [])];
    if (!command.length || command.some((part) => typeof part !== "string")) throw new Error("microsandbox image has no executable entrypoint");
    // Do this before launching either agent and before its readiness deadline starts. msb preserves the
    // image's uid/workdir/env, so setup has precisely the pet's existing rights and proxied networking.
    await this.checked(["exec", "--stream", "--no-tty", name, "--", "sh", "-c", GUEST_TRUST_SETUP]);
    await this.startGuestServices(name);
    if ((item.config?.env ?? []).some?.((item: {key?: string}) => item.key === "HOUSEHOLD_SKILLS_DIRECTORY")) {
      await this.checked(["exec", "--stream", "--no-tty", name, "--", "python3", "-"], { stdin: GUEST_SKILLS_SETUP });
    }
    await this.runEnvironmentPhase(name, "setup", true);
    await this.runEnvironmentPhase(name, "onStart", true);
    const job = (await this.checked(["exec", "--detach", "--no-stdin", "--no-tty", name, "--", ...command])).trim();
    if (!JOB_ID.test(job)) throw new Error("invalid microsandbox main job identifier");
    await this.checked(["modify", name, "--label", `${MAIN_JOB_LABEL}=${job}`]);
  }

  /** Nested Docker needs ext4, not the guest's overlay/virtio-fs root: a named disk, kept when a VM goes. */
  private async ensureDisk(name: string, size: string): Promise<void> {
    if (!VOLUME_NAME.test(name) || !/^[1-9][0-9]*[MG]$/.test(size)) throw new Error("invalid microsandbox disk");
    if ((await this.msb(["volume", "inspect", name])).ok) return;
    await this.checked(["volume", "create", name, "--kind", "disk", "--size", size, "--quiet"]);
  }

  async removeDisk(name: string): Promise<void> {
    if (!VOLUME_NAME.test(name)) throw new Error("invalid microsandbox disk");
    if ((await this.msb(["volume", "inspect", name])).ok) await this.checked(["volume", "remove", name, "--quiet"]);
  }

  private async startGuestServices(name: string): Promise<void> {
    const installed = (await this.checked(["exec", "--stream", "--no-tty", name, "--", "sh", "-c", GUEST_SERVICES_INSTALL], { stdin: GUEST_SERVICES_SCRIPT })).trim();
    // Minimal fixture/custom images without Docker retain the ordinary runtime contract.
    if (installed === "skipped") return;
    if (installed !== "installed") throw new Error("invalid microsandbox guest services response");
    const job = (await this.checked(["exec", "--detach", "--no-stdin", "--no-tty", name, "--", "sudo", "-n", "sh", "/etc/household/guest-services.sh"])).trim();
    if (!JOB_ID.test(job)) throw new Error("invalid microsandbox guest services job identifier");
    await this.checked(["exec", "--stream", "--no-tty", "--timeout", "65s", name, "--", "sh", "-c", GUEST_SERVICES_READY], { timeoutMs: 70_000 });
  }

  /** Startup and MCP retries share one invocation per VM; rerunning never restarts the live agent. */
  configureEnvironmentSetup(name: string, setup?: string, onStart?: string): void {
    this.setupScripts.set(`${name}/setup`, setup ?? "");
    this.setupScripts.set(`${name}/onStart`, onStart ?? "");
  }

  runEnvironmentSetup(name: string, setup?: string, phase: EnvironmentPhase = "setup"): Promise<EnvironmentSetupResult> {
    if (arguments.length > 1) this.setupScripts.set(`${name}/${phase}`, setup ?? "");
    return this.runEnvironmentPhase(name, phase, false);
  }

  private runEnvironmentPhase(name: string, phase: EnvironmentPhase, automatic: boolean, requestedSource?: string): Promise<EnvironmentSetupResult> {
    const key = `${name}/${phase}`;
    const source = requestedSource ?? this.setupScripts.get(key) ?? "";
    const identity = JSON.stringify([phase, source, automatic]);
    const pending = this.setupRuns.get(name);
    if (pending) {
      if (this.setupRunSources.get(name) === identity) return pending;
      return pending.then(() => this.runEnvironmentPhase(name, phase, automatic, source));
    }
    const execution = (async (): Promise<EnvironmentSetupResult> => {
      const setup = await this.msb(["exec", "--stream", "--no-tty", "--timeout", "915s", name, "--", "sh", "-c", environmentScript(phase, automatic)], { stdin: source, timeoutMs: ENVIRONMENT_SETUP_HOST_TIMEOUT_MS });
      if (!setup.ok) throw new Error("microsandbox environment setup execution failed");
      const response = setup.stdout.trim();
      const attempted = !response.startsWith("existing:");
      const status = attempted ? response : response.slice(9);
      if (status !== "complete" && status !== "failed" && status !== "skipped") throw new Error("invalid microsandbox environment setup response");
      const file = phase === "setup" ? "setup" : "on-start";
      const result: EnvironmentSetupResult = { status, ...(attempted ? {} : { attempted: false }), logPath: `~/environment/${file}.log`, statusPath: `~/environment/${file}.status` };
      this.setupResults.set(key, result);
      return { ...result };
    })();
    this.setupRunSources.set(name, identity);
    this.setupRuns.set(name, execution);
    void execution.finally(() => { if (this.setupRuns.get(name) === execution) { this.setupRuns.delete(name); this.setupRunSources.delete(name); } }).catch(() => {});
    return execution;
  }

  environmentSetupResult(name: string, phase: EnvironmentPhase = "setup"): EnvironmentSetupResult | undefined {
    const result = this.setupResults.get(`${name}/${phase}`);
    return result && { ...result };
  }

  /** Runs a start or stop of the VM, which shows `state` meanwhile (`inspect`). */
  private async pass<T>(name: string, state: "starting" | "stopping", work: () => Promise<T>): Promise<T> {
    this.passing.set(name, state);
    try { return await work(); } finally { this.passing.delete(name); }
  }

  /**
   * Whether the main job is live (`running`), over (`exited`: missing or dead main jobs are not healthy pets even
   * when the surrounding VM is still resident), or in a state Household does not know (`unknown`).
   */
  private async mainJob(name: string, labels: Record<string, string>): Promise<"running" | "exited" | "unknown"> {
    const job = labels[MAIN_JOB_LABEL];
    if (!job) return "exited";
    if (!JOB_ID.test(job)) throw new Error("invalid microsandbox main job identifier");
    const result = await this.msb(["inspect", name, "--job", job, "--format", "json"], { timeoutMs: 5000 });
    if (!result.ok) throw new Error("microsandbox main job inspection failed");
    const info = this.json(result.stdout);
    if (info.id !== job || typeof info.state !== "string") throw new Error("invalid microsandbox main job response");
    return LIVE_JOB.includes(info.state) ? "running" : OVER_JOB.includes(info.state) ? "exited" : "unknown";
  }

  removeContainer(name: string): Promise<void> {
    return this.pass(name, "stopping", async () => {
      if (await this.machine(name)) await this.checked(["remove", "--force", name]);
      this.setupResults.delete(`${name}/setup`);
      this.setupResults.delete(`${name}/onStart`);
    });
  }

  startContainer(name: string): Promise<void> {
    return this.pass(name, "starting", () => this.start(name));
  }

  private async start(name: string): Promise<void> {
    const item = this.json(await this.checked(["inspect", name, "--format", "json"]));
    if (item.status === "Paused") return;
    if (item.status === "Running") {
      const job = await this.mainJob(name, item.config?.labels ?? {});
      if (job === "running") return;
      // Launching another agent next to one in a state Household cannot read could run it twice.
      if (job === "unknown") throw new Error("unknown microsandbox main job state");
    }
    if (item.status !== "Running") await this.checked(["start", name]);
    try { await this.launchMain(name); } catch (error) {
      await this.checked(["stop", name]).catch(() => {});
      throw error;
    }
  }
  async configureLaunch(name: string, { env, labels }: { env: Record<string, string>; labels: Record<string, string> }): Promise<void> {
    const item = this.json(await this.checked(["inspect", name, "--format", "json"]));
    if (item.status === "Running" || item.status === "Paused") throw new Error("stop the pet VM before changing its launch configuration");
    const before = String(item.config?.labels?.[ENV_KEYS_LABEL] ?? "").split(",").filter(Boolean);
    const args = ["modify", name];
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    for (const key of before) if (!Object.hasOwn(env, key)) args.push("--env-rm", key);
    for (const [key, value] of Object.entries({ ...labels, [ENV_KEYS_LABEL]: Object.keys(env).join(",") })) args.push("--label", `${key}=${value}`);
    await this.checked(args);
  }

  async configureResources(name: string, resources: import("../core/resources").PetResources): Promise<void> {
    const item = this.json(await this.checked(["inspect", name, "--format", "json"]));
    const current = item.config?.resources;
    if (!current) throw new Error("microsandbox resource configuration unavailable");
    if (current.cpus === resources.cpus && current.memory_mib === resources.memoryMiB) return;
    // Persist both effective and boot-time maximum values; reductions and growth apply on the next boot.
    await this.checked(["modify", name, "--cpus", String(resources.cpus), "--max-cpus", String(resources.cpus),
      "--memory", `${resources.memoryMiB}M`, "--max-memory", `${resources.memoryMiB}M`, "--next-start"]);
  }

  async stopContainer(name: string): Promise<void> { await this.pass(name, "stopping", () => this.checked(["stop", name])); }
  async isRunning(name: string): Promise<boolean> { return (await this.container(name))?.state === "running"; }

  async listContainers(label: string): Promise<ContainerInfo[]> {
    const listed = this.json(await this.checked(["list", "--label", label, "--format", "json"]));
    if (!Array.isArray(listed)) throw new Error("invalid microsandbox inventory");
    return Promise.all(listed.map((row) => this.inspect(row.name)));
  }

  container(name: string): Promise<ContainerInfo | undefined> { return this.find(name, true); }

  /** Raw VM lifecycle for coherent backups/import guards: a dead main job can leave other guest jobs alive. */
  machine(name: string): Promise<ContainerInfo | undefined> { return this.find(name, false); }

  private async find(name: string, workload: boolean): Promise<ContainerInfo | undefined> {
    const listed = this.json(await this.checked(["list", "--format", "json"]));
    if (!Array.isArray(listed)) throw new Error("invalid microsandbox inventory");
    return listed.some((row) => row.name === name) ? this.inspect(name, workload) : undefined;
  }

  private async inspect(name: string, workload = true): Promise<ContainerInfo> {
    const item = this.json(await this.checked(["inspect", name, "--format", "json"]));
    if (item.name !== name || typeof item.status !== "string" || !item.config?.labels) throw new Error("invalid microsandbox inspection");
    return { name, state: await this.stateOf(name, item.status, item.config.labels, workload), labels: item.config.labels };
  }

  /**
   * A VM's state word. Of its workload (`workload`), a VM this runtime is starting or stopping is so whatever msb
   * says, and a running VM is as its main job is: `exited` once it is over, `unknown` in a state of msb's
   * Household does not know (one VM's never fails a whole inventory; starting such a VM refuses).
   */
  private async stateOf(name: string, status: string, labels: Record<string, string>, workload: boolean): Promise<string> {
    const passing = workload ? this.passing.get(name) : undefined;
    if (passing) return passing;
    if (workload && status === "Running") {
      const job = await this.mainJob(name, labels);
      if (job !== "running") return job;
    }
    return PASSING_STATUS[status] ?? status.toLowerCase();
  }

  async exec(name: string, command: string[], stdin?: string, timeoutMs = 5_000): Promise<{ ok: boolean; output: string }> {
    const result = await this.msb(["exec", "--stream", "--no-tty", "--timeout", `${Math.ceil(timeoutMs / 1000)}s`, name, "--", ...command], { stdin, timeoutMs: timeoutMs + 5_000 });
    return { ok: result.ok, output: result.stdout };
  }
  async attach(name: string, command: string[]): Promise<number> {
    const result = await this.msb(["exec", "--tty", name, "--", ...command], { inherit: true, timeoutMs: undefined });
    return result.code ?? 1;
  }
  async pause(name: string): Promise<void> { await this.checked(["pause", name]); }
  async unpause(name: string): Promise<void> {
    if ((await this.container(name))?.state === "paused") await this.checked(["resume", name]);
  }

  private json(text: string): any {
    try { return JSON.parse(text); } catch { throw new Error("invalid microsandbox response"); }
  }
}
