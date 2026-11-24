import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./process";
import helper from "./pet-inbox-files.py" with { type: "text" };

/**
 * Any name as the inbox stores it: no slashes, control characters or leading dots, at most 190 UTF-8 bytes (room
 * for the «-N» a taken name gets) cut between characters, its extension kept. Senders and accounts name files
 * freely; a file must never be lost after its download because of its name.
 */
export function storableName(original: string): string {
  const name = original.replace(/[/\\\x00-\x1f\x7f]/g, "_").replace(/^[.\s]+/, "").trim() || "file";
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const stem = [...name.slice(0, name.length - suffix.length)];
  while (stem.length && Buffer.byteLength(stem.join("") + suffix) > 190) stem.pop();
  return (stem.join("") || "file") + suffix;
}

const validVolume = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/.test(name);

/**
 * Each pet's inbox in its home on the host (`INBOX_DIR`): the files its messages came with. The home is the
 * guest's, mounted into its VM (owned by the guest user there, whoever owns it here), so every path is walked by
 * the helper descriptor by descriptor, never through a link the pet made.
 */
export class PetInboxFiles {
  constructor(private readonly homes: string) {}

  /**
   * Saves a file in the inbox's directory of `day` (`YYYY-MM-DD`), as `name` or, when that is taken, `name-2`, …;
   * resolves to its path inside the home. Throws when the home or the inbox is not a plain directory.
   */
  async save(volume: string, day: string, name: string, bytes: Uint8Array): Promise<string> {
    if (!validVolume(volume)) throw new Error("invalid Household home name");
    const home = join(await realpath(this.homes), volume);
    return (await this.call({ op: "save", home, day, name: storableName(name) }, bytes)).path as string;
  }

  /** Every home's inbox loses its files older than `before`, and its empty day directories; resolves to how many files went. */
  async sweep(before: Date): Promise<number> {
    const root = await realpath(this.homes).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!root) return 0;
    const homes = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
    if (homes.length === 0) return 0;
    return (await this.call({ op: "sweep", homes, before: before.getTime() / 1000 })).removed as number;
  }

  private async call(operation: object, stdin?: Uint8Array): Promise<Record<string, unknown>> {
    const result = await runCommand(["python3", "-c", helper, JSON.stringify(operation)], { ...(stdin ? { stdin } : {}), timeoutMs: 60_000 });
    if (!result.ok) throw new Error("inbox storage unavailable");
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof value.error === "string") throw new Error(value.error);
    return value;
  }
}
