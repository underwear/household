import { covers, entryReach, formatEndpoint, isIpLiteral, reachOf, sameEndpoint, within, type AllowEntry, type Endpoint, type NetworkPolicy, type Reach } from "./network-policy";
import { isLocalName, isPublicAddress } from "./private-address";

/** Who owns a source subnet. Only houses exist now; scouts will add a kind. */
export type Subject = { kind: "house"; name: string } | { kind: "scout"; name: string; pet: string }
  /** A throwaway VM of Household's own (a Claude sign-in's): no house, no bot, its own narrow allowlist. */
  | { kind: "household"; name: string; pet: string };

/** Who is calling: a pet of a house. */
export interface PetIdentity {
  house: string;
  pet: string;
}

/** Pet-visible capability, used only between a pet and Household's gateway. */
export const PET_TOKEN_HEADER = "x-household-token";
/** Policy stores only a digest; the persistent registry owns the raw capability. */
export interface PetTokenIdentity extends PetIdentity { sha256: string }

/** What a caller of the gateway shows: where it comes from, and its request's headers (lower-case names). */
export interface Caller {
  source: string;
  header: (name: string) => string | undefined;
}

/**
 * The one identity seam: which pet a caller is (today by source address; R1 by a House token in a header), or
 * undefined for none. The proxy asks it once per CONNECT, the relay once per request; nothing else looks.
 */
export type Identify = (caller: Caller) => PetIdentity | undefined;

/**
 * On requests to `target`, the gateway removes every header of `strip` (all the host's credential headers, the
 * agent says which) and sets `header` to `prefix` + the secret named `secret` (the pet's key). A request with none
 * of them is refused: a placeholder is never sent on. The pet holds only a placeholder; the value never leaves the gateway.
 */
export interface CredentialRule {
  target: Endpoint;
  /** Lower case. */
  header: string;
  prefix: string;
  secret: string;
  /** Lower case; holds `header`. */
  strip: string[];
  /**
   * An owner's secret: only where `header` holds this placeholder (as is, or in `Basic` credentials) is it
   * replaced by the value; nothing is stripped, and a request without it passes as it is. None: an agent's key.
   */
  match?: string;
}

export interface SubjectRule {
  subject: Subject;
  /** What every pet of the subject may reach. */
  policy: NetworkPolicy;
  /** What single pets may reach besides: the grants their owner approved for them from chat. */
  grants?: PetGrant[];
  /** Hosts whose requests the gateway opens up, to fill in the calling pet's key. */
  intercept: Endpoint[];
}

/** An allowlist entry one pet holds (a grant from chat): it widens that pet's policy, never its housemates'. */
export interface PetGrant {
  pet: string;
  entry: AllowEntry;
}

export type Decision =
  /**
   * `intercept`: the connection must be opened up, to fill in the calling pet's key. `reach`: where the proxy may
   * connect (`Reach`): by name only for `any`; else to an address it resolved and checked, never to another.
   */
  | { verdict: "allow"; subject: Subject; intercept: boolean; reach: Reach }
  | { verdict: "deny"; subject?: Subject; reason: string };

export function describeSubject(subject: Subject): string {
  return `${subject.kind} '${subject.name}'`;
}

/** The rule of the calling pet's house. */
export function ruleOf(rules: SubjectRule[], pet: PetIdentity): SubjectRule | undefined {
  return rules.find(({ subject }) => (subject.kind === "scout" || subject.kind === "household") && subject.name === pet.house && subject.pet === pet.pet)
    ?? rules.find(({ subject }) => subject.kind === "house" && subject.name === pet.house);
}

/** What `pet` of the rule's subject may reach: the subject's policy and the pet's own grants. */
export function petPolicy(rule: SubjectRule, pet: string): NetworkPolicy {
  const own = (rule.grants ?? []).filter((grant) => grant.pet === pet).map(({ entry }) => entry);
  return { kind: "allowlist", allow: [...rule.policy.allow, ...own] };
}

/**
 * The whole egress policy, independent of how the target was learned (CONNECT now, SNI later) and of how the
 * caller was told (`Identify`): the calling pet's policy (its house's and its own grants) judges the target.
 */
export function decide(rules: SubjectRule[], pet: PetIdentity, target: Endpoint, now = Date.now()): Decision {
  const rule = ruleOf(rules, pet);
  if (!rule) return { verdict: "deny", reason: "the caller's house has no network policy" };
  const { subject, intercept } = rule;
  const allowed = reachOf(petPolicy(rule, pet.pet), target, now);
  if (!allowed) {
    const reason = `host ${formatEndpoint(target)} is not allowed by Household for ${describeSubject(subject)}`;
    return { verdict: "deny", subject, reason };
  }
  // A host to intercept is one an agent declares or an owner's secret names: exact, whatever else covers it; the
  // interception does not widen the allowlist entry's address reach.
  const intercepted = intercept.some((host) => sameEndpoint(host, target));
  const reach = allowed;
  if (reach !== "any" && (isLocalName(target.host) || (isIpLiteral(target.host) && !isPublicAddress(target.host)))) {
    return { verdict: "deny", subject, reason: privateReason(target, subject) };
  }
  return { verdict: "allow", subject, intercept: intercepted, reach };
}

/**
 * Until when a tunnel `pet` opened to `target`, as far as `opened` (by name, or to one checked address), may stay
 * open (Infinity: no deadline); undefined: not now. Only entries that allow it as far as it went count: a wildcard
 * never keeps a tunnel opened by name open, nor does a grant pinned to other addresses.
 */
export function openUntil(rules: SubjectRule[], pet: PetIdentity, target: Endpoint, opened: Reach, now = Date.now()): number | undefined {
  const decision = decide(rules, pet, target, now);
  if (decision.verdict === "deny" || !within(opened, decision.reach)) return undefined;
  const deadlines = petPolicy(ruleOf(rules, pet)!, pet.pet).allow
    .filter((entry) => covers(entry, target, now) && within(opened, entryReach(entry)))
    .map(({ expiresAt }) => expiresAt ?? Infinity);
  return deadlines.length > 0 ? Math.max(...deadlines) : undefined;
}

/** Why a host that may reach public addresses only is refused: it is (or resolves to `address`) not on the public internet. */
export function privateReason(target: Endpoint, subject: Subject, address?: string): string {
  const what = address ? `host ${formatEndpoint(target)} resolves to ${address}, which is` : `host ${formatEndpoint(target)} is`;
  return `${what} not on the public internet: only an exact entry the owner wrote reaches a private address; list it so in the allowlist of ${describeSubject(subject)}`;
}
