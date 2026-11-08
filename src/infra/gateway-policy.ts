import type { Caller, CredentialRule, PetIdentity, PetTokenIdentity, SubjectRule } from "../core/egress";
import { hashPetToken, petTokenFrom } from "./pet-token-registry";

export type { PetIdentity };

// The tables the daemon hands its in-process egress gateway (`HostNetworkPlane`): rules per house, the pets'
// token digests and credential rules. It lives in memory; values are files the gateway reads per request.

/** What the gateway fills in on a pet's requests: its rules (by pet, never by address). */
export interface PetCredentials extends PetIdentity {
  credentials: CredentialRule[];
}

export interface GatewayPolicy {
  rules: SubjectRule[];
  /** Each pet's capability, as a digest: the only way a caller is a pet. */
  tokens: PetTokenIdentity[];
  /** Each pet's credentials (none: the gateway refuses its requests to the hosts it intercepts). */
  keys?: PetCredentials[];
  /** Base URL of the daemon's agent API as the gateway reaches it; absent until the daemon has one. */
  agentApi?: string;
  /**
   * The addresses of the machine the daemon runs on (every interface, both families): a host only a wildcard
   * allows never resolves to one of them.
   */
  hostAddresses?: string[];
}

/** Which pet is calling: the one whose token it shows (proxy credentials or the token header); else none. */
export function identifyPet(policy: GatewayPolicy, caller: Caller): PetIdentity | undefined {
  const credential = petTokenFrom(caller);
  if (!credential.token) return undefined;
  const hash = hashPetToken(credential.token);
  const identity = policy.tokens.find((entry) => entry.sha256 === hash);
  return identity && { house: identity.house, pet: identity.pet };
}

/** The credentials of a pet (none when it has no key). */
export const credentialsOf = (policy: GatewayPolicy, { house, pet }: PetIdentity): CredentialRule[] =>
  policy.keys?.find((entry) => entry.house === house && entry.pet === pet)?.credentials ?? [];
