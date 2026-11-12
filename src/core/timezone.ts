/** Names Intl gives UTC by: all are said as plain «UTC». */
const UTC_NAMES = new Set(["UTC", "Etc/UTC", "Etc/Universal", "Universal", "Etc/Zulu", "Zulu", "Etc/GMT", "GMT", "Etc/UCT", "UCT"]);

/** This computer's time zone (its TZ, else what the system is set to), «UTC» when it says none it knows. */
export function hostTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || UTC_NAMES.has(zone) || !validTimezone(zone)) return "UTC";
    return zone;
  } catch {
    return "UTC";
  }
}

/** A single clock zone for the entire Household: the one configured, else this computer's. */
export const householdTimezone = (configured?: string, host: () => string = hostTimezone) =>
  configured ?? host();
export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
