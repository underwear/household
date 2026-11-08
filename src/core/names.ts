import { HouseholdError } from "./errors";

/** House, key and agent names use the original DNS-safe alphabet. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

/** Pet identifiers also allow underscores in container, home and routing names. */
export const PET_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,30}$/;
export const PET_NAME_HINT = "a–z, 0–9, _ and -; starts with a letter, up to 31.";

export function assertPetName(name: string): void {
  if (!PET_NAME_PATTERN.test(name)) {
    throw new HouseholdError(`invalid pet name '${name}': ${PET_NAME_HINT}`);
  }
}

export function assertName(what: string, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new HouseholdError(`invalid ${what} name '${name}': must match ${NAME_PATTERN.source}`);
  }
}
