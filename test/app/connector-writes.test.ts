import { expect, test } from "bun:test";
import { ConnectorWrites, connectorWriteCard, type ConnectorWriteApproval } from "../../src/app/connector-writes";
import { connectorWriteTools } from "../../src/app/connector-write-tools";
import { SqliteStore } from "../../src/infra/sqlite-store";

const caller = { house: "home", pet: "alice" }, accessible = () => true;
function setup(approval?: ConnectorWriteApproval, lifetime = 600_000) {
  const store = new SqliteStore(":memory:");
  let answer!: (value: "approved" | "denied" | undefined) => void, executions = 0, cards = 0;
  const writes = new ConnectorWrites(store, approval ?? { ask: async () => { cards++; return new Promise(r => { answer = r; }); } }, Date.now, lifetime);
  const input = { caller, provider: "slack" as const, connection: "account", account: "Team", operation: "chat.postMessage", params: { channel: "C123", text: "hello" }, clientRequestId: "same-change", signal: new AbortController().signal, validate: () => {}, execute: async () => { executions++; return { sent: "123.456" }; } };
  return { store, writes, input, answer: (value: "approved" | "denied" | undefined) => answer(value), executions: () => executions, cards: () => cards };
}

test("approval executes once, joins pending duplicates and replays the durable result", async () => {
  const s = setup(), first = s.writes.run(s.input), duplicate = s.writes.run(s.input);
  expect(s.cards()).toBe(1); expect(s.executions()).toBe(0);
  expect(s.writes.status(caller, accessible)[0]!.state).toBe("pending");
  s.answer("approved");
  expect(await first).toEqual(await duplicate);
  expect(await s.writes.run(s.input)).toEqual({ sent: "123.456" });
  const restarted = new ConnectorWrites(s.store);
  expect(await restarted.run(s.input)).toEqual({ sent: "123.456" });
  expect(s.executions()).toBe(1);
  expect(() => restarted.run({ ...s.input, params: { text: "different" } })).toThrow("different parameters");
});

test("denial, no chat, cancellation, expiry and shutdown fail closed, including late approvals", async () => {
  for (const end of ["denied", "no-chat", "cancel", "abort", "expired", "stop"] as const) {
    const s = setup(undefined, end === "expired" ? 5 : undefined), abort = new AbortController();
    const promise = s.writes.run({ ...s.input, signal: abort.signal });
    void promise.catch(() => {});
    const id = s.writes.status(caller, accessible)[0]!.id;
    if (end === "denied") s.answer("denied");
    if (end === "no-chat") s.answer(undefined);
    if (end === "cancel") expect(s.writes.cancel(caller, id, accessible).cancelled).toBe(true);
    if (end === "abort") abort.abort();
    if (end === "stop") s.writes.stop();
    await expect(promise).rejects.toThrow();
    s.answer("approved"); await Promise.resolve();
    expect(s.executions()).toBe(0);
    expect(s.writes.status(caller, accessible)[0]!.state).toBe(end === "denied" ? "denied" : "cancelled");
    if (end !== "stop") await expect(s.writes.run(s.input)).rejects.toThrow();
  }
});

test("access is checked again after approval; failed validation cannot execute", async () => {
  const s = setup(); let valid = true;
  const pending = s.writes.run({ ...s.input, validate: () => { if (!valid) throw new Error("revoked"); } });
  valid = false; s.answer("approved");
  await expect(pending).rejects.toThrow("cancelled"); expect(s.executions()).toBe(0);
});

test("uncertain execution is never retried, even after restart or switching to full access", async () => {
  const s = setup({ ask: async () => "approved" }); let calls = 0;
  const input = { ...s.input, execute: async () => { calls++; throw new Error("private upstream body"); } };
  await expect(s.writes.run(input)).rejects.toThrow("unknown");
  await expect(new ConnectorWrites(s.store).run({ ...input, requireApproval: false })).rejects.toThrow("unknown");
  expect(calls).toBe(1); expect(JSON.stringify(s.writes.status(caller, accessible))).not.toContain("private upstream");
});

test("restart closes pending approvals and marks interrupted submissions unknown", async () => {
  for (const state of ["pending", "executing"] as const) {
    const s = setup();
    s.store.set("house.connectors.writes.v1", JSON.stringify([{ id: "old", ...caller, provider: "slack", connection: "account", state }]));
    const recovered = new ConnectorWrites(s.store);
    expect(recovered.status(caller, accessible)[0]!.state).toBe(state === "pending" ? "cancelled" : "unknown");
    expect(s.executions()).toBe(0);
  }
});

test("history and cancellation are restricted to the requesting bot and its current grants", async () => {
  const s = setup(), pending = s.writes.run(s.input), id = s.writes.status(caller, accessible)[0]!.id;
  for (const stranger of [{ ...caller, pet: "bob" }, { ...caller, house: "other" }]) {
    expect(s.writes.status(stranger, accessible)).toEqual([]);
    expect(() => s.writes.cancel(stranger, id, accessible)).toThrow("unavailable");
  }
  expect(s.writes.status(caller, () => false)).toEqual([]);
  expect(() => s.writes.cancel(caller, id, () => false)).toThrow("unavailable");
  const tools = connectorWriteTools(s.writes, c => c.pet === "alice" ? [{ provider: "slack", id: "account" }] : []);
  expect(tools.every(t => t.available!({ ...caller, pet: "bob" }) === false)).toBe(true);
  const status = await tools[0]!.call(caller, {});
  expect(status).toContain(id);
  s.answer("denied"); await expect(pending).rejects.toThrow("denied");
});

test("approval requires a stable id and complete review; large changes cannot silently truncate", () => {
  const s = setup();
  expect(() => s.writes.run({ ...s.input, clientRequestId: undefined })).toThrow("clientRequestId");
  expect(() => s.writes.run({ ...s.input, params: { text: "x".repeat(129 * 1024) } })).toThrow("too large");
  expect(s.cards()).toBe(0); expect(s.executions()).toBe(0);
});

test("pruned history retains a tombstone and cannot execute the same id again", async () => {
  const s = setup({ ask: async () => "approved" });
  for (let i = 0; i <= 100; i++) await s.writes.run({ ...s.input, clientRequestId: `id-${i}` });
  expect(s.writes.status(caller, accessible)).toHaveLength(100);
  expect(() => s.writes.run({ ...s.input, clientRequestId: "id-0" })).toThrow("history expired");
  expect(s.executions()).toBe(101);
});

test("snapshot preparation is deduplicated and approval displays escaped exact parameters", async () => {
  const s = setup(); let prepared = 0;
  const input = { ...s.input, prepare: async () => { prepared++; return { text: "<b>not markup</b>", recipient: "bob" }; } };
  const first = s.writes.run(input), second = s.writes.run(input);
  await Promise.resolve(); await Promise.resolve();
  const write = s.writes.status(caller, accessible)[0]!, card = connectorWriteCard(write);
  expect(card.text).toContain("&lt;b&gt;not markup&lt;/b&gt;"); expect(card.text).toContain("\n\nExpires in");
  expect(card.text).not.toContain(write.id);
  s.answer("approved"); await first; await second; await s.writes.run(input);
  expect(prepared).toBe(1); expect(s.executions()).toBe(1);
});
