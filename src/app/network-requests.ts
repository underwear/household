import { CLOCK, type Clock } from "../core/clock";
import type { PetGrant } from "../core/egress";
import { HouseholdError } from "../core/errors";
import { isAllowed, type AllowEntry, type NetworkPolicy } from "../core/network-policy";
import { canonicalAddress, isPublicAddress } from "../core/private-address";
import { carriesHouseholdTag } from "../core/tags";
import type { Screened } from "../infra/public-resolve";
import type { KeyValueStore } from "../infra/sqlite-store";
import type { OwnerCard } from "./chat";
import { cardText, html } from "../core/card";

export const NETWORK_CHOICES = [["Allow 15 min"], ["Allow forever"], ["Deny"]];
/** An approval for good is asked again first, on the same card: it is written into the house's config. */
export const CONFIRM_CHOICES = [["Yes, forever"], ["Cancel"]];
export const NETWORK_TTL_MS = 15 * 60_000;
/** An endpoint as people say it: the port only when it is not HTTPS's. */
const shown = (domain: string, port: number) => (port === 443 ? domain : `${domain}:${port}`);
const STATE_KEY = "network.temporary-grants.v1";
const WAIT_MS = 5 * 60_000;

/** A temporary grant: for one pet only, to the addresses its owner was shown (all public) and to no other. */
export interface TemporaryGrant {
  house: string;
  pet: string;
  domain: string;
  port: number;
  /** What the domain resolved to when the pet asked, canonical: the only addresses the grant reaches. */
  addresses: string[];
  reason: string;
  expiresAt: number;
}

export type NetworkRequestResult = {
  domain: string;
  port: number;
  /** `refused`: the domain resolves to an address off the public internet, so no owner is asked; `unresolvable`: it resolves to none. */
  status: "temporary" | "permanent" | "permanent-pending" | "denied" | "refused" | "unresolvable" | "cancelled" | "timeout" | "already-allowed" | "unavailable" | "busy" | "failed";
  expiresAt?: number;
  message?: string;
};

/** What the owner decided of a request. */
type NetworkDecision = "temporary" | "permanent" | "denied";

/** Where an owner's card for a request is: its three answers, the question before an approval for good, or decided. */
export type NetworkStep = { step: "initial" } | { step: "confirming" } | { step: "resolved"; decision: NetworkDecision };

/** What a decision is called under the card: the answer it was. */
const DECIDED: Record<NetworkDecision, string> = { temporary: NETWORK_CHOICES[0]![0]!, permanent: NETWORK_CHOICES[1]![0]!, denied: NETWORK_CHOICES[2]![0]! };

/**
 * The owner's card for a request (`text`, HTML): "Allow 15 min" and "Deny" decide at once; "Allow forever" asks
 * again, and "Cancel" goes back to the three answers.
 */
export function networkCard(text: string, endpoint: string, scout = false): OwnerCard<NetworkStep> {
  const resolved = (decision: NetworkDecision): NetworkStep => ({ step: "resolved", decision });
  return {
    text,
    format: "html",
    start: { step: "initial" },
    view: (state) => {
      // A scout's grant lasts for its run: no "forever" (its network is its capabilities').
      if (state.step === "initial") return { choices: scout ? [NETWORK_CHOICES[0]!, NETWORK_CHOICES[2]!] : NETWORK_CHOICES, text };
      if (state.step === "confirming") return { choices: CONFIRM_CHOICES, text: cardText({ title: `Allow <code>${html(endpoint)}</code> for good?`, note: "Every pet in the house can reach it until you remove it from the allowlist." }) };
      return { outcome: DECIDED[state.decision] };
    },
    press: (state, index) => {
      if (state.step === "initial") return (scout ? [resolved("temporary"), resolved("denied")] : [resolved("temporary"), { step: "confirming" } as const, resolved("denied")])[index] ?? state;
      if (state.step === "confirming") return [resolved("permanent"), { step: "initial" } as const][index] ?? state;
      return state;
    },
  };
}

export interface NetworkRequestOptions {
  store: KeyValueStore;
  /** Current effective policy, including the agent's hosts; undefined when the house or pet no longer exists. */
  policy(house: string, pet: string): NetworkPolicy | undefined;
  petTitle(house: string, pet: string): string;
  /** Where a domain resolves, refused when anywhere off the public internet (`screenHost`), within a deadline. */
  screen(domain: string): Promise<Screened>;
  /** Household's card (`networkCard`): only its owner moves it; it resolves to its decided step, undefined on abort/disconnection. */
  choose(house: string, pet: string, card: OwnerCard<NetworkStep>, signal: AbortSignal): Promise<NetworkStep | undefined>;
  /** Tells the pet's owner, in its chat, of a request Household refused without asking. */
  notice(house: string, pet: string, text: string): Promise<void>;
  /** Persist the exact domain:port pair, including the default port, as a grant: it reaches public addresses only. */
  permanent(house: string, endpoint: string, pet?: string): Promise<void>;
  /** Scouts ask before DNS so an unapproved hostname cannot exfiltrate data. */
  deferScreen?(house:string,pet:string):boolean;
  /** Apply effective policies immediately; expiry calls the same seam. Reject when application failed. */
  changed(): Promise<void>;
  clock?: Clock;
  waitMs?: number;
}

/** A request grants one exact DNS name; config's wildcard/IP syntax is deliberately unavailable. */
export function requestDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  const labels = domain.split(".");
  const valid = domain.length <= 253 && labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  const tld = /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels.at(-1)!);
  if (!valid || !tld || /[\x00-\x1f\x7f-\x9f]/.test(value) || carriesHouseholdTag(domain) || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|test|invalid|example)$/.test(domain)) {
    throw new HouseholdError("domain must be an exact DNS name (ASCII/punycode), without a URL, IP, wildcard, port, local suffix or trailing dot");
  }
  return domain;
}

/** Ports are independent from the domain and never accept strings, ranges or coercion. */
export function requestPort(value: unknown = 443): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new HouseholdError("port must be an integer from 1 to 65535");
  }
  return value;
}

function requestReason(value: string): string {
  const reason = value.trim();
  if (!reason || reason.length > 600 || /[\x00-\x1f\x7f-\x9f]/.test(value) || carriesHouseholdTag(value)) {
    throw new HouseholdError("reason must explain what the domain is and why it is needed, in 1–600 characters without control characters or Household tags");
  }
  return reason;
}

/** Addresses a grant may be pinned to: some, each public and canonical (as `screenHost` gives them). */
function pinnable(addresses: unknown): addresses is string[] {
  return Array.isArray(addresses) && addresses.length > 0 && addresses.length <= 64 &&
    addresses.every((address) => typeof address === "string" && isPublicAddress(address) && canonicalAddress(address) === address);
}

/** A grant as the gateway allows it: its pet's, until its deadline, to its own addresses only. */
const grantEntry = ({ domain, port, expiresAt, addresses }: TemporaryGrant): AllowEntry => ({ host: domain, port, expiresAt, reach: { pinned: [...addresses] } });

const sameGrant = (grant: TemporaryGrant, house: string, pet: string, domain: string, port: number) =>
  grant.house === house && grant.pet === pet && grant.domain === domain && grant.port === port;

/**
 * Owner decisions and durable temporary grants, each for the one pet that asked. A domain is resolved before its
 * owner is asked: one that leads off the public internet is refused outright, and a temporary grant reaches only
 * the addresses the owner was shown. It never widens the proxy's address guards.
 */
export class NetworkRequests {
  private readonly clock: Clock;
  private grants: TemporaryGrant[] = [];
  private readonly pending = new Map<string, { house: string; pet: string; reason: string; controller: AbortController; result: Promise<NetworkRequestResult> }>();
  private cancelExpiry?: () => void;
  private stopped = false;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NetworkRequestOptions) {
    this.clock = options.clock ?? CLOCK;
    try {
      const saved: unknown = JSON.parse(options.store.get(STATE_KEY) ?? "[]");
      if (Array.isArray(saved)) this.grants = saved.map((entry) => {
        // v1 originally implied 443; malformed explicit ports must still fail closed.
        return entry && typeof entry === "object" ? { ...entry, port: entry.port === undefined ? 443 : entry.port } : entry;
      }).filter((entry): entry is TemporaryGrant => {
        try {
          return typeof entry?.house === "string" && typeof entry?.pet === "string" && typeof entry?.domain === "string" &&
            requestDomain(entry.domain) === entry.domain && requestPort(entry.port) === entry.port && typeof entry.reason === "string" && requestReason(entry.reason) === entry.reason &&
            // A grant without the addresses it was screened at (saved before they were kept) reaches nothing.
            pinnable(entry.addresses) &&
            Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > this.clock.now() && entry.expiresAt <= this.clock.now() + NETWORK_TTL_MS;
        } catch { return false; }
      }).slice(0, 1000);
    } catch { /* Unreadable state grants nothing. */ }
  }

  /** Restore grants only after the policy application callback is ready. Expired state grants nothing. */
  async start(): Promise<void> {
    this.persist();
    await this.options.changed();
    this.scheduleExpiry();
  }

  /** The grants in force, of a house (and of one of its pets). */
  active(house?: string, pet?: string): TemporaryGrant[] {
    return this.grants.filter((grant) => grant.expiresAt > this.clock.now() && (house === undefined || grant.house === house) && (pet === undefined || grant.pet === pet))
      .map((grant) => ({ ...grant, addresses: [...grant.addresses] }));
  }

  /** A house's grants in force, as the gateway holds them: each widens only its own pet's policy. */
  petGrants(house: string): PetGrant[] {
    return this.active(house).map((grant) => ({ pet: grant.pet, entry: grantEntry(grant) }));
  }

  /** What `pet` may reach: `base` (its house's) and its own grants. */
  effective(house: string, pet: string, base: NetworkPolicy): NetworkPolicy {
    const allow = [...base.allow];
    for (const grant of this.active(house, pet)) {
      if (!isAllowed({ kind: "allowlist", allow }, { host: grant.domain, port: grant.port }, this.clock.now())) allow.push(grantEntry(grant));
    }
    return { kind: "allowlist", allow };
  }

  list(house: string, pet: string): { allowed: AllowEntry[]; temporary: TemporaryGrant[] } {
    const policy = this.options.policy(house, pet);
    if (!policy) throw new HouseholdError(`unknown bot ${house}/${pet}`);
    return { allowed: this.effective(house, pet, policy).allow, temporary: this.active(house, pet) };
  }

  async request(house: string, pet: string, rawDomain: string, rawReason: string, rawPort: number = 443, signal?: AbortSignal): Promise<NetworkRequestResult> {
    const domain = requestDomain(rawDomain);
    const port = requestPort(rawPort);
    const reason = requestReason(rawReason);
    if (this.stopped || signal?.aborted) return { domain, port, status: "cancelled" };
    const policy = this.options.policy(house, pet);
    if (!policy) return { domain, port, status: "unavailable" };
    if (isAllowed(this.effective(house, pet, policy), { host: domain, port }, this.clock.now())) return { domain, port, status: "already-allowed" };
    const key = `${house}/${pet}/${domain}:${port}`;
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.reason !== reason) return { domain, port, status: "busy" };
      const cancel = () => existing.controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      try { return await existing.result; } finally { signal?.removeEventListener("abort", cancel); }
    }
    if (this.pending.size >= 20 || [...this.pending.keys()].filter((name) => name.startsWith(`${house}/`)).length >= 3) return { domain, port, status: "busy" };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const result = this.decide(house, pet, domain, port, reason, controller);
    this.pending.set(key, { house, pet, reason, controller, result });
    try { return await result; } finally {
      signal?.removeEventListener("abort", cancel);
      this.pending.delete(key);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelExpiry?.();
    for (const { controller } of this.pending.values()) controller.abort();
    await this.writes;
  }

  /**
   * The pets in the config now. One that left it takes its grants with it, and its pending requests are closed.
   * A disabled pet keeps both: its stopped VM reaches nothing, and a grant runs out on its own. Applying the
   * policy is the caller's (a reload applies it next).
   */
  setPets(pets: { house: string; pet: string }[]): void {
    const present = (house: string, pet: string) => pets.some((item) => item.house === house && item.pet === pet);
    for (const { house, pet, controller } of this.pending.values()) if (!present(house, pet)) controller.abort();
    if (this.grants.every(({ house, pet }) => present(house, pet))) return;
    this.grants = this.grants.filter(({ house, pet }) => present(house, pet));
    this.persist();
    this.scheduleExpiry();
  }

  async revoke(house: string, pet: string, domain: string, rawPort: number = 443): Promise<void> {
    const port = requestPort(rawPort);
    if (this.stopped) throw new HouseholdError("Household is stopping");
    await this.write(async () => {
      this.grants = this.grants.filter((grant) => !sameGrant(grant, house, pet, domain, port));
      this.persist();
      await this.options.changed();
      this.scheduleExpiry();
    });
  }

  private async decide(house: string, pet: string, domain: string, port: number, reason: string, controller: AbortController): Promise<NetworkRequestResult> {
    let timeout = false;
    const cancelTimer = this.clock.after(this.options.waitMs ?? WAIT_MS, () => { timeout = true; controller.abort(); });
    try {
      const cancelled = new Promise<undefined>((resolve) => controller.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
      // What the owner is shown is what a temporary grant reaches; a name leading off the public internet is never asked about.
      const deferred=this.options.deferScreen?.(house,pet)??false;
      let screened = deferred ? {addresses:[] as string[]} : await Promise.race([this.options.screen(domain), cancelled]);
      if (screened === undefined || this.stopped) return { domain, port, status: timeout ? "timeout" : "cancelled" };
      const title = this.options.petTitle(house, pet);
      if ("failed" in screened) return { domain, port, status: "unresolvable", message: "The domain does not resolve to any address; nothing was asked of your owner. Check the name." };
      if ("private" in screened) {
        await this.options.notice(house, pet, `Denied ${title} access to ${shown(domain, port)}: it points to a private address (${screened.private}), which chat never grants. If it is needed, add it to the workspace's allowlist yourself.`).catch(() => {});
        return { domain, port, status: "refused", message: "The domain resolves to an address that is not on the public internet. Household never grants such a domain from chat; your owner was told and may add it to the workspace's allowlist themselves." };
      }
      let { addresses } = screened;
      // Who asks for what, why (its own words, quoted), and the addresses a grant would reach: what the owner approves.
      const text = cardText({
        title: `${html(title)} wants to reach <code>${shown(domain, port)}</code>`,
        quote: { label: "Why", text: reason },
        facts: deferred
          ? ["Resolves: checked only after you allow it", "For: this run of the scout only"]
          : [`Resolves to: ${addresses.map((address) => `<code>${address}</code>`).join(", ")}`],
      });
      // The wait runs on through the card's confirmation step: a timeout closes it wherever it is.
      const decided = await Promise.race([this.options.choose(house, pet, networkCard(text, `${domain}:${port}`, deferred), controller.signal), cancelled]);
      if (controller.signal.aborted || this.stopped) return { domain, port, status: timeout ? "timeout" : "cancelled" };
      if (!this.options.policy(house, pet)) return { domain, port, status: "unavailable" };
      if (decided?.step !== "resolved") return { domain, port, status: "unavailable" };
      const { decision } = decided;
      if (decision === "denied") return { domain, port, status: "denied" };
      if(deferred){
        const checked=await Promise.race([this.options.screen(domain),cancelled]);
        if(!checked||controller.signal.aborted)return {domain,port,status:"cancelled"};
        if("failed" in checked)return {domain,port,status:"unresolvable"};
        if("private" in checked){await this.options.notice(house,pet,"Access refused: the approved domain resolves to a non-public address.");return {domain,port,status:"refused"};}
        addresses=checked.addresses;
      }
      return await this.write(async () => {
        if (controller.signal.aborted || this.stopped || !this.options.policy(house, pet)) return { domain, port, status: "cancelled" } as NetworkRequestResult;
        if (decision === "permanent") {
          await this.options.permanent(house, `${domain}:${port}`, pet);
          // This is a durable owner decision. Never delete an entry another editor may now rely on.
          const pending: NetworkRequestResult = { domain, port, status: "permanent-pending", message: "Your owner approved this domain and TCP port and the permanent allowance was saved. It is not confirmed effective yet; Household must apply network policy successfully before you retry access." };
          if (this.stopped) return pending;
          try { await this.options.changed(); } catch {
            return pending;
          }
          return { domain, port, status: "permanent" } as NetworkRequestResult;
        }
        const expiresAt = this.clock.now() + NETWORK_TTL_MS;
        const grant: TemporaryGrant = { house, pet, domain, port, addresses, reason, expiresAt };
        // What it replaces has run out (one in force would have made the request already allowed).
        this.grants = [...this.grants.filter((other) => !sameGrant(other, house, pet, domain, port)), grant];
        try {
          this.persist();
          await this.options.changed();
        } catch (error) {
          // Only the new grant goes: others may have changed meanwhile (a pet that left took its own).
          this.grants = this.grants.filter((other) => other !== grant);
          try { this.persist(); } catch { /* The failed new grant is never effective in memory. */ }
          await this.options.changed().catch(() => {});
          throw error;
        }
        this.scheduleExpiry();
        return { domain, port, status: "temporary", expiresAt } as NetworkRequestResult;
      });
    } catch { return { domain, port, status: "failed" }; } finally { cancelTimer(); }
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(operation);
    this.writes = next.catch(() => {});
    return next;
  }

  private persist(): void { this.options.store.set(STATE_KEY, JSON.stringify(this.grants)); }

  private scheduleExpiry(): void {
    this.cancelExpiry?.();
    if (this.stopped || this.grants.length === 0) return;
    const at = Math.min(...this.grants.map((grant) => grant.expiresAt));
    this.cancelExpiry = this.clock.after(Math.max(0, at - this.clock.now()), () => void this.expire());
  }

  private async expire(): Promise<void> {
    await this.write(async () => {
      if (this.stopped) return;
      this.grants = this.active();
      try {
        this.persist();
        await this.options.changed();
      } catch {
        // Retry even after the last grant expired; effective() already excludes expired grants.
        if (!this.stopped) this.cancelExpiry = this.clock.after(1000, () => void this.expire());
        return;
      }
      this.scheduleExpiry();
    });
  }
}
