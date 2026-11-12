import { expect, test } from "bun:test";
import { Lifecycles, nextRestart } from "../../src/app/lifecycle";
import { DEFAULT_LIFECYCLE, DEFAULT_SHUTDOWN_MESSAGE, DEFAULT_WAKE_UP_MESSAGE, describeLifecycle, lifecycleCron, normalLifecycle, type PetLifecycle } from "../../src/core/lifecycle";
import { systemPrompt } from "../../src/core/prompts";

const features = { scouts: false, preview: false, sideworkers: false };

test("a schedule as cron and in words; days the schedule does not use are dropped, default messages left out", () => {
  expect(lifecycleCron(DEFAULT_LIFECYCLE)).toBe("0 4 * * *");
  expect(describeLifecycle(DEFAULT_LIFECYCLE)).toBe("every day at 04:00");
  const weekly: PetLifecycle = { ...DEFAULT_LIFECYCLE, every: "weekly", weekday: "sunday", at: "23:30" };
  expect(lifecycleCron(weekly)).toBe("30 23 * * 0");
  expect(describeLifecycle(weekly)).toBe("every Sunday at 23:30");
  const monthly: PetLifecycle = { ...DEFAULT_LIFECYCLE, every: "monthly", day: 2 };
  expect(lifecycleCron(monthly)).toBe("0 4 2 * *");
  expect(describeLifecycle(monthly)).toBe("on the 2nd of every month at 04:00");
  expect(normalLifecycle({ ...DEFAULT_LIFECYCLE, weekday: "friday", day: 3, wakeUp: ` ${DEFAULT_WAKE_UP_MESSAGE} `, shutdown: "Bye" })).toEqual({ ...DEFAULT_LIFECYCLE, shutdown: "Bye" });
  expect(normalLifecycle({ ...DEFAULT_LIFECYCLE, every: "weekly" })).toEqual({ ...DEFAULT_LIFECYCLE, every: "weekly", weekday: "monday" });
});

test("the next restart is in the household's timezone", () => {
  const after = Date.parse("2026-11-08T12:00:00Z");
  expect(new Date(nextRestart(DEFAULT_LIFECYCLE, "UTC", after)).toISOString()).toBe("2026-11-09T04:00:00.000Z");
  expect(new Date(nextRestart(DEFAULT_LIFECYCLE, "Europe/Madrid", after)).toISOString()).toBe("2026-11-09T03:00:00.000Z");
});

test("a pet's prompt tells it about its restarts only while they are on", () => {
  const on = systemPrompt({ role: { kind: "pet" }, features, lifecycle: DEFAULT_LIFECYCLE });
  // No zone of its own: each message's household-clock says it, so a new zone changes no instructions (no restart).
  expect(on).toContain("Scheduled restarts\n- Household restarts your VM and starts a new session every day at 04:00, Household time (the timezone in each message's household-clock).");
  expect(on).toContain("Up to 5 minutes before a restart you get a shutdown notice");
  expect(on).toContain("wake-up message");
  expect(systemPrompt({ role: { kind: "pet" }, features, lifecycle: { ...DEFAULT_LIFECYCLE, enabled: false } })).not.toContain("Scheduled restarts");
  expect(systemPrompt({ role: { kind: "pet" }, features })).not.toContain("Scheduled restarts");
});

/** A scheduler on a clock the test moves, recording what it does. */
function setup(lifecycle: PetLifecycle, start: string, restart?: () => Promise<void>) {
  let now = Date.parse(start);
  const calls: string[] = [];
  const notices: { text: string; timeoutMs: number }[] = [];
  let pets = [{ house: "work", pet: "sibling", lifecycle }];
  const scheduler = new Lifecycles({
    pets: () => pets,
    timezone: () => "UTC",
    restart: async (house, pet, notice) => {
      calls.push(`restart ${house}/${pet}`);
      notices.push(notice);
      await restart?.();
    },
    wakeUp: (house, pet, text) => calls.push(`wake ${house}/${pet}: ${text}`),
    log: () => {},
    error: (message) => calls.push(`error ${message}`),
    clock: { now: () => now, after: () => () => {} },
  });
  return {
    scheduler, calls, notices,
    at: (time: string) => { now = Date.parse(time); scheduler.tick(); },
    setPets: (next: typeof pets) => { pets = next; },
  };
}

test("the shutdown notice goes out its notice before the time, the wake-up message after the restart, once a day", async () => {
  const { calls, notices, at, scheduler } = setup(DEFAULT_LIFECYCLE, "2026-11-08T12:00:00Z");
  at("2026-11-08T12:00:00Z");
  expect(new Date(scheduler.next("work", "sibling")!).toISOString()).toBe("2026-11-09T04:00:00.000Z");
  at("2026-11-09T03:54:59Z");
  expect(calls).toEqual([]);
  at("2026-11-09T03:55:00Z");
  await Bun.sleep(0);
  expect(calls).toEqual(["restart work/sibling", `wake work/sibling: ${DEFAULT_WAKE_UP_MESSAGE}`]);
  expect(notices).toEqual([{ text: DEFAULT_SHUTDOWN_MESSAGE, timeoutMs: 5 * 60_000 }]);
  at("2026-11-09T03:59:00Z");
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  expect(new Date(scheduler.next("work", "sibling")!).toISOString()).toBe("2026-11-10T04:00:00.000Z");
});

test("a restart missed while the daemon was down is not caught up; one inside the notice gets what time is left", async () => {
  const { calls, notices, at } = setup({ ...DEFAULT_LIFECYCLE, shutdown: "Wrap up" }, "2026-11-09T03:58:00Z");
  at("2026-11-09T03:58:00Z");
  await Bun.sleep(0);
  expect(notices).toEqual([{ text: "Wrap up", timeoutMs: 2 * 60_000 }]);
  const late = setup(DEFAULT_LIFECYCLE, "2026-11-09T04:30:00Z");
  late.at("2026-11-09T04:30:00Z");
  await Bun.sleep(0);
  expect(late.calls).toEqual([]);
  expect(calls).toHaveLength(2);
});

test("a failed restart sends no wake-up message; a changed schedule is planned anew; a pet switched off is forgotten", async () => {
  const { calls, at, scheduler, setPets } = setup(DEFAULT_LIFECYCLE, "2026-11-08T12:00:00Z", () => Promise.reject(new Error("pet is already restarting")));
  at("2026-11-08T12:00:00Z");
  at("2026-11-09T03:56:00Z");
  await Bun.sleep(0);
  expect(calls).toEqual(["restart work/sibling", "error bot work/sibling: scheduled restart failed: pet is already restarting"]);
  setPets([{ house: "work", pet: "sibling", lifecycle: { ...DEFAULT_LIFECYCLE, every: "weekly", weekday: "friday" } }]);
  at("2026-11-09T05:00:00Z");
  expect(new Date(scheduler.next("work", "sibling")!).toISOString()).toBe("2026-11-13T04:00:00.000Z");
  setPets([{ house: "work", pet: "sibling", lifecycle: { ...DEFAULT_LIFECYCLE, enabled: false } }]);
  at("2026-11-09T05:01:00Z");
  expect(scheduler.next("work", "sibling")).toBeUndefined();
});
