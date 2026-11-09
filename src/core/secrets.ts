import type { CapabilityKey } from "./scouts";
import { formatAllowEntry, isIpLiteral, parseEndpoint, type Endpoint } from "./network-policy";

/**
 * The owner's own secrets (a GitHub token, an npm token, …): unlike the agents' keys, whose hosts and headers
 * their adapters declare, a secret names its hosts itself. Its pets see only a placeholder, in an environment
 * variable; the gateway opens their requests to those hosts and, where the named header holds the placeholder
 * (as is, or inside `Basic` credentials, as git sends them), puts the value in its place. Nowhere else.
 */
export interface Secret {
  name: string;
  value: string;
  /** Exact `host[:port]`s (443 by default), never a wildcard. */
  hosts: Endpoint[];
  /** Lower case; `authorization` unless said. */
  header: string;
  /** The variable the pets get the placeholder in. */
  env: string;
  /** The owner's own words about it: for the web UI only. */
  note?: string;
  /** Keys of these capabilities only (in this house): never a pet's or a sideworker's, not even as a placeholder. */
  onlyForCapabilities?: string[];
}

/** A secret as a pet's VM and the gateway need it, without its value. */
export interface PlacedSecret {
  name: string;
  hosts: Endpoint[];
  header: string;
  env: string;
  placeholder: string;
}

export const DEFAULT_SECRET_HEADER = "authorization";

/** What a pet holds in place of a secret: plain, so a person reading its environment knows it for one. */
export const secretPlaceholder = (name: string) => `household-secret-${name}`;

/** Whether a provider key is for `house` (none named: for every house). */
export const availableTo = (item: { houses?: string[] }, house: string) => item.houses === undefined || item.houses.includes(house);

/** The secrets a house's pets get, from that house's own catalog. */
export function houseSecrets(secrets: readonly Secret[]): PlacedSecret[] {
  return secrets.filter((secret) => secret.onlyForCapabilities === undefined).map(({ name, hosts, header, env }) => ({ name, hosts, header, env, placeholder: secretPlaceholder(name) }));
}

/** A scout's gateway keys, from its capabilities: each a secret restricted to the capability it comes from. Nothing inherited. */
export function scoutSecrets(secrets: readonly Secret[], keys: readonly (CapabilityKey & { capability: string })[]): PlacedSecret[] {
  return keys.filter(key => key.via === "gateway").flatMap(key => {
    const secret = secrets.find(item => item.name === key.secret && item.onlyForCapabilities?.includes(key.capability));
    return secret ? [{ name: secret.name, hosts: secret.hosts, header: secret.header, env: secret.env, placeholder: secretPlaceholder(secret.name) }] : [];
  });
}

/** The value of a scout's key that sits inside its VM, if its secret is restricted to that capability in this house. */
export function scoutVmSecret(secrets: readonly Secret[], key: CapabilityKey & { capability: string }): Secret | undefined {
  return secrets.find(item => item.name === key.secret && item.onlyForCapabilities?.includes(key.capability));
}

export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
// What Household or an agent sets in a pet's VM itself, or what would reroute or untrust its traffic.
const RESERVED_ENV = /^(PATH|HOME|USER|SHELL|LANG|TERM|PWD|HOSTNAME|.*_PROXY|SSL_CERT_.*|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|HOUSEHOLD_.*|ANTHROPIC_.*|CLAUDE_.*|OPENAI_.*|CODEX_.*)$/;

/** Why `name` cannot be a secret's variable, or undefined. */
export function envProblem(name: string): string | undefined {
  if (!ENV_NAME.test(name)) return "an environment variable: A–Z, 0–9 and _, not starting with a digit";
  if (RESERVED_ENV.test(name)) return `${name} is set by Household or the agent itself`;
  return undefined;
}

/** A secret's host, or why it cannot be one (a wildcard, an IP address, not a host). */
export function secretHost(text: string): Endpoint | { problem: string } {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.includes("*")) return { problem: `${trimmed}: a secret names exact hosts, never a wildcard` };
  const endpoint = parseEndpoint(trimmed);
  if (!endpoint) return { problem: `${trimmed}: not a host (example.com or example.com:8443)` };
  if (isIpLiteral(endpoint.host)) return { problem: `${trimmed}: name the host, not an IP address` };
  return endpoint;
}

/** A starting point for a common secret: its hosts and variable (the header is `authorization` for all of them). */
export interface SecretPreset {
  id: string;
  label: string;
  hosts: string[];
  env: string;
}

export const SECRET_PRESETS: SecretPreset[] = [
  { id: "github", label: "GitHub", hosts: ["github.com", "api.github.com", "uploads.github.com", "raw.githubusercontent.com"], env: "GITHUB_TOKEN" },
  { id: "npm", label: "npm", hosts: ["registry.npmjs.org"], env: "NPM_TOKEN" },
  { id: "huggingface", label: "Hugging Face", hosts: ["huggingface.co"], env: "HF_TOKEN" },
];

/** «github.com, example.com:8443»: the default port left out. */
export const formatHosts = (hosts: readonly Endpoint[]) => hosts.map(formatAllowEntry);

/**
 * A header value with the placeholder replaced by the value: where it stands as is (`Bearer …`, `token …`), or
 * inside `Basic` credentials (`user:placeholder`, base64). Undefined when the placeholder is in neither.
 */
export function fillPlaceholder(header: string, placeholder: string, value: string): string | undefined {
  // Names may share a prefix (github and github-atlas); only a complete placeholder selects a credential.
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g");
  const replace = (text: string): string | undefined => {
    let matched = false;
    const result = text.replace(token, () => { matched = true; return value; });
    return matched ? result : undefined;
  };
  const filled = replace(header);
  if (filled !== undefined) return filled;
  const basic = /^basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!basic) return undefined;
  const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
  const credentials = replace(decoded);
  return credentials === undefined ? undefined : `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}
