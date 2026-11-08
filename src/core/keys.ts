/**
 * Agent-provider keys: the Household's credentials for the model providers its pets' agents call. A key is one
 * provider's (a fixed set: a new one is one more name here); there may be any number, several of one provider,
 * each named as the person likes, and each pet names the one it runs on (`pets.<p>.key`). A pet never sees a key's value: the gateway puts it on the
 * wire for it (see `AgentAdapter.useKey`).
 */
export const PROVIDERS = ["anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** One key of the Household, as the config has it (`keys.<name>`). */
export interface AgentKey {
  name: string;
  provider: Provider;
  value: string;
  /** The owner's own words about it («Oleg's Max subscription»): for the web UI only. */
  note?: string;
  /** The houses whose pets may run on it; none named: every house. */
  houses?: string[];
  /**
   * A subscription's: whether its pets may keep sending once its allowance is used up, spending what the provider
   * bills apart (Anthropic's extra usage, from credits). Off when absent: the gateway refuses such requests until
   * the window starts over (core/allowance.ts).
   */
  allowOverage?: boolean;
}

/**
 * The key a pet runs on, among the Household's: the one it names (always explicitly, `pets.<p>.key`), which must
 * be of a provider its agent takes. Otherwise what is wrong, naming what would do.
 */
export function keyFor(keys: AgentKey[], named: string | undefined, providers: readonly Provider[], agent: string, house?: string): AgentKey | { problem: string } {
  const fitting = keys.filter((key) => providers.includes(key.provider) && (house === undefined || key.houses === undefined || key.houses.includes(house)));
  const takes = `${agent} takes ${providers.join(" or ")} keys`;
  const which = fitting.length > 0 ? `one of: ${fitting.map((key) => key.name).join(", ")}` : "the Household has none: add one under keys:";
  if (named === undefined) return { problem: `no key: name the key it runs on (key:; ${which})` };
  const key = keys.find((candidate) => candidate.name === named);
  if (!key) return { problem: `unknown key '${named}' (${which})` };
  if (!providers.includes(key.provider)) return { problem: `key '${named}' is an ${key.provider} key, and ${takes}` };
  if (!fitting.includes(key)) return { problem: `key '${named}' is not for house '${house}' (its houses: ${key.houses!.join(", ")})` };
  return key;
}
