import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

const helper = readFileSync(new URL("./pet-outbox-files.py", import.meta.url), "utf8");

/** Reads finished files in a pet's mounted home, without following guest-controlled links. */
export class PetOutboxFiles {
  constructor(private readonly homes: string) {}

  /** `path` is relative to ~/.household/outbox. Reading never deletes the original. */
  async read(volume: string, path: string, maxBytes: number): Promise<Uint8Array> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(volume)) throw new Error("invalid Household home name");
    if (!path || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("path must be relative to ~/.household/outbox, without . or .. components");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid outbox size limit");
    const home = join(await realpath(this.homes), volume);
    const proc = Bun.spawn(["python3", "-c", helper, JSON.stringify({ home, path, maxBytes })], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL",
    });
    const [data, error, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(error.trim() || "outbox storage unavailable");
    return new Uint8Array(data);
  }
}
