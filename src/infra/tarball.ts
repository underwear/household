import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { HouseholdError } from "../core/errors";
import { runCommand } from "./process";

const TIMEOUT_MS = 10 * 60_000;
/** macOS tar would add `._*` files for extended attributes; GNU tar ignores this. */
const ENV = { COPYFILE_DISABLE: "1" };

/** Packs the contents of `dir` into gzipped tar `file` (which may exist already: it is written over). */
export async function packDir(dir: string, file: string): Promise<void> {
  const result = await runCommand(["tar", "-czf", file, "-C", dir, "."], { timeoutMs: TIMEOUT_MS, env: ENV });
  if (!result.ok) throw new Error(`tar of ${dir} failed: ${result.stderr}`);
}

/**
 * Unpacks gzipped tar `file` into `dir`, unless it would write more than `maxBytes`: the size of the tar inside
 * is counted first (an upper bound of what it unpacks to, whatever tar listed it). tar itself refuses absolute
 * paths and `..` in the archive.
 */
export async function unpackFile(file: string, dir: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
  if ((await tarSize(file, maxBytes, signal)) > maxBytes) {
    throw new HouseholdError(`${file} unpacks to more than ${maxBytes} bytes; not unpacked`);
  }
  const result = await runCommand(["tar", "-xzf", file, "-C", dir], { timeoutMs: TIMEOUT_MS, env: ENV, signal });
  if (!result.ok) throw new Error(`cannot unpack ${file}: ${result.stderr}`);
}

/** Bytes of the tar inside gzipped `file`, counted until they pass `cap`. */
async function tarSize(file: string, cap: number, signal?: AbortSignal): Promise<number> {
  const gunzip = createGunzip();
  createReadStream(file)
    .on("error", (error) => gunzip.destroy(error))
    .pipe(gunzip);
  let bytes = 0;
  try {
    for await (const chunk of gunzip) {
      bytes += (chunk as Buffer).length;
      if (bytes > cap || signal?.aborted) break;
    }
  } catch (error) {
    throw new HouseholdError(`cannot unpack ${file}: ${(error as Error).message}`);
  } finally {
    gunzip.destroy();
  }
  return bytes;
}
