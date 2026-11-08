import { readFileSync, writeFileSync } from "node:fs";
import type { ContainerInfo, ContainerRuntime, ContainerSpec } from "../../src/infra/runtime";

interface FakeContainer {
  state: string;
  labels: Record<string, string>;
  /** The environment it launches with: its spec's, then its latest launch configuration's. */
  env?: Record<string, string>;
}

/** A paused VM counts as running, as the runtimes report it. */
const live = (state: string | undefined) => state === "running" || state === "paused";

/** An in-memory VM runtime with named volumes. */
export class FakeRuntime implements ContainerRuntime {
  calls: string[] = [];
  specs: ContainerSpec[] = [];
  /** Set to hold image builds until it resolves. */
  gate: Promise<void> = Promise.resolve();
  /** Part of every image id; bump it to simulate changed image content. */
  imageVersion = 1;
  containers = new Map<string, FakeContainer>();
  /** What `exec` prints in a container. */
  output: (container: string) => string = () => "";

  cancel(): void {
    this.calls.push("cancel");
  }

  async prepareImage(tag: string): Promise<{ ref: string; id: string }> {
    this.calls.push(`build ${tag}`);
    await this.gate;
    return { ref: tag, id: `sha256:${tag}-${this.imageVersion}` };
  }

  async runContainer(spec: ContainerSpec): Promise<void> {
    this.calls.push(`run ${spec.name}`);
    this.specs.push(spec);
    this.containers.set(spec.name, { state: "running", labels: { ...spec.labels }, env: spec.env });
    for (const mount of spec.mounts ?? []) if (mount.type === "disk") this.disks.add(mount.source);
  }

  async stopContainer(name: string): Promise<void> {
    this.calls.push(`stop ${name}`);
    this.containers.get(name)!.state = "stopped";
  }

  async startContainer(name: string): Promise<void> {
    this.calls.push(`start ${name}`);
    this.containers.get(name)!.state = "running";
  }

  /** Like the real one, refuses a VM that runs: its environment would not change before a restart. */
  async configureLaunch(name: string, { env, labels }: { env: Record<string, string>; labels: Record<string, string> }): Promise<void> {
    this.calls.push(`launch ${name}`);
    const container = this.containers.get(name)!;
    if (live(container.state)) throw new Error("stop the pet VM before changing its launch configuration");
    container.env = env;
    Object.assign(container.labels, labels);
  }

  /** Named disks, by name: they outlive the VMs that mount them. */
  disks = new Set<string>();

  async removeDisk(name: string): Promise<void> {
    this.calls.push(`rm disk ${name}`);
    this.disks.delete(name);
  }

  async removeContainer(name: string): Promise<void> {
    this.calls.push(`rm ${name}`);
    this.containers.delete(name);
  }

  async isRunning(name: string): Promise<boolean> {
    return live(this.containers.get(name)?.state);
  }

  async listContainers(label: string): Promise<ContainerInfo[]> {
    const [key = "", value] = label.split("=");
    return [...this.containers]
      .filter(([, container]) => container.labels[key] === value)
      .map(([name, { state, labels }]) => ({ name, state, labels }));
  }

  /** Every exec, as `container: command args` (stdin after ` < `). */
  execs: string[] = [];

  async exec(container: string, command: string[], stdin?: string): Promise<{ ok: boolean; output: string }> {
    this.execs.push(`${container}: ${command.join(" ")}${stdin === undefined ? "" : ` < ${stdin}`}`);
    return { ok: this.containers.has(container), output: this.output(container) };
  }

  async attach(): Promise<number> {
    throw new Error("not in tests");
  }

  /** Named volumes: file path → content. */
  volumes = new Map<string, Record<string, string>>();
  /** Calls that fail, as a cancelled docker call would: `pause` after the container is paused. */
  fail = new Set<"pause" | "save" | "load">();

  async container(name: string): Promise<ContainerInfo | undefined> {
    const container = this.containers.get(name);
    return container && { name, state: container.state, labels: container.labels };
  }

  async pause(container: string): Promise<void> {
    this.calls.push(`pause ${container}`);
    this.containers.get(container)!.state = "paused";
    if (this.fail.has("pause")) throw new Error("cancelled");
  }

  async unpause(container: string): Promise<void> {
    this.calls.push(`unpause ${container}`);
    const found = this.containers.get(container);
    if (found?.state === "paused") found.state = "running";
  }

  async volumeHasFiles(volume: string): Promise<boolean> {
    return Object.keys(this.volumes.get(volume) ?? {}).length > 0;
  }

  /** The "tar" is the volume's files as JSON. */
  async saveVolume(volume: string, file: string): Promise<void> {
    this.calls.push(`save ${volume}`);
    if (this.fail.has("save")) throw new Error("cancelled");
    writeFileSync(file, JSON.stringify(this.volumes.get(volume) ?? {}));
  }

  /** Like the real one, a failure leaves the old files. */
  async loadVolume(volume: string, file: string): Promise<void> {
    this.calls.push(`load ${volume}`);
    if (this.fail.has("load")) throw new Error(`restoring volume ${volume} failed`);
    this.volumes.set(volume, JSON.parse(readFileSync(file, "utf8")));
  }
}
