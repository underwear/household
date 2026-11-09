import { AGENT_TOOL_ENV } from "../core/install-env";
import { effectivePetHome } from "../core/household";
import { petResources } from "../core/resources";
import type { EnvironmentPhase } from "../core/environment";
import type { PetInstructions } from "../infra/pet-instructions";
import { HouseSkills, GUEST_SKILLS, BUILTIN_SKILLS, GUEST_BUILTIN_SKILLS, PERSONAL_SKILLS } from "../infra/house-skills";
import { knownAgents } from "./agents";
import { createHash } from "node:crypto";
import type { AgentAdapter, Exec } from "../core/agent";
import type { ContainerInfo, ContainerRuntime, ContainerSpec, Mount, PetRuntime } from "../infra/runtime";
import type { PlacedPet } from "./agents";

/** House and pet names cannot contain `.`, so no two (house, pet) pairs share a container or volume name. */
export const petContainer = (house: string, pet: string) => `household.${house}.${pet}`;
/** The pet's `$HOME`: its memory, kept when its container goes. */
export const petVolume = (house: string, pet: string) => `${petContainer(house, pet)}.home`;
/** The pet's Docker disk (images, containers, named volumes): kept when its VM is recreated, removed with the pet. */
export const petDockerDisk = (house: string, pet: string) => `${petContainer(house, pet)}.docker`;
export const agentImage = (agent: AgentAdapter) => `household-agent-${agent.name}`;

const LABEL = { owner: "household.owner", house: "household.house", pet: "household.pet", identity: "household.identity", launch: "household.launch" };
/** Runtime states of a pet that lives: a paused one (an export reading its home) is not recreated. */
const ALIVE = new Set(["running", "paused"]);

/**
 * What a change to a pet does to its VM, by what it touches; reconcile follows this and nothing else.
 * - Identity: the image it boots, its mounts (home, house skills, CA, Docker disk), the gateway ports its network
 *   rules open. Fixed when the VM is created, so a change is a new VM (`recreate`). Its home and its
 *   Docker disk (images, containers, named volumes) carry over; its root filesystem (packages installed outside
 *   home) does not. A stopped or exited VM of an enabled pet is replaced the same way: the pet is meant to run.
 * - Launch configuration: its environment (Household's instructions, model, reasoning effort, mode, the placeholders
 *   of its key and secrets, its gateway token). The same VM restarts with the new one (`relaunch`).
 * - Resources (CPUs, memory) are staged on the same VM for its next boot, saved environment scripts for its next
 *   start: neither restarts it.
 * Otherwise a live VM is kept as it is (`adopt`), a stopped or exited one started (`start`), a missing one created.
 */
export type PetChange = "create" | "recreate" | "relaunch" | "start" | "adopt";

export function petChange(current: ContainerInfo | undefined, wanted: { identity: string; launch: string }): PetChange {
  if (!current) return "create";
  const alive = ALIVE.has(current.state);
  if (current.labels[LABEL.identity] !== wanted.identity) return "recreate";
  if (current.labels[LABEL.launch] !== wanted.launch) return "relaunch";
  return alive ? "adopt" : "start";
}

/** A pet's VM as Household wants it, with the hashes of its identity and launch configuration. */
interface PetVm {
  spec: ContainerSpec;
  identity: string;
  launch: string;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** Short stable id of a Household instance, from its state dir; its pets carry it as a label. */
export function instanceId(stateDir: string): string {
  return createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
}

/** The instance a container belongs to, by its label; undefined when it is not Household's. */
export const ownerOf = (info: ContainerInfo): string | undefined => info.labels[LABEL.owner];
/** Where pets see Household's CA certificate. */
const PET_CA_CERT = "/etc/household/ca.crt";
const PET_LIMITS = { pids: 512, memory: "2g" };
/** Room for the pet's Docker images, containers and named volumes. */
const DOCKER_DISK_SIZE = "10G";

export interface PetStatus {
  house: string;
  pet: string;
  agent: string;
  container: string;
  /** Runtime state, or `missing`. */
  state: string;
}

/** Whether a (re)started pet got ready. */
export interface PetStart {
  house: string;
  pet: string;
  ready: boolean;
  /** What the readiness check saw when the pet did not get ready, for the log. */
  output?: string;
  /** What the agent's readiness check found amiss, though it is ready (another permission mode), for the log. */
  warning?: string;
}

export interface PetTransport {
  host: string;
  proxyPort: number;
  relayPort: number;
  tokenFor(pet: { house: string; pet: string }): string;
}

type ExecutionRuntime = PetRuntime & Pick<ContainerRuntime, "prepareImage">;

/**
 * One isolated VM per pet, labelled with house, pet and the hashes of its identity and launch configuration; what a
 * change to either does is `petChange`'s. This instance's VMs of pets no longer in the config are removed with their
 * Docker disks. Homes stay.
 */
export class PetPlane {
  /** Agent name → image id, built once per daemon run. */
  private readonly images = new Map<string, { ref: string; id: string }>();
  private waiting = true;
  private readonly terminalReads = new Map<string, Promise<{ text: string } | undefined>>();

  /** Label selecting the pets of this Household instance. */
  private readonly mine: string;

  constructor(
    private readonly runtime: ExecutionRuntime,
    /** Host path of Household's CA certificate. */
    private readonly caCert: string,
    /**
     * Identifies this Household instance (its state dir), so cleanup never touches pets another config runs,
     * e.g. the e2e run's versus the real ones.
     */
    private readonly owner: string,
    private readonly readyTimeoutMs = 60_000,
    /** How a pet reaches the gateway: its host, ports, and the pet's token. */
    private readonly transport: PetTransport,
    private readonly skills?: HouseSkills,
    private readonly instructions?: PetInstructions,
  ) {
    this.mine = `${LABEL.owner}=${owner}`;
  }

  private beforeStop: (house: string, pet: string) => Promise<void> = async () => {};
  onBeforeStop(callback: (house: string, pet: string) => Promise<void>) { this.beforeStop = callback; }

  /**
   * Starts what is missing without waiting for it (see `awaitReady`); `onStopped` hears of each running VM it
   * stops or replaces. Resolves to the started pets and the removed VMs.
   */
  async reconcile(
    pets: PlacedPet[],
    onStopped: (pet: { house: string; pet: string }) => Promise<void> = async () => {},
  ): Promise<{ started: PlacedPet[]; removed: string[] }> {
    const existing = new Map((await this.runtime.listContainers(this.mine)).map((info) => [info.name, info]));
    const wanted = new Set(pets.map(({ house, pet }) => petContainer(house, pet)));
    for (const name of wanted) {
      const present = existing.get(name) ?? await this.runtime.container(name);
      if (present && ownerOf(present) !== this.owner) throw new Error(`bot runtime ${name} belongs to another Household; refusing to replace it`);
    }
    const removed: string[] = [];
    for (const [name, info] of existing) {
      if (wanted.has(name)) continue;
      const house = info.labels[LABEL.house], pet = info.labels[LABEL.pet];
      if (house && pet) await this.beforeStop(house, pet);
      await this.runtime.removeContainer(name);
      if (house && pet) await this.runtime.removeDisk?.(petDockerDisk(house, pet));
      removed.push(name);
    }
    const started: PlacedPet[] = [];
    for (const placed of pets) {
      const name = petContainer(placed.house, placed.pet);
      const current = existing.get(name);
      if (placed.enabled === false) {
        if (current?.state === "paused") throw new Error("bot VM is paused; finish its backup before disabling");
        if (current && current.state !== "stopped") {
          await this.stop(name);
          await onStopped({ house: placed.house, pet: placed.pet });
        }
        if (current && placed.agent.sessionFile) {
          if (!this.runtime.resetSession) throw new Error("runtime cannot reset this harness’s session");
          await this.runtime.resetSession(petVolume(placed.house, placed.pet), placed.agent.sessionFile);
        }
        if (current) await this.runtime.configureResources?.(name, petResources(placed));
        continue; // Retain the VM and disks; do not build or start disabled pets.
      }
      await this.prepareInstructions(placed);
      const vm = await this.vm(placed);
      this.runtime.configureEnvironmentSetup?.(name, placed.scout?.setup ?? placed.environment?.setup, placed.environment?.onStart);
      const change = petChange(current, vm);
      if (change === "create" || change === "recreate") {
        await this.beforeStop(placed.house, placed.pet);
        await this.runtime.removeContainer(name);
        if (current && current.state !== "stopped") await onStopped({ house: placed.house, pet: placed.pet });
        await this.runtime.runContainer(vm.spec);
        started.push(placed);
        continue;
      }
      if (change === "relaunch") {
        if (current!.state !== "stopped") {
          await this.stop(name);
          await onStopped({ house: placed.house, pet: placed.pet });
        }
        await this.applyLaunch(name, current!, vm);
      }
      await this.runtime.configureResources?.(name, petResources(placed));
      if (change === "adopt") continue;
      if (!this.runtime.startContainer) throw new Error("runtime does not support starting a bot VM");
      await this.runtime.startContainer(name);
      started.push(placed);
    }
    return { started, removed };
  }

  private async stop(name: string): Promise<void> {
    if (!this.runtime.stopContainer) throw new Error("runtime does not support stopping a bot VM");
    const identity = /^household\.([^.]+)\.([^.]+)$/.exec(name);
    if (identity) await this.beforeStop(identity[1]!, identity[2]!);
    await this.runtime.stopContainer(name);
  }

  /** Gives a stopped VM its new launch configuration, if it changed; it applies when the VM starts. */
  private async applyLaunch(name: string, current: ContainerInfo, vm: PetVm): Promise<void> {
    if (current.labels[LABEL.launch] === vm.launch) return;
    if (!this.runtime.configureLaunch) throw new Error("runtime does not support changing a bot VM's launch configuration");
    await this.runtime.configureLaunch(name, { env: vm.spec.env ?? {}, labels: { [LABEL.launch]: vm.launch } });
  }

  /** Restarts the same owned VM, on its current launch configuration; never creates/removes it or discards its disks. */
  async restart(placed: PlacedPet, onLeave: () => Promise<void> = async () => {}, onStopped: () => Promise<void> = async () => {}): Promise<void> {
    if (placed.enabled === false) throw new Error("bot is disabled; enable it before restarting");
    const name = petContainer(placed.house, placed.pet);
    const current = await this.runtime.container(name);
    if (!current || ownerOf(current) !== this.owner) throw new Error("bot VM is unavailable or belongs to another Household");
    if (current.state === "paused") throw new Error("bot VM is paused; finish its backup before restarting");
    if (!this.runtime.stopContainer || !this.runtime.startContainer) throw new Error("runtime does not support VM restart");
    if (placed.agent.sessionFile && !this.runtime.resetSession) throw new Error("runtime cannot reset this harness’s session");
    await this.prepareInstructions(placed);
    const vm = await this.vm(placed);
    this.runtime.configureEnvironmentSetup?.(name, placed.scout?.setup ?? placed.environment?.setup, placed.environment?.onStart);
    await onLeave();
    const wasStopped = current.state === "stopped";
    await this.beforeStop(placed.house, placed.pet);
    await this.runtime.stopContainer(name);
    if (!wasStopped) await onStopped();
    if (placed.agent.sessionFile) await this.runtime.resetSession!(petVolume(placed.house, placed.pet), placed.agent.sessionFile);
    await this.applyLaunch(name, current, vm);
    await this.runtime.configureResources?.(name, petResources(placed));
    await this.runtime.startContainer(name);
  }

  /** Existing native files may need manual migration; that must never block VM lifecycle. */
  private async prepareInstructions(placed: PlacedPet): Promise<void> {
    if (placed.scout || placed.sideworker || !this.instructions || !placed.agent.instructionsFile) return;
    try { await this.instructions.read(placed.house, placed.pet, placed.agent.instructionsFile, placed.agent.instructionOverrides); }
    catch (error) { console.warn(`bot ${placed.house}/${placed.pet}: instructions unavailable: ${(error as Error).message}`); }
  }

  /** Waits for each pet to get ready, up to the timeout. */
  async awaitReady(pets: PlacedPet[]): Promise<PetStart[]> {
    const results: PetStart[] = [];
    for (const placed of pets) results.push({ house: placed.house, pet: placed.pet, ...(await this.waitReady(placed)) });
    return results;
  }

  /** Runs commands in a pet's container, each given 5 s unless `timeoutMs` says otherwise. */
  exec(house: string, pet: string, timeoutMs?: number): Exec {
    return (command, stdin) => this.runtime.exec(petContainer(house, pet), command, stdin, timeoutMs);
  }

  /** Reads only the adapter's fixed pane, in an owned running VM. Polls share one in-flight capture. */
  terminalSnapshot(placed: PlacedPet): Promise<{ text: string } | undefined> {
    if (!placed.agent.terminalSnapshot) return Promise.resolve(undefined);
    const name = petContainer(placed.house, placed.pet);
    const pending = this.terminalReads.get(name);
    if (pending) return pending;
    const read = (async () => {
      const info = await this.runtime.container(name);
      if (!info || ownerOf(info) !== this.owner || info.state !== "running") return undefined;
      // Runtime exec has a five-second guest deadline. Never expose transport/guest errors as screen text.
      const result = await this.runtime.exec(name, [...placed.agent.terminalSnapshot!]);
      if (!result.ok) return undefined;
      // Keep the current screen when history is large, starting on a complete UTF-8 character.
      const bytes = Buffer.from(result.output);
      let start = Math.max(0, bytes.length - 64 * 1024);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      return { text: bytes.subarray(start).toString("utf8") };
    })().catch(() => undefined).finally(() => { this.terminalReads.delete(name); });
    this.terminalReads.set(name, read);
    return read;
  }

  /** Re-runs guest setup without interrupting the managed agent or granting host execution. */
  async runEnvironmentSetup(house: string, pet: string, setup?: string, phase: EnvironmentPhase = "setup") {
    const name = petContainer(house, pet);
    const info = await this.runtime.container(name);
    if (!info || ownerOf(info) !== this.owner || info.state !== "running") throw new Error("bot VM is unavailable");
    if (!this.runtime.runEnvironmentSetup) throw new Error("runtime does not support environment setup");
    return this.runtime.runEnvironmentSetup(name, setup, phase);
  }

  /** Controlled startup result, rather than trusting guest-written status as instructions. */
  environmentSetupResult(house: string, pet: string, phase: EnvironmentPhase = "setup") {
    return this.runtime.environmentSetupResult?.(petContainer(house, pet), phase);
  }

  /** Telemetry observes the VM even if its agent process has died. Never polls disabled/foreign VMs. */
  async monitoringStates(pets: PlacedPet[]): Promise<PetStatus[]> {
    const result: PetStatus[] = [];
    for (const placed of pets) {
      const container = petContainer(placed.house, placed.pet);
      let state = "disabled";
      if (placed.enabled !== false) {
        try {
          const info = this.runtime.machine ? await this.runtime.machine(container) : await this.runtime.container(container);
          state = !info ? "missing" : ownerOf(info) === this.owner ? info.state : "unavailable";
        } catch { state = "unavailable"; }
      }
      result.push({ house: placed.house, pet: placed.pet, agent: placed.agent.name, container, state });
    }
    return result;
  }

  /** One inventory normally; a concurrent VM change must not take down the read-only status view. */
  async status(pets: PlacedPet[]): Promise<PetStatus[]> {
    let states: Map<string, string>;
    try {
      states = new Map((await this.runtime.listContainers(this.mine)).map((info) => [info.name, info.state]));
    } catch {
      // Listing and inspecting jobs are separate runtime calls: a VM can stop or disappear between them.
      // Recover each pet independently, without weakening the strict inspection used by reconcile/restart.
      states = new Map(await Promise.all(pets.map(async ({ house, pet }): Promise<[string, string]> => {
        const name = petContainer(house, pet);
        try {
          const info = await this.runtime.container(name);
          return [name, !info ? "missing" : ownerOf(info) === this.owner ? info.state : "unavailable"];
        } catch { return [name, "unknown"]; }
      })));
    }
    return pets.map(({ house, pet, agent, enabled }) => {
      const container = petContainer(house, pet);
      return { house, pet, agent: agent.name, container, state: enabled === false && !ALIVE.has(states.get(container) ?? "") ? "disabled" : states.get(container) ?? "missing" };
    });
  }

  /** Stops waiting for pets to get ready, so a shutdown is not held up by a slow pet. */
  stopWaiting(): void {
    this.waiting = false;
  }

  private async vm(placed: PlacedPet): Promise<PetVm> {
    const { house, pet, agent, model, reasoningEffort, mode, settings, keyUse, secrets = [] } = placed;
    let image = this.images.get(agent.name);
    if (!image) {
      image = await this.runtime.prepareImage(agentImage(agent), agent.imageContext);
      this.images.set(agent.name, image);
    }
    const name = petContainer(house, pet);
    const { host, proxyPort, relayPort } = this.transport;
    const token = this.transport.tokenFor({ house, pet });
    const proxy = `http://household:${token}@${host}:${proxyPort}`;
    const relay = `http://${host}:${relayPort}`;
    const skillsPath = placed.scout?.skillsPath ?? (this.skills && agent.skillsDirectory ? await this.skills.ensure(house) : undefined);
    // The relay is on the house network itself; everything else goes through the proxy. The key is a placeholder of
    // its kind (its value is the gateway's): another key of the same kind changes nothing. Its house's secrets as
    // placeholders, under what Household and the agent set (their names cannot clash: core/secrets.ts reserves those).
    // A secret's value changes only on the gateway.
    const env: Record<string, string> = {
      ...(placed.scout?.env ?? {}),
      ...Object.fromEntries(secrets.map(({ env, placeholder }) => [env, placeholder])),
      // Where root's installs of per-user tools went (Playwright's browsers, rustup's toolchains).
      ...AGENT_TOOL_ENV,
      ...agent.env({ ...(placed.scout ? { home: agent.home, workspace: "/work", scout: true } : {}), ...(placed.sideworker ? { home: effectivePetHome(placed, agent.home), workspace: placed.sideworker.cwd } : {}), caCertPath: PET_CA_CERT, eventsUrl: `${relay}/events`, mcpUrl: `${relay}/mcp`, instructions: placed.instructions ?? "", model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(mode === undefined ? {} : { mode }), ...(settings === undefined ? {} : { settings }) }),
      ...keyUse.env,
      ...(skillsPath ? skillLinks(agent.skillsDirectory!, !placed.sideworker && !placed.scout) : {}),
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NO_PROXY: host,
      no_proxy: host,
      HOUSEHOLD_PET_TOKEN: token,
    };
    const labels = { [LABEL.owner]: this.owner, [LABEL.house]: house, [LABEL.pet]: pet };
    const mounts: Mount[] = [
      ...(skillsPath ? [{ type: "bind" as const, source: skillsPath, target: GUEST_SKILLS }, { type: "bind" as const, source: BUILTIN_SKILLS, target: GUEST_BUILTIN_SKILLS, readOnly: true }] : []),
      ...(placed.scout ? [{ type: "bind" as const, source: placed.scout.homePath, target: agent.home }, { type: "bind" as const, source: `${placed.scout.homePath}/../secrets`, target: "/run/household/secrets", readOnly: true }] : [{ type: "volume" as const, source: petVolume(house, pet), target: effectivePetHome(placed, agent.home) }]),
      ...(placed.sideworker ? [{ type: "volume" as const, source: petVolume(house, placed.sideworker.parent), target: placed.sideworker.parentHome ?? agent.home }] : []),
      { type: "bind", source: this.caCert, target: PET_CA_CERT, readOnly: true },
      { type: "disk", source: petDockerDisk(house, pet), target: "/var/lib/docker", size: DOCKER_DISK_SIZE },
    ];
    // Resource allocations are staged on the same VM, outside its identity.
    const identity = hash({ image: image.ref, imageId: image.id, labels, mounts, gateway: { host, proxyPort, relayPort } });
    const launch = hash(env);
    const { cpus, memoryMiB } = petResources(placed);
    const spec: ContainerSpec = {
      name, image: image.ref, env, labels: { ...labels, [LABEL.identity]: identity, [LABEL.launch]: launch }, mounts,
      cpus, limits: { ...PET_LIMITS, memory: `${memoryMiB}M` },
      ...(placed.environment?.onStart === undefined ? {} : { environmentOnStart: placed.environment.onStart }),
      ...(placed.scout?.setup !== undefined ? { environmentSetup: placed.scout.setup } : placed.environment?.setup === undefined ? {} : { environmentSetup: placed.environment.setup }),
    };
    return { spec, identity, launch };
  }

  private async waitReady({ house, pet, agent, mode }: PlacedPet): Promise<{ ready: boolean; output?: string; warning?: string }> {
    const exec = this.exec(house, pet);
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const { ready, output, warning } = await agent.isReady(exec, mode);
      if (ready) return { ready, ...(warning ? { warning } : {}) };
      if (Date.now() > deadline || !this.waiting) return { ready, output };
      await Bun.sleep(500);
    }
  }
}

/**
 * What the guest skills setup (infra/guest-skills.ts) links, for every harness Household knows, not only the pet's
 * own: a pet that changes agent finds its skills where the new one looks. A sideworker's directory is a project, not
 * its own: no personal skills are linked there.
 */
export function skillLinks(primary: string, personal: boolean): Record<string, string> {
  const agents = [...knownAgents().values()];
  const user = [...new Set(agents.flatMap((agent) => (agent.skillsDirectory ? [agent.skillsDirectory] : [])))];
  const workspace = [...new Set(agents.flatMap((agent) => (agent.workspaceSkillsDirectory ? [`work/${agent.workspaceSkillsDirectory}`] : [])))].filter((path) => path !== PERSONAL_SKILLS);
  return {
    HOUSEHOLD_SKILLS_DIRECTORY: primary,
    HOUSEHOLD_SKILLS_LINKS: user.join(":"),
    ...(personal ? { HOUSEHOLD_WORKSPACE_SKILLS: PERSONAL_SKILLS, HOUSEHOLD_WORKSPACE_SKILLS_LINKS: workspace.join(":") } : {}),
  };
}
