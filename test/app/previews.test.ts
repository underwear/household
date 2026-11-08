import { describe, test, expect } from "bun:test";
import { Previews, PREVIEW_TTL_MS, PREVIEW_WAIT_MS } from "../../src/app/previews";
import type { House } from "../../src/core/household";
import type { OwnerCard } from "../../src/app/chat";
const caller = { house: "work", pet: "pet" };
const input = { port: 3000, title: "App", reason: "Review page" };
const tick = () => new Promise(r => setTimeout(r, 0));
function fixture() {
  let now = 0, opened = 0, closed = 0;
  const timers = new Map<() => void, number>();
  const house: House = { name: "work", features: { preview: true }, network: { kind: "allowlist", allow: [] }, pets: [{ name: "pet" }, { name: "other" }], channels: [], people: { owners: [] } };
  const cards: { card: OwnerCard<any>; answer(state: any): void }[] = [];
  const notices: string[] = [], logs: string[] = [];
  let fail = false;
  const service = new Previews({ house: () => house, ready: async () => true,
    clock: { now: () => now, after: (ms, fn) => { timers.set(fn, now + ms); return () => { timers.delete(fn); }; } },
    open: async () => { if (fail) throw new Error("port refused"); opened++; return { url: "http://127.0.0.1:43210", close: async () => { closed++; } }; },
    choose: async (_, card, signal) => new Promise(resolve => { cards.push({ card, answer: resolve }); signal.addEventListener("abort", () => resolve(undefined)); }),
    notify: (_, text) => { notices.push(text); }, log: (_, text) => { logs.push(text); },
  });
  return { service, house, cards, notices, logs, fail: () => { fail = true; }, get opened() { return opened; }, get closed() { return closed; },
    advance: async (ms: number) => { now += ms; for (const [fn, at] of timers) if (at <= now) { timers.delete(fn); fn(); } await tick(); },
    decide: async (index = 0, cardIndex = 0) => { const c = cards[cardIndex]!; const result = await c.card.act!(c.card.start, index); c.answer(result); await tick(); return result; },
  };
}
describe("HTTP previews", () => {
  test("approval first, duplicate calls preserve deadline, expiry closes and republication asks again", async () => {
    const f = fixture(); const requested = f.service.request(caller, input);
    expect(requested.status).toBe("pending"); expect(f.opened).toBe(0);
    expect(f.service.request(caller, input).id).toBe(requested.id); expect(f.cards.length).toBe(1);
    const result = await f.decide(); expect(result.text).toContain("Open for 15 minutes:"); expect(f.opened).toBe(1);
    const active = f.service.list(caller)[0]!; expect(active.expires_at).toBe(new Date(PREVIEW_TTL_MS).toISOString());
    await f.advance(1000); expect(f.service.request(caller, input).expires_at).toBe(active.expires_at);
    await f.advance(PREVIEW_TTL_MS); expect(f.closed).toBe(1); expect(f.service.list(caller)).toEqual([]);
    f.service.request(caller, input); expect(f.cards.length).toBe(2); expect(f.opened).toBe(1); await f.service.stop();
  });
  test("denial, timeout and opening failure do not leave listeners", async () => {
    const f = fixture(); f.service.request(caller, input); await f.decide(1); expect(f.opened).toBe(0);
    f.service.request(caller, input); await f.advance(PREVIEW_WAIT_MS); expect(f.service.list(caller)).toEqual([]);
    f.service.request(caller, input); f.fail(); const result = await f.decide(0, 2); expect(result.text).toContain("could not be opened");
    expect(f.opened).toBe(0); expect(f.service.list(caller)).toEqual([]); await f.service.stop();
  });
  test("disabled feature and cross-pet closure refused; settings changes cancel", async () => {
    const f = fixture(); f.house.features = { preview: false };
    expect(() => f.service.request(caller, input)).toThrow("disabled"); f.house.features.preview = true;
    const pending = f.service.request(caller, input);
    await expect(f.service.close({ ...caller, pet: "other" }, pending.id)).rejects.toThrow("Unknown");
    await f.service.reconcile([{ ...f.house, features: { preview: false } }]);
    expect(f.service.list(caller)).toEqual([]); expect(f.opened).toBe(0); await f.service.stop();
  });
  test("VM stop closes active preview and daemon stop does not restore it", async () => {
    const f = fixture(); f.service.request(caller, input); await f.decide(); await f.service.closePet(caller);
    expect(f.closed).toBe(1); expect(f.logs.at(-1)).toContain("VM stopped"); await f.service.stop();
    expect(() => f.service.request(caller, input)).toThrow();
  });
  test("close during opening waits for the new listener to be destroyed", async () => {
    const opening = Promise.withResolvers<{ url: string; close(): Promise<void> }>();
    let card: OwnerCard<any> | undefined, destroyed = false, closeDone = false;
    const house: House = { name: "work", features: { preview: true }, network: { kind: "allowlist", allow: [] }, pets: [{ name: "pet" }], channels: [], people: { owners: [] } };
    const service = new Previews({ house: () => house, ready: async () => true, open: () => opening.promise,
      choose: async (_, c, signal) => { card = c; return new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined))); }, notify: () => {}, log: () => {} });
    const item = service.request(caller, input);
    const pressed = card!.act!(card!.start, 0); await tick();
    const closing = service.closePet(caller).then(() => { closeDone = true; }); await tick(); expect(closeDone).toBe(false);
    opening.resolve({ url: "http://127.0.0.1:12345", close: async () => { destroyed = true; } });
    await closing; await pressed; expect(destroyed).toBe(true); expect(service.list(caller)).toEqual([]); await service.stop();
  });
  test("port validation never accepts a target address", async () => {
    const f = fixture(); for (const port of [0, 65536, "3000", 1.5, "127.0.0.1:3000"]) expect(() => f.service.request(caller, { ...input, port })).toThrow();
    await f.service.stop();
  });
});
