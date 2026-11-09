import type { InboxEventStore } from "../infra/inbox-event-store";
import { HouseholdError } from "../core/errors";
import { createHash } from "node:crypto";
import { InboxPollError, inboxMetadataSchema, houseInboxSchema, pollResultSchema, type HouseInbox, type InboxItem, type InboxState, type InboxView } from "../core/house-inboxes";
import type { House } from "../core/household";
import type { KeyValueStore } from "../infra/sqlite-store";
import { pollInbox, type Poller } from "../infra/inbox-pollers";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceIdentity = (source: HouseInbox["source"]) => {
  if (source.kind === "telegram-bot") return hash({ kind: source.kind, bot: source.token.split(":")[0] });
  const { password, headers, ...identity } = source as HouseInbox["source"] & { password?: string; headers?: Record<string, string> };
  return hash(identity);
};
const empty = (fingerprint: string): InboxState => ({ fingerprint, initialized: false, seen: [], pending: [], recent: [], nextCheck: 0, failures: 0 });
const stateKey = (house: string, name: string) => `house.inboxes.v1.${house}/${name}`;

/** One host poller per mailbox. Persist source progress and pending delivery before any chat/VM work. */
export class HouseInboxes {
  private houses: House[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private blocked = new Set<string>();
  private finished = new Map<string, Promise<void>>();
  private active = new Map<string, AbortController>();
  constructor(
    private readonly store: KeyValueStore,
    private readonly deliver: {
      post(house: string, inbox: HouseInbox, item: InboxItem): Promise<void>;
      pet(house: string, inbox: HouseInbox, pet: string, item: InboxItem): void;
    },
    private readonly poll: Poller = pollInbox,
    private readonly now: () => number = Date.now,
    private readonly history?: InboxEventStore,
  ) {}
  setHouses(houses: House[]) {
    this.houses = houses;
    for (const [key, controller] of this.active) {
      const found = houses.flatMap(h => (h.inboxes ?? []).map(i => ({ key: stateKey(h.name, i.name), inbox: i }))).find(i => i.key === key);
      if (!found?.inbox.enabled) controller.abort();
    }
  }
  private config(house: string, name: string) {
    const inbox = this.houses.find(h => h.name === house)?.inboxes?.find(i => i.name === name);
    if (!inbox) throw new HouseholdError("Inbox not found");
    return inbox;
  }
  private state(house: string, inbox: HouseInbox): InboxState {
    const fingerprint = sourceIdentity(inbox.source);
    const raw = this.store.get(stateKey(house, inbox.name));
    const saved = raw ? JSON.parse(raw) as InboxState : undefined;
    return saved?.fingerprint === fingerprint ? saved : empty(fingerprint);
  }
  list(house: string): InboxView[] {
    return (this.houses.find(h => h.name === house)?.inboxes ?? []).map(inbox => {
      const { cursor, seen, pending, fingerprint, ...status } = this.state(house, inbox);
      return { inbox, status: { ...status, pendingCount: pending.length, running: this.active.has(stateKey(house, inbox.name)) } };
    });
  }
  async edit<T>(house: string, name: string, action: () => Promise<T>, remove = false): Promise<T> {
    const key = stateKey(house, name);
    if (this.blocked.has(key)) throw new HouseholdError("Inbox settings are being saved");
    this.blocked.add(key);
    try {
      this.active.get(key)?.abort();
      await this.finished.get(key);
      const result = await action();
      if (remove) this.store.delete(key);
      return result;
    } finally { this.blocked.delete(key); }
  }
  assertChange(house: string, input: HouseInbox) {
    const old = this.config(house, input.name);
    if (this.state(house, old).pending.length && (input.channel !== old.channel || sourceIdentity(input.source) !== sourceIdentity(old.source)))
      throw new HouseholdError("Deliver pending events before changing the source or channel, or remove this inbox to discard its pending events.");
  }
  async test(input: HouseInbox): Promise<{ count: number; message: string }> {
    const inbox = houseInboxSchema.parse(input);
    let result;
    try { result = pollResultSchema.parse(await (this.poll.test ?? this.poll)(inbox.source.kind === "health" ? { ...inbox.source, failures: 1 } : inbox.source, undefined, inbox.source.kind === "health" ? "latest" : "new", AbortSignal.timeout(65_000))); }
    catch (error) { throw new HouseholdError(error instanceof InboxPollError ? error.message : "Connection failed. Check the endpoint, TLS, credentials and expected source format."); }
    return { count: result.items.length, message: inbox.source.kind === "health" ? `${result.items[0]?.title ?? "Endpoint checked"}. No events delivered; monitoring state unchanged.` : "Connection works. No events posted, no pet notified, and no polling cursor changed." };
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }
  async stop() {
    clearInterval(this.timer); this.timer = undefined;
    for (const controller of this.active.values()) controller.abort();
    await Promise.all(this.finished.values());
  }
  tick() {
    for (const house of this.houses) for (const inbox of house.inboxes ?? []) {
      if (this.active.size >= 4) return;
      if (!this.blocked.has(stateKey(house.name, inbox.name)) && inbox.enabled && this.state(house.name, inbox).nextCheck <= this.now() && !this.active.has(stateKey(house.name, inbox.name))) void this.run(house.name, inbox.name).catch(() => {});
    }
  }
  async run(house: string, name: string) {
    const inbox = this.config(house, name);
    if (!inbox.enabled) throw new HouseholdError("Resume this inbox before polling");
    const key = stateKey(house, name);
    if (this.blocked.has(key)) throw new HouseholdError("Inbox settings are being saved");
    if (this.active.has(key)) throw new HouseholdError("This inbox is already being checked");
    if (this.active.size >= 4) throw new HouseholdError("Other inboxes are being checked; try again shortly");
    const state = this.state(house, inbox);
    const controller = new AbortController();
    this.active.set(key, controller);
    let finish!: () => void;
    this.finished.set(key, new Promise<void>(resolve => { finish = resolve; }));
    const save = () => this.store.set(key, JSON.stringify(state));
    const current = () => {
      controller.signal.throwIfAborted();
      const current = this.config(house, name);
      if (JSON.stringify(current) !== JSON.stringify(inbox)) throw new Error("Inbox changed during poll");
    };
    try {
      state.lastCheck = new Date(this.now()).toISOString();
      save();
      // Drain first: a failed channel cannot consume unbounded source pages.
      await this.drain(house, inbox, state, save, current);
      current();
      const result = pollResultSchema.parse(await this.poll(inbox.source, state.cursor, inbox.initial, controller.signal));
      current();
      const baseline = !state.initialized && inbox.initial === "new" && !result.baselineHandled;
      const seen = new Set(state.seen);
      for (const raw of result.items) {
        const id = hash([state.fingerprint, raw.id]);
        if (seen.has(id)) continue;
        seen.add(id);
        if (baseline) continue;
        const item = redact(inbox, raw);
        // Source IDs are opaque and never need to be shown to a VM.
        item.id = id;
        this.history?.record(house, inbox, item, this.now());
        state.pending.push({ receivedAt: new Date(this.now()).toISOString(), item, channel: inbox.channel, pets: [...inbox.pets], delivery: inbox.delivery, delivered: [] });
        state.recent.unshift({ id, title: item.title, at: new Date(this.now()).toISOString(), status: "queued" });
      }
      state.seen = [...seen].slice(-5000);
      state.recent = state.recent.slice(0, 50);
      state.cursor = result.cursor;
      state.initialized = true;
      state.lastSuccess = new Date(this.now()).toISOString();
      save();
      await this.drain(house, inbox, state, save, current);
      state.error = undefined;
      state.failures = 0;
    } catch (error) {
      // Do not persist provider/transport exceptions (they can include credentials).
      state.error = controller.signal.aborted ? "Check cancelled; pending events retained." : error instanceof InboxPollError ? error.message : "Check or delivery failed. Verify credentials, source format, channel and pet placement; pending events will retry.";
      state.failures += 1;
    } finally {
      state.nextCheck = this.now() + Math.max(inbox.intervalSeconds, Math.min(3600, inbox.intervalSeconds * Math.max(1, Math.min(8, 2 ** state.failures)))) * 1000;
      // Respect intervals longer than the retry cap on successful polls.
      if (!state.failures) state.nextCheck = this.now() + inbox.intervalSeconds * 1000;
      try { save(); } finally {
        this.active.delete(key);
        this.finished.delete(key);
        finish();
      }
    }
    return this.list(house).find(v => v.inbox.name === name)!;
  }
  private async drain(house: string, inbox: HouseInbox, state: InboxState, save: () => void, current: () => void) {
    while (state.pending.length) {
      current();
      const pending = state.pending[0]!;
      // Explicit destination changes affect future events only. Never silently reroute an old message.
      if (pending.channel !== inbox.channel) throw new Error("Pending events belong to the previous channel");
      this.history?.record(house, { ...inbox, pets: pending.pets, delivery: pending.delivery ?? "announce" }, pending.item, Date.parse(pending.receivedAt ?? state.recent.find(e => e.id === pending.item.id)?.at ?? new Date(this.now()).toISOString()));
      if (!pending.posted) {
        await this.deliver.post(house, { ...inbox, delivery: pending.delivery ?? "announce" }, pending.item);
        pending.posted = true; save();
      }
      for (const pet of pending.pets) {
        current();
        if (pending.delivered.includes(pet) || !inbox.pets.includes(pet)) continue;
        const configured = this.houses.find(h => h.name === house)?.pets.find(p => p.name === pet);
        if (!configured) { pending.delivered.push(pet); save(); continue; }
        this.deliver.pet(house, { ...inbox, delivery: pending.delivery ?? "announce" }, pet, pending.item);
        pending.delivered.push(pet); save();
      }
      const recent = state.recent.find(i => i.id === pending.item.id);
      if (recent) recent.status = "delivered";
      state.pending.shift(); save();
    }
  }
}
/** Prevent a source that echoes its authentication material from forwarding it into a chat or VM. */
function redact(inbox: HouseInbox, item: InboxItem): InboxItem {
  const source = inbox.source;
  const values = source.kind === "telegram-bot" ? [source.token] : "password" in source ? [source.password] : Object.values(source.headers).flatMap(v => [v, v.replace(/^(Bearer|Basic) /i, "")]);
  const clean = (text: string) => {
    for (const value of values.filter(v => v.length > 0).sort((a, b) => b.length - a.length)) text = text.split(value).join("[redacted credential]");
    return text;
  };
  const scrub = (value: unknown): unknown => typeof value === "string" ? clean(value) : Array.isArray(value) ? value.map(scrub) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, v]) => [clean(key), scrub(v)])) : value;
  const metadata = item.metadata ? inboxMetadataSchema.safeParse(scrub(item.metadata)) : undefined;
  return { ...item, ...(metadata ? { metadata: metadata.success ? metadata.data : { truncated: true } } : {}), id: clean(item.id), title: clean(item.title).slice(0,300), text: clean(item.text).slice(0,16000), ...(item.url ? { url: clean(item.url) } : {}) };
}
