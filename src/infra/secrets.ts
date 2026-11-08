import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes `values` into `target` (0700), a file each (0600), each beside and renamed (the gateway reads them at any
 * moment). Other files stay: `pruneSecrets` removes them once nothing names them.
 */
export function writeSecrets(target: string, values: Record<string, string>): void {
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o700);
  for (const [name, value] of Object.entries(values)) {
    const tmp = join(target, `.${name}.tmp`);
    writeFileSync(tmp, value, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(target, name));
  }
}

/** Removes every file of `target` but `keep`: what the gateway mounts never holds a value no rule names. */
export function pruneSecrets(target: string, keep: string[]): void {
  for (const file of readdirSync(target)) if (!keep.includes(file)) rmSync(join(target, file), { recursive: true, force: true });
}
