import { SUBSCRIPTION_PREFIX } from "../agent-adapters/codex-app-server/auth";
import { HouseholdError } from "../core/errors";
import type { House, Household } from "../core/household";
import type { AgentKey } from "../core/keys";
import type { Allowance } from "../core/allowance";
import { sameEndpoint } from "../core/network-policy";
import type { PetKeys } from "./gateway";
import type { KeyView, SecretView } from "./web-views";
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
    if (value?.startsWith(SUBSCRIPTION_PREFIX)) {
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
export function keyViews(agents: Agents, household: Household, allowances?: (key: string) => Allowance | undefined): KeyView[] {
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
  }));
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
