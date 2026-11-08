import { telegram, telegramPrivate } from "../channel-adapters/telegram";
import { platformOf, type ChannelKinds, type ChannelKindSpec, type Platform, type PlatformSpec } from "../core/channels";
import { HouseholdError } from "../core/errors";
import type { House, Household, Owner } from "../core/household";
import { beyondHost, petResources, type HostCapacity } from "../core/resources";
import { hostCapacity } from "../infra/host";
import { agentCheck, type Agents } from "./agents";

export type { ChannelKinds };
export type Platforms = ReadonlyMap<Platform, PlatformSpec>;

/** The kinds of channel this build knows, as their adapters describe them. A new kind is one more entry here (and a branch in `openChannels`). */
const KINDS: ChannelKindSpec[] = [telegramPrivate];
/** Their platforms' descriptions (what an owner's id is), one per platform, from the platform's adapter package. */
const PLATFORM_SPECS: PlatformSpec[] = [telegram];

/** Exactly one description for every platform a kind is on: checked once, when the build starts. */
function registry(): { kinds: ChannelKinds; platforms: Platforms } {
  const platforms = new Map<Platform, PlatformSpec>();
  for (const spec of PLATFORM_SPECS) {
    if (platforms.has(spec.platform)) throw new Error(`two descriptions of platform '${spec.platform}'`);
    platforms.set(spec.platform, spec);
  }
  for (const kind of KINDS) if (!platforms.has(kind.platform)) throw new Error(`channel kind '${kind.kind}' is on platform '${kind.platform}', which has no description`);
  return { kinds: new Map(KINDS.map((kind) => [kind.kind, kind])), platforms };
}
const REGISTRY = registry();

export const knownChannelKinds = (): ChannelKinds => REGISTRY.kinds;
export const knownPlatforms = (): Platforms => REGISTRY.platforms;

/** What is wrong with one owner: a platform this build does not know, an id that is not one of the platform's. */
export function ownerProblem(platforms: Platforms, { platform, id }: Owner): string | undefined {
  const spec = platforms.get(platform);
  if (!spec) return `unknown platform '${platform}' (known: ${[...platforms.keys()].join(", ")})`;
  if (!spec.valid(id)) return `'${id}' is not a ${spec.ownerId.label}${spec.ownerId.hint ? ` (${spec.ownerId.hint})` : ""}`;
  return undefined;
}

/**
 * What is wrong with the houses' owners, one line each: an owner that is not one of their platform's (`ownerProblem`),
 * and a platform the house has channels on but no owner (everyone who writes there would be a guest).
 */
export function ownerProblems(kinds: ChannelKinds, platforms: Platforms, houses: House[]): string[] {
  return houses.flatMap((house) => {
    const wrong = house.people.owners.flatMap((owner) => {
      const problem = ownerProblem(platforms, owner);
      return problem === undefined ? [] : [`houses.${house.name}.people.owners.${owner.platform}: ${problem}`];
    });
    const on = new Set(house.channels.flatMap((channel) => platformOf(kinds, channel.kind) ?? []));
    const missing = [...on].filter((platform) => !house.people.owners.some((owner) => owner.platform === platform));
    return [
      ...wrong,
      ...missing.map(
        (platform) => `houses.${house.name}.people.owners: a house with ${platform} channels needs an owner on ${platform} (\`house owner add ${house.name} ${platform} <id>\`), or everyone who writes there is a guest`,
      ),
    ];
  });
}

/** A pet given more than `host` has, one line per resource: its VM could not start there. */
export const hostProblems = (host: HostCapacity, houses: House[]) =>
  houses.flatMap((house) => house.pets.flatMap((pet) => beyondHost(petResources(pet), host).map((problem) => `pet ${house.name}/${pet.name}: ${problem}`)));

/** The ConfigStore's check beyond the schema: the pets' agents and models, what they are given on this host, the owners. */
export const configCheck = (agents: Agents, host: HostCapacity = hostCapacity()) => (household: Household) => [
  ...agentCheck(agents)(household),
  ...hostProblems(host, household.houses),
  ...ownerProblems(knownChannelKinds(), knownPlatforms(), household.houses),
];

/** Refuses houses whose owners are wrong (before a reload touches anything), all at once. */
export function assertOwners(houses: House[]): void {
  const problems = ownerProblems(knownChannelKinds(), knownPlatforms(), houses);
  if (problems.length > 0) throw new HouseholdError(problems.join("\n"));
}
