import { runCommand, type RunOptions } from "./process";
import type { ImageBuilder } from "./runtime";

const BUILD_TIMEOUT_MS = 30 * 60_000;

/**
 * The host's Docker as the builder of the agents' images: microsandbox imports what it saves. Nothing else of
 * Household runs on Docker.
 */
export class DockerCli implements ImageBuilder {
  /** Aborts the calls running when `cancel` is called; later calls get a fresh one. */
  private running = new AbortController();

  cancel(): void {
    this.running.abort();
    this.running = new AbortController();
  }

  private async dockerOrThrow(args: string[], timeoutMs?: number): Promise<string> {
    const result = await runCommand(["docker", ...args], { timeoutMs, signal: this.running.signal } satisfies RunOptions);
    if (!result.ok) throw new Error(`docker ${args[0]} ${args[1] ?? ""} failed: ${result.stderr}`);
    return result.stdout;
  }

  /** The id is stable while nothing changed: a provenance attestation would make every build a new image. */
  async buildImage(tag: string, contextDir: string): Promise<string> {
    return this.dockerOrThrow(["build", "--quiet", "--provenance=false", "--tag", tag, contextDir], BUILD_TIMEOUT_MS);
  }

  /** An OCI-compatible archive for a runtime other than Docker. */
  async exportImage(tag: string, file: string): Promise<void> {
    await this.dockerOrThrow(["save", "--output", file, tag], BUILD_TIMEOUT_MS);
  }
}
