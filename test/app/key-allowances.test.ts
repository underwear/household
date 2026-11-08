import { expect, test } from "bun:test";
import type { AgentAdapter } from "../../src/core/agent";
import type { KeyValueStore } from "../../src/infra/sqlite-store";
import { KeyAllowances } from "../../src/app/key-allowances";
import type { PlacedPet } from "../../src/app/agents";
import { knownAgents } from "../../src/app/agents";

const anthropic = { host: "api.anthropic.com", port: 443 };
const claude = knownAgents().get("claude-code-tmux")!;
/** An agent whose provider says nothing of allowances (no reader). */
const mute: AgentAdapter = { ...claude, name: "mute", allowance: undefined };
const placed = (pet: string, key: string, agent: AgentAdapter = claude) => ({ house: "work", pet, key, agent } as unknown as PlacedPet);
const keys = (allowOverage?: boolean) => [{ name: "sub", provider: "anthropic" as const, value: "sk-ant-oat01-x", ...(allowOverage ? { allowOverage } : {}) }, { name: "api", provider: "anthropic" as const, value: "sk-ant-api03-x" }];
const answer = (utilization: string, reset = "1794236400") => new Headers({
  "anthropic-ratelimit-unified-7d-utilization": utilization, "anthropic-ratelimit-unified-7d-reset": reset, "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-5h-reset": "1794147600",
});
const memory = (): KeyValueStore & { rows: Map<string, string> } => {
  const rows = new Map<string, string>();
  return { rows, get: (key) => rows.get(key), set: (key, value) => void rows.set(key, value), delete: (key) => void rows.delete(key) };
};
let now = 1_794_000_000_000;

test("a key's allowance is read off its pets' answers; a used-up window refuses the key's pets until it resets, unless overage is allowed", () => {
  const log: string[] = [];
  const meter = new KeyAllowances(memory(), (text) => log.push(text), () => now);
  meter.follow([placed("sibling", "sub"), placed("chair", "sub"), placed("payg", "api")], keys(), "Europe/Madrid");
  const sibling = { house: "work", pet: "sibling" };
  expect(meter.guard(sibling, anthropic)).toBeUndefined(); // nothing read yet
  meter.observe(sibling, anthropic, answer("0.99"));
  expect(meter.of("sub")).toMatchObject({ windows: [{ name: "5h" }, { name: "7d", utilization: 0.99 }] });
  expect(meter.guard(sibling, anthropic)).toBeUndefined();
  expect(log).toEqual([]);
  meter.observe(sibling, anthropic, answer("1.0"));
  // Both pets on the key stop, with when to try again; the owner is told once per window.
  expect(meter.guard(sibling, anthropic)).toEqual({ reason: "key 'sub': its 7d subscription allowance is used up until Mon 16:00; overage is off for it", retryAfterMs: 1_794_236_400_000 - now });
  expect(meter.guard({ house: "work", pet: "chair" }, anthropic)).toMatchObject({ reason: expect.stringContaining("key 'sub'") });
  expect(log).toEqual(["key 'sub': its 7d allowance is used up until Mon 16:00 (5h 10% · 7d 100%); requests on it are refused until then (allow overage for the key to go on)"]);
  meter.observe(sibling, anthropic, answer("1.0"));
  expect(log).toHaveLength(1);
  // Another host of the same pet, and a pet on an API key (its answers carry no allowance): never held.
  expect(meter.guard(sibling, { host: "github.com", port: 443 })).toBeUndefined();
  meter.observe({ house: "work", pet: "payg" }, anthropic, new Headers({ "request-id": "x" }));
  expect(meter.of("api")).toBeUndefined();
  expect(meter.guard({ house: "work", pet: "payg" }, anthropic)).toBeUndefined();
  // The window started over: the hold lifts by itself.
  now = 1_794_236_400_001;
  expect(meter.guard(sibling, anthropic)).toBeUndefined();
  now = 1_794_000_000_000;
  // The owner allows overage for the key: its pets go on, and the log says so for the next window.
  meter.follow([placed("sibling", "sub")], keys(true));
  expect(meter.guard(sibling, anthropic)).toBeUndefined();
  meter.observe(sibling, anthropic, answer("1.0", "1794841200"));
  expect(log[1]).toContain("overage is allowed for it: requests go on, billed apart");
});

test("the last reading survives a restart; an agent without a reader is never metered; a removed key's reading goes", () => {
  const store = memory();
  const first = new KeyAllowances(store, () => {}, () => now);
  first.follow([placed("sibling", "sub")], keys());
  first.observe({ house: "work", pet: "sibling" }, anthropic, answer("1.0"));
  const second = new KeyAllowances(store, () => {}, () => now);
  second.follow([placed("sibling", "sub")], keys());
  expect(second.guard({ house: "work", pet: "sibling" }, anthropic)).toMatchObject({ reason: expect.stringContaining("used up") });
  const third = new KeyAllowances(store, () => {}, () => now);
  third.follow([placed("quiet", "sub", mute)], keys());
  third.observe({ house: "work", pet: "quiet" }, anthropic, answer("1.0"));
  expect(third.guard({ house: "work", pet: "quiet" }, anthropic)).toBeUndefined();
  expect(store.rows.has("allowance:sub")).toBe(true);
  third.follow([], [keys()[1]!]);
  expect(store.rows.has("allowance:sub")).toBe(false);
  expect(third.of("sub")).toBeUndefined();
  // A corrupt row is dropped, not thrown.
  store.set("allowance:api", "{nope");
  expect(third.of("api")).toBeUndefined();
  expect(store.rows.has("allowance:api")).toBe(false);
});
