/**
 * A subscription's allowance: how much of it is used, as the provider says in its answers (Anthropic: the
 * `anthropic-ratelimit-unified-*` headers on every reply to a subscription token). Household meters it per key on
 * the gateway, where every request passes, and refuses requests that would spend past it — that is where a
 * subscription silently turns into pay-as-you-go credits (Anthropic calls it overage, «extra usage»). The provider's
 * words are read by the agent adapter (it knows its provider's headers); core knows only these shapes.
 */

/** One rolling window of the allowance («5 hours», «7 days»). */
export interface AllowanceWindow {
  /** The provider's name for it (`5h`, `7d`). */
  name: string;
  /** 0 (untouched) to 1 (used up); the provider may report more than 1. */
  utilization: number;
  /** When it starts over (ms since the epoch). */
  resetsAt: number;
  /** The provider's word on it (`allowed`, `allowed_warning`, `rejected`), when it says one. */
  status?: string;
}

export interface Allowance {
  /** When it was read (ms since the epoch). */
  at: number;
  windows: AllowanceWindow[];
  /** Spending past the allowance (billed apart), as the provider has it set for the account; absent when it says nothing. */
  overage?: { status: string; utilization?: number };
}

/** The window that is used up and not yet over (`now`): what would spend overage; undefined when none is. */
export function spentWindow(allowance: Allowance, now: number): AllowanceWindow | undefined {
  return allowance.windows.find((window) => window.utilization >= 1 && window.resetsAt > now);
}

/** `5h 1% · 7d 99%`: the windows in a line, the way the web and logs show them. */
export function describeAllowance(allowance: Allowance): string {
  return allowance.windows.map((window) => `${window.name} ${Math.round(window.utilization * 100)}%`).join(" · ");
}

/** Clock time of a reset (`Sun 10:00`), in the given time zone (the system's when none); for people. */
export function resetTime(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(new Date(at));
}
