import { expect, test } from "bun:test";
import { householdTimezone, hostTimezone } from "../../src/core/timezone";

test("Household's time zone is the configured one, else this computer's", () => {
  expect(householdTimezone("Asia/Tokyo", () => "Europe/Madrid")).toBe("Asia/Tokyo");
  expect(householdTimezone(undefined, () => "Europe/Madrid")).toBe("Europe/Madrid");
  // bun test runs in UTC: Intl calls it Etc/UTC on some systems, said as plain UTC.
  expect(hostTimezone()).toBe("UTC");
});
