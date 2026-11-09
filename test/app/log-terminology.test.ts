import { expect, test } from "bun:test";
import { logLine, matches } from "../../src/app/household-log";

test("canonical and legacy daemon logs retain workspace and bot filters", () => {
  for (const prefix of ["bot", "pet"]) {
    const line = logLine({ type: "daemon", ts: "2026-11-09T12:00:00Z", level: "info", message: `${prefix} work/helper: started` })!;
    expect(line).toMatchObject({ house: "work", pet: "helper" });
    expect(matches(line, { house: "work", pet: "helper" })).toBe(true);
  }
  for (const prefix of ["workspace", "house"]) {
    const line = logLine({ type: "daemon", ts: "2026-11-09T12:00:00Z", level: "info", message: `${prefix} work: reloaded` })!;
    expect(line.house).toBe("work");
    expect(matches(line, { house: "work" })).toBe(true);
    expect(matches(line, { pet: "helper" })).toBe(false);
  }
});
