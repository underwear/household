import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HouseholdError } from "../core/errors";

/**
 * Copies dir `from` into new dir `to` with only its folders (made 0700) and plain files (0600), dotfiles left
 * out. For what an archive brings: a link or anything else is refused, before or midway, so nothing outside
 * `from` is ever read. Resolves to the copied files, relative to `from`.
 */
export function copyPlainTree(from: string, to: string, under = ""): string[] {
  mkdirSync(to, { mode: 0o700 });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith(".")) continue;
    const source = join(from, name);
    if (lstatSync(source).isDirectory()) {
      copied.push(...copyPlainTree(source, join(to, name), join(under, name)));
      continue;
    }
    // Opened without following a link (nor waiting on a fifo), then checked on the open file: what is checked is
    // what is read.
    let fd: number;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw notPlain(source);
      throw error;
    }
    try {
      if (!fstatSync(fd).isFile()) throw notPlain(source);
      writeFileSync(join(to, name), readFileSync(fd), { mode: 0o600, flag: "wx" });
    } finally {
      closeSync(fd);
    }
    copied.push(join(under, name));
  }
  return copied;
}

const notPlain = (path: string) => new HouseholdError(`${path} is not a plain file or folder (a link?): not copied`);
