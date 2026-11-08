import type { Allowance, AllowanceWindow } from "../../core/allowance";

/*
 * What is left of a Claude subscription, as api.anthropic.com says on every answer to a subscription token (a
 * `claude setup-token` one, 2026-11): `anthropic-ratelimit-unified-<window>-utilization` (0..1), `-reset` (unix
 * seconds) and `-status` per rolling window (`5h`, `7d`), `anthropic-ratelimit-unified-overage-status` and
 * `-overage-utilization` for extra usage (spending past the allowance, billed to credits). An API key's answers
 * carry none of these: nothing is read, and such a key is never refused for its allowance.
 */

const PREFIX = "anthropic-ratelimit-unified-";

/** The windows named in the headers, by name (`5h` before `7d`): Headers iterate in the runtime's order, not the provider's. */
function windowsIn(headers: Headers): string[] {
  const names: string[] = [];
  headers.forEach((_, name) => {
    const match = /^anthropic-ratelimit-unified-([a-z0-9]+)-utilization$/.exec(name);
    if (match && match[1] !== "overage" && !names.includes(match[1]!)) names.push(match[1]!);
  });
  return names.sort();
}

const number = (text: string | null) => (text !== null && text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : undefined);

/** The allowance in an answer's headers; undefined when they say nothing of it (no window with a utilization and a reset). */
export function readAnthropicAllowance(headers: Headers, now = Date.now()): Allowance | undefined {
  const windows: AllowanceWindow[] = [];
  for (const name of windowsIn(headers)) {
    const utilization = number(headers.get(`${PREFIX}${name}-utilization`));
    const reset = number(headers.get(`${PREFIX}${name}-reset`));
    if (utilization === undefined || reset === undefined) continue;
    const status = headers.get(`${PREFIX}${name}-status`)?.trim();
    windows.push({ name, utilization, resetsAt: reset * 1000, ...(status ? { status } : {}) });
  }
  if (windows.length === 0) return undefined;
  const overageStatus = headers.get(`${PREFIX}overage-status`)?.trim();
  const overageUtilization = number(headers.get(`${PREFIX}overage-utilization`));
  return {
    at: now,
    windows,
    ...(overageStatus ? { overage: { status: overageStatus, ...(overageUtilization === undefined ? {} : { utilization: overageUtilization }) } } : {}),
  };
}
