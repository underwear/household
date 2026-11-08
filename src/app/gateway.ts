import type { CredentialRule, PetGrant, Subject } from "../core/egress";
import { sameEndpoint, type Endpoint, type NetworkPolicy } from "../core/network-policy";
import { credentialsOf, type GatewayPolicy, type PetCredentials, type PetIdentity } from "../infra/gateway-policy";

/*
 * What the daemon hands its egress gateway (the host-side proxy, MITM and relay of `HostNetworkPlane`): the houses'
 * policies, each pet's credential rules, and the files the values are read from.
 */

/** File in the gateway's secrets dir holding the agent API secret. */
export const AGENT_API_SECRET = "household-agent-api";
/** File in the gateway's secrets dir holding key `name`'s value (a `.` no key name has: never the agent API's file). */
export const keySecret = (name: string) => `key.${name}`;
/** The gateway's file of an owner's secret. */
export const ownSecret = (name: string) => `secret.${name}`;

/** The daemon's agent API, as the gateway reaches it and with the secret the gateway must present. */
export interface AgentApiAccess {
  url: string;
  secret: string;
}

/** What the gateway needs to know about a network subject. */
export interface SubjectSpec {
  subject: Subject;
  policy: NetworkPolicy;
  /** What single pets may reach besides: their grants from chat. */
  grants?: PetGrant[];
  /** Hosts whose requests get the calling pet's credentials. */
  intercept: Endpoint[];
}

/** What the gateway fills in for the pets: each pet's rules, and the values the rules name (by file). */
export interface PetKeys {
  pets: PetCredentials[];
  secrets: Record<string, string>;
}

/**
 * What the interceptor fills in for `pet` (identified by its token at its tunnel's CONNECT) on a request to
 * `target`: its rules for the host. A pet without one gets nothing: its request is refused (never another's key).
 */
export function petCredentials(policy: GatewayPolicy, pet: PetIdentity, target: Endpoint): CredentialRule[] | { refused: string } {
  const rules = credentialsOf(policy, pet).filter((rule) => sameEndpoint(rule.target, target));
  return rules.length > 0 ? rules : { refused: `pet ${pet.house}/${pet.pet} has no key for ${target.host}` };
}
