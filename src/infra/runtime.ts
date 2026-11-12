import type { EnvironmentPhase } from "../core/environment";
import type { EnvironmentSetupResult } from "./environment-setup";

/** What Household does with a pet's VM and its storage (MicrosandboxRuntime, host home storage); faked in tests. */
export interface ContainerRuntime {
  /**
   * Makes an agent's image ready to boot: resolves to the reference VMs boot from (the release's in its registry,
   * or `tag` when built here) and its id, which changes whenever the image content does.
   */
  prepareImage(tag: string, contextDir: string): Promise<{ ref: string; id: string }>;
  /** Starts detached, unprivileged; the container is removed when it exits. */
  runContainer(spec: ContainerSpec): Promise<void>;
  /** No-op when the container does not exist. */
  removeContainer(name: string): Promise<void>;
  isRunning(name: string): Promise<boolean>;
  /** All containers (running or not) matching a `key=value` label, in one call. */
  listContainers(label: string): Promise<ContainerInfo[]>;
  /** Runs a command in a running container. A command that does not finish in time (5 s unless given) is killed and fails. */
  exec(container: string, command: string[], stdin?: string, timeoutMs?: number): Promise<{ ok: boolean; output: string }>;
  /** Runs an interactive command in a container on the caller's terminal; resolves to its exit code. */
  attach(container: string, command: string[]): Promise<number>;
  /** A container by name (running or not, Household's or not), or undefined when there is none. */
  container(name: string): Promise<ContainerInfo | undefined>;
  /** Freezes a running container's processes (`docker pause`) until `unpause`; unpausing one not paused is a no-op. */
  pause(container: string): Promise<void>;
  unpause(container: string): Promise<void>;
  /** Whether a named volume exists and has files. */
  volumeHasFiles(volume: string): Promise<boolean>;
  /** Writes the volume's files as a tar to host file `file`, the volume mounted read-only. */
  saveVolume(volume: string, file: string): Promise<void>;
  /**
   * Replaces the volume's files with those of tar `file` (modes and file times kept; owner: the pets' uid; the
   * volume's own dir as it is), creating it if missing. The old files go only once the new ones are all unpacked.
   */
  loadVolume(volume: string, file: string): Promise<void>;
  /** Kills the calls running now (an image build, say), so a shutdown does not wait for them; later calls run. */
  cancel(): void;
}

export interface ContainerSpec {
  name: string;
  image: string;
  /** Saved guest setup; excluded from the lifecycle spec hash. Never passed as environment or labels. */
  environmentSetup?: string;
  environmentOnStart?: string;
  cpus?: number;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  mounts?: Mount[];
  limits?: { pids: number; memory: string };
  /** Skip the guest services (nested Docker and its readiness): a throwaway VM that runs one command needs none. */
  noGuestServices?: boolean;
}

/**
 * A host path (`bind`, must exist), a named home volume (`volume`, created on first use), or a named ext4 disk
 * (`disk`, of `size`, created on first use): a disk outlives the VMs that mount it, until `removeDisk`.
 */
export type Mount =
  | { type: "bind" | "volume"; source: string; target: string; readOnly?: boolean }
  | { type: "disk"; source: string; target: string; size: string };

export interface ContainerInfo {
  /** Physical resident VM maxima, not staged next-boot settings. Absent for stopped VMs. */
  resources?: import("../core/resources").PetResources;
  name: string;
  /** The runtime's state word: running, stopped, paused, … */
  state: string;
  labels: Record<string, string>;
}


/** Image production is independent of the execution runtime (Docker builds, microsandbox imports). */
export interface ImageBuilder {
  buildImage(tag: string, contextDir: string): Promise<string>;
  exportImage(tag: string, file: string): Promise<void>;
  cancel(): void;
}

/** Pet lifecycle and command execution. */
export type PetRuntime = Pick<ContainerRuntime,
  "runContainer" | "removeContainer" | "isRunning" | "listContainers" | "exec" | "attach" | "container" | "pause" | "unpause" | "cancel"
> & {
  /** Stage resource settings on the same VM; applies at its next boot. */
  configureResources?(name: string, resources: import("../core/resources").PetResources): Promise<void>;
  /** Physical VM state independent of the managed agent workload. */
  machine?(name: string): Promise<ContainerInfo | undefined>;
  /** Stop/start the existing VM, preserving its root filesystem and disks. */
  startContainer?(name: string): Promise<void>;
  /**
   * Replaces the environment Household gave a stopped VM (every later exec's, its agent's included) and sets labels:
   * a running VM keeps its environment until it is restarted.
   */
  configureLaunch?(name: string, launch: { env: Record<string, string>; labels: Record<string, string> }): Promise<void>;
  /** Removes a named disk no VM mounts any more; no-op when there is none. */
  removeDisk?(name: string): Promise<void>;
  /** Detach a native resume pointer in a persistent home, only while its VM is stopped. */
  resetSession?(volume: string, file: string): Promise<void>;
  stopContainer?(name: string): Promise<void>;
  /** Reruns user setup in the existing VM without restarting its agent. */
  runEnvironmentSetup?(name: string, setup?: string, phase?: EnvironmentPhase): Promise<EnvironmentSetupResult>;
  /** Refreshes the saved setup for future startup, including adopted VMs; no guest execution. */
  configureEnvironmentSetup?(name: string, setup?: string, onStart?: string): void;
  /** Last completed setup result from this runtime instance, without guest IO. */
  environmentSetupResult?(name: string, phase?: EnvironmentPhase): EnvironmentSetupResult | undefined;
};

/** Home storage is independent of the machine that runs a pet. */
export type StorageRuntime = Pick<ContainerRuntime, "volumeHasFiles" | "saveVolume" | "loadVolume">;
