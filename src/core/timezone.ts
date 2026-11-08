/** A single clock zone for the entire Household. UTC unless explicitly configured. */
export const householdTimezone = (configured?: string) =>
  configured ?? "UTC";
export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
