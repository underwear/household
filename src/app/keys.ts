import { SUBSCRIPTION_PREFIX } from "../agent-adapters/codex-app-server/auth";
import { SIGNIN_PREFIX } from "../agent-adapters/claude-code-tmux/signin";
import { HouseholdError } from "../core/errors";
import type { House, Household } from "../core/household";
import type { AgentKey } from "../core/keys";
import type { Allowance } from "../core/allowance";
import { sameEndpoint } from "../core/network-policy";
import type { PetKeys } from "./gateway";
import type { KeyView, SecretView, SigninView } from "./web-views";
import { formatHosts, secretPlaceholder } from "../core/secrets";
import { keyKind, type Agents, type PlacedPet } from "./agents";
import { keySecret, ownSecret } from "./gateway";
import type { CredentialRule } from "../core/egress";

/**
 * What the gateway needs to fill in the pets' keys: each pet's rules (its key's wire, naming the key's file, and
 * every credential header its agent sends to that host, to strip) and the values of the keys some pet runs on (no
 * other key goes to the gateway).
 */
export function petKeys(placed: PlacedPet[], keys: AgentKey[], resolved: ReadonlyMap<string, string> = new Map(), houses: readonly Pick<House, "name" | "secrets">[] = []): PetKeys {
  const secrets: Record<string, string> = {};
  const pets = placed.map(({ house, pet, agent, key, keyUse, secrets: placedSecrets = [] }) => {
    let value = keys.find((each) => each.name === key)?.value;
    if (value?.startsWith(SIGNIN_PREFIX)) {
      // A sign-in between tokens (renewing, or ended) still places its bots: they get Claude's 401 until it has one.
      value = resolved.get(key) ?? "";
    } else if (value?.startsWith(SUBSCRIPTION_PREFIX)) {
      value = resolved.get(key);
      if (!value) throw new HouseholdError(`key '${key}': ChatGPT subscription is not authenticated`);
    }
    if (value !== undefined) secrets[keySecret(key)] = value;
    const credentials: CredentialRule[] = keyUse.wire.map((wire) => {
      const strip = agent.credentialHeaders.filter(({ target }) => sameEndpoint(target, wire.target)).flatMap(({ headers }) => headers);
      return { ...wire, secret: keySecret(key), strip: [...new Set([wire.header, ...strip])] };
    });
    for (const { name, hosts, header, placeholder } of placedSecrets) {
      const value = houses.find(each => each.name === house)?.secrets?.find(each => each.name === name)?.value;
      if (value === undefined) continue; // a secret gone since it was placed: its placeholder stays one
      secrets[ownSecret(house, name)] = value;
      for (const target of hosts) credentials.push({ target, header, prefix: "", secret: ownSecret(house, name), strip: [], match: placeholder });
    }
    return { house, pet, credentials };
  });
  return { pets, secrets };
}

/** The keys as the web UI shows them, with the pets that name each. */
/** A sign-in as the key list shows it: whose (what the provider says of it) and until when. */
export interface KeySignin { email?: string; orgName?: string; subscriptionType?: string; expiresAt: number; endsAt?: number; renewedAt?: number }

export function keyViews(agents: Agents, household: Household, allowances?: (key: string) => Allowance | undefined, signins?: (key: string) => KeySignin | undefined): KeyView[] {
  const users = new Map<string, string[]>();
  for (const house of household.houses) {
    for (const pet of house.pets) if (pet.key !== undefined) users.set(pet.key, [...(users.get(pet.key) ?? []), `${house.name}/${pet.name}`]);
  }
  return household.keys.map((key) => ({
    name: key.name,
    provider: key.provider,
    kind: keyKind(agents, key) ?? null,
    value: key.value,
    note: key.note ?? null,
    pets: users.get(key.name) ?? [],
    houses: key.houses ?? null,
    allowOverage: key.allowOverage === true,
    allowance: allowances?.(key.name) ?? null,
    accountConnectors: keyUseOf(agents, key)?.accountConnectors === true,
    signin: signinView(key.value.startsWith(SIGNIN_PREFIX) || key.value.startsWith(SUBSCRIPTION_PREFIX) ? signins?.(key.name) : undefined),
  }));
}

function signinView(info: KeySignin | undefined): SigninView | null {
  if (!info) return null;
  return { email: info.email ?? null, orgName: info.orgName ?? null, subscriptionType: info.subscriptionType ?? null, expiresAt: info.expiresAt, endsAt: info.endsAt ?? null, renewedAt: info.renewedAt ?? null };
}

/** How the first agent of its provider that takes it runs on `key`. */
function keyUseOf(agents: Agents, key: AgentKey) {
  for (const agent of agents.values()) {
    if (!agent.providers.includes(key.provider)) continue;
    const use = agent.useKey(key.provider, key.value);
    if (!("problem" in use)) return use;
  }
  return undefined;
}

/** The owner's secrets as the web UI shows them. */
export function secretViews(house: House): SecretView[] {
  return (house.secrets ?? []).map((secret) => ({
    name: secret.name,
    value: secret.value,
    hosts: formatHosts(secret.hosts),
    header: secret.header,
    env: secret.env,
    placeholder: secretPlaceholder(secret.name),
    ...(secret.onlyForCapabilities ? { onlyForCapabilities: secret.onlyForCapabilities } : {}),
    note: secret.note ?? null,
  }));
}
