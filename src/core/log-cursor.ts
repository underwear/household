import { HouseholdError } from "./errors";

/**
 * Where a follow-up read of a growing log goes on: which log it read (a file's identity, a VM's boot) and how far
 * (a byte offset, a kernel line's time). A log that is no longer `log` was replaced, rotated or booted again.
 */
export interface LogCursor {
  log: string;
  at: number;
}

/** The cursor of a log not there yet: whatever is there by the next read is new. */
export const NO_LOG: LogCursor = { log: "none", at: 0 };

const CURSOR = /^([\w.-]{1,64}):(\d{1,16})$/;

/** «16777232-48213-1a2b3c4d:5120»: a cursor as the API and the CLI pass it on. */
export const formatCursor = ({ log, at }: LogCursor): string => `${log}:${at}`;

/** A cursor from its text; a HouseholdError (so a 400) for text that is none. */
export function parseCursor(text: string): LogCursor {
  const match = CURSOR.exec(text);
  const at = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(at)) throw new HouseholdError("after must be the cursor of a read before");
  return { log: match[1]!, at };
}
