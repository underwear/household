import { expect, test } from "bun:test";
import { LifecycleProgress } from "../../src/app/lifecycle-progress";
import { fakeClock } from "../helpers";

test("a slow lifecycle step exposes its phase and bot and warns once without abandoning the operation", async () => {
  const clock = fakeClock();
  const progress = new LifecycleProgress(clock);
  const warnings: unknown[] = [];
  progress.onSlow = operation => { warnings.push(operation); };
  let finish!: () => void;
  const pet = { house: "work", pet: "sibling", keyUse: { credential: "private" }, env: { TOKEN: "private" } };
  const work = progress.run("starting VM and agent", () => new Promise<void>(resolve => { finish = resolve; }), pet);
  clock.tick(300_000);
  const expected = { phase: "starting VM and agent", house: "work", pet: "sibling", elapsedMs: 300_000 };
  expect(progress.pending).toEqual([expected]);
  expect(warnings).toEqual([expected]);
  clock.tick(300_000);
  expect(warnings).toHaveLength(1);
  expect(progress.pending).toHaveLength(1);
  finish();
  await work;
  expect(progress.pending).toEqual([]);
});

test("completed and failed steps cancel their diagnostic timers, while parallel steps remain independent", async () => {
  const clock = fakeClock();
  const progress = new LifecycleProgress(clock);
  const warnings: unknown[] = [];
  progress.onSlow = operation => { warnings.push(operation); };
  let finish!: () => void;
  const pending = progress.run("reading VM inventory", () => new Promise<void>(resolve => { finish = resolve; }));
  await expect(progress.run("preparing image", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
  expect(await progress.run("preparing instructions", async () => "done")).toBe("done");
  expect(progress.pending).toEqual([{ phase: "reading VM inventory", elapsedMs: 0 }]);
  clock.tick(300_000);
  expect(warnings).toEqual([{ phase: "reading VM inventory", elapsedMs: 300_000 }]);
  finish();
  await pending;
});
