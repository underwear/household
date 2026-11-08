/** A reference to a host-managed subscription, containing no credential. */
export const SUBSCRIPTION_PREFIX = "codex-chatgpt:";

export function parseSubscriptionMarker(value: string): string | undefined {
  if (!value.startsWith(SUBSCRIPTION_PREFIX)) return undefined;
  const account = value.slice(SUBSCRIPTION_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/.test(account) ? account : undefined;
}
export const codexAccountId = parseSubscriptionMarker;

/** Deliberately invalid as a credential; only the gateway can authorize it. */
export function createPlaceholderJwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ exp: 4102444800, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "unknown" } }),
    "household-not-a-real-signature",
  ].join(".");
}
