import type { AgentKey } from "../core/keys";
import type { PetIdentity } from "../core/egress";
import type { Endpoint } from "../core/network-policy";
import { sameEndpoint } from "../core/network-policy";
import { describeAllowance, resetTime, spentWindow, type Allowance } from "../core/allowance";
import type { AllowanceReader } from "../core/agent";
import type { KeyValueStore } from "../infra/sqlite-store";
import type { PlacedPet } from "./agents";

/** Where a key's last reading is kept across daemon restarts (one row per key). */
const RECORD = (key: string) => `allowance:${key}`;

/**
 * The allowance meter: what each subscription key has left, as its provider last said, and whether a pet's request
 * on it may go. It sits on the gateway's seams (`Meter` of HostNetworkPlane): `observe` reads every answer through
 * the pet's agent's reader, `guard` refuses a request on a key whose window is used up — unless the owner allowed
 * overage for that key (`keys.<k>.allowOverage`). API keys and agents without a reader are never read nor refused.
 * The last reading survives a restart (KeyValueStore), so a fresh daemon does not let one request slip into overage.
 */
export class KeyAllowances {
  private readonly readings = new Map<string, Allowance>();
  /** `house/pet` → its key and how to read its provider's answers. */
  private pets = new Map<string, { key: string; reader?: AllowanceReader }>();
  private overage = new Set<string>();
  /** Every key's name as of the last `follow`: a key gone since takes its reading along. */
  private known = new Set<string>();
  private readonly announced = new Set<string>();
  private timeZone?: string;

  constructor(
    private readonly store: KeyValueStore | undefined,
    private readonly log: (text: string) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Which key each pet is on and how its agent reads the provider; which keys may spend overage. From every reload. */
  follow(placed: readonly PlacedPet[], keys: readonly AgentKey[], timeZone?: string): void {
    this.timeZone = timeZone;
    this.pets = new Map(placed.map(({ house, pet, key, agent }) => [`${house}/${pet}`, { key, ...(agent.allowance ? { reader: agent.allowance } : {}) }]));
    this.overage = new Set(keys.filter((key) => key.allowOverage).map((key) => key.name));
    const names = new Set(keys.map((key) => key.name));
    for (const key of [...this.known, ...this.readings.keys()]) if (!names.has(key)) { this.readings.delete(key); this.store?.delete(RECORD(key)); }
    this.known = names;
  }

  /** The key's last reading; undefined when its provider never said (an API key, no request yet). */
  of(key: string): Allowance | undefined {
    const held = this.readings.get(key);
    if (held) return held;
    const saved = this.store?.get(RECORD(key));
    if (!saved) return undefined;
    try {
      const parsed = JSON.parse(saved) as Allowance;
      this.readings.set(key, parsed);
      return parsed;
    } catch {
      this.store?.delete(RECORD(key));
      return undefined;
    }
  }

  /** The answer's headers for a pet's request: a reading of its key, when its agent can tell one. */
  observe(pet: PetIdentity, target: Endpoint, headers: Headers): void {
    const placed = this.pets.get(`${pet.house}/${pet.pet}`);
    if (!placed?.reader || !sameEndpoint(placed.reader.target, target)) return;
    const reading = placed.reader.read(headers);
    if (!reading) return;
    this.readings.set(placed.key, reading);
    this.store?.set(RECORD(placed.key), JSON.stringify(reading));
    const spent = spentWindow(reading, this.clock());
    const mark = spent && `${placed.key}:${spent.name}:${spent.resetsAt}`;
    if (mark && !this.announced.has(mark)) {
      this.announced.add(mark);
      this.log(`key '${placed.key}': its ${spent.name} allowance is used up until ${resetTime(spent.resetsAt, this.timeZone)} (${describeAllowance(reading)}); ${this.overage.has(placed.key) ? "overage is allowed for it: requests go on, billed apart" : "requests on it are refused until then (allow overage for the key to go on)"}`);
    }
  }

  /** Why a pet's request to `target` must not go: its key's allowance is used up and overage is off for it. */
  guard(pet: PetIdentity, target: Endpoint): { reason: string; retryAfterMs: number } | undefined {
    const placed = this.pets.get(`${pet.house}/${pet.pet}`);
    if (!placed?.reader || !sameEndpoint(placed.reader.target, target) || this.overage.has(placed.key)) return undefined;
    const reading = this.of(placed.key);
    const spent = reading && spentWindow(reading, this.clock());
    if (!spent) return undefined;
    return {
      reason: `key '${placed.key}': its ${spent.name} subscription allowance is used up until ${resetTime(spent.resetsAt, this.timeZone)}; overage is off for it`,
      retryAfterMs: spent.resetsAt - this.clock(),
    };
  }
}
