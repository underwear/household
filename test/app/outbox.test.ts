import { expect, test } from "bun:test";
import { outboxTool } from "../../src/app/outbox";

const caller = { house: "home", pet: "worker" };
const log = { info() {}, error() {} };

test("send_file reads authenticated pet home and forwards native media and channel", async () => {
  const reads: unknown[] = [], sent: unknown[] = [];
  const tool = outboxTool({ async read(...args) { reads.push(args); return new Uint8Array([1, 2]); } },
    { async sendAttachment(...args) { sent.push(args); return { id: "m1", channel: "c2" }; } }, log);
  expect(JSON.parse(await tool.call(caller, { path: "nested/voice.ogg", kind: "voice", caption: "Hello", channel: "c2" }))).toEqual({ id: "m1", channel: "c2" });
  expect(reads).toEqual([["household.home.worker.home", "nested/voice.ogg", 50 * 1024 * 1024]]);
  expect(sent).toEqual([["home", "worker", { kind: "voice", name: "voice.ogg", bytes: new Uint8Array([1, 2]), caption: "Hello" }, "c2", undefined]]);
});

test("invalid arguments and unreadable paths never send", async () => {
  let sends = 0;
  const tool = outboxTool({ async read() { throw new Error("unsafe path"); } },
    { async sendAttachment() { sends++; return { id: "m1", channel: "c1" }; } }, log);
  for (const args of [{}, { path: "x", kind: "video" }, { path: "x", caption: "a".repeat(1025) }, { path: "x", channel: 5 }, { path: "../secret" }]) {
    await expect(tool.call(caller, args)).rejects.toThrow();
  }
  expect(sends).toBe(0);
});

test("a scout's send_file reads its own home, kept in its run's storage", async () => {
  const reads: unknown[] = [];
  const pets = { async read() { throw new Error("not a pet's home"); } };
  const runHome = { async read(...args: unknown[]) { reads.push(args); return new Uint8Array([7]); } };
  const tool = outboxTool(pets, { async sendAttachment() { return { id: "m9", channel: "c1" }; } }, log,
    (house, pet) => house === "home" && pet === "scout-1" ? { files: runHome, volume: "home" } : undefined);
  await tool.call({ house: "home", pet: "scout-1" }, { path: "video.mp4" });
  expect(reads).toEqual([["home", "video.mp4", 50 * 1024 * 1024]]);
  await expect(tool.call(caller, { path: "x" })).rejects.toThrow("not a pet's home"); // a pet: its own home as before
});
