import { parseIpv4 } from "./cidr";

/** A concrete place to connect to: a CONNECT target, a host an agent declares. */
export interface Endpoint {
  host: string;
  port: number;
}

/**
 * Where a connection an entry allows may go once its host is resolved: wherever the name leads (`any`: an exact
 * entry the owner wrote on purpose, `db.internal:5432`); only to public addresses (`public`: a wildcard, or a grant
 * the owner approved from a pet's request); or only to these public addresses, the ones the owner was shown when
 * approving (`pinned`), so DNS answering otherwise later (rebinding) changes nothing. Addresses are canonical.
 */
export type Reach = "any" | "public" | { pinned: string[] };

/**
 * An allowlist entry: an `Endpoint`, `*.example.com` (its subdomains), or `*` (any public host). Its port is one
 * port, or `*` (any) in `*:*` only.
 */
export interface AllowEntry {
  host: string;
  port: number | "*";
  /** A temporary grant's absolute deadline (ms); checked on each new connection even before policy reload. */
  expiresAt?: number;
  /** Narrower than the entry's own (`entryReach`): set on what a pet asked for, never on what the owner wrote. */
  reach?: Exclude<Reach, "any">;
}

/** What a network subject may reach. An `open` policy will become a second member of this union. */
export type NetworkPolicy = { kind: "allowlist"; allow: AllowEntry[] };

/** The host of the entries that allow any public host. */
const ANY_HOST = "*";

const ENDPOINT = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/i;
// `*.` and at least two labels, the last with a letter: `*.example.com`, never `*.com`, `*.0.1` (an IP's tail),
// `*foo.com` or `api.*.com`.
const WILDCARD = /^(\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z0-9-]*[a-z][a-z0-9-]*)(?::(\d{1,5}))?$/i;
// `*`, `*:8080` or `*:*`: any public host.
const WHOLE_INTERNET = /^(\*)(?::(\d{1,5}|\*))?$/;

function entryOf(match: RegExpExecArray | null): { host: string; port: number | "*" } | undefined {
  if (!match) return undefined;
  if (match[2] === "*") return { host: match[1]!, port: "*" };
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host: match[1]!.toLowerCase(), port };
}

/**
 * Parses `host` (port 443) or `host:port`: a concrete endpoint (a host an agent declares), never a wildcard.
 * Hosts are compared exactly, so they are normalised to lower case.
 */
export function parseEndpoint(text: string): Endpoint | undefined {
  return entryOf(ENDPOINT.exec(text)) as Endpoint | undefined;
}

/** A CONNECT target: what `parseEndpoint` takes, the one trailing dot of a fully qualified name dropped (`api.example.com.:443`). */
export function parseTarget(text: string): Endpoint | undefined {
  return parseEndpoint(text.replace(/\.(:\d+)?$/, "$1"));
}

/**
 * Parses an allowlist entry: what `parseEndpoint` takes; `*.example.com[:port]`, which covers every subdomain of
 * example.com at any depth (not example.com itself) on that one port; or `*[:port]` / `*:*`, any public host.
 */
export function parseAllowEntry(text: string): AllowEntry | undefined {
  return parseEndpoint(text) ?? entryOf(WILDCARD.exec(text)) ?? entryOf(WHOLE_INTERNET.exec(text));
}

/** Why `text` is no allowlist entry: the one message for the config file, the CLI and the web UI. */
export function allowEntryError(text: string): string {
  if (/[^\x00-\x7f]/.test(text)) return `'${text}' is not host or host:port: a non-ASCII host is written in punycode (xn--…)`;
  return `'${text}' is not host or host:port (wildcards: *.example.com, * for any public host, *:* on any port)`;
}

/** The entry as it is written back and echoed: `host`, `host:port` for a port other than 443; `*`, `*:*`. */
export function formatAllowEntry(entry: AllowEntry): string {
  return entry.port === 443 ? entry.host : `${entry.host}:${entry.port}`;
}

/** Whether the entry allows any public host (`*`, `*:port`, `*:*`). */
export function isWholeInternet(entry: AllowEntry): boolean {
  return entry.host === ANY_HOST;
}

function isWildcard(entry: AllowEntry): boolean {
  return entry.host.startsWith("*");
}

/** An IPv4 address, or an IPv6 one (which a host name never holds: no `:`). */
export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== undefined || host.includes(":");
}

export function formatEndpoint(endpoint: AllowEntry): string {
  return `${endpoint.host}:${endpoint.port}`;
}

/** The same entry, as written (a wildcard is the same only as the same wildcard): for duplicates and credentials. */
export function sameEndpoint(a: AllowEntry, b: AllowEntry): boolean {
  return a.host === b.host && a.port === b.port;
}

/** Whether allowlist `entry` lets a connection to the concrete `target` through. */
export function covers(entry: AllowEntry, target: Endpoint, now = Date.now()): boolean {
  if (entry.expiresAt !== undefined && (!Number.isFinite(entry.expiresAt) || now >= entry.expiresAt)) return false;
  // One port per entry; only `*:*` takes any.
  if (entry.port !== "*" && entry.port !== target.port) return false;
  // Targets are concrete (`parseTarget` never yields a `*`): one holding `*` is no host, not even a wildcard's own.
  if (target.host.includes("*")) return false;
  // Any public host: that it is public is the proxy's to check, once it has resolved it (`Decision.reach`).
  if (isWholeInternet(entry)) return true;
  if (!isWildcard(entry)) return entry.host === target.host;
  // A wildcard names a domain's subdomains, and an IP address is none: `*.0.1` never parses, and this holds anyway.
  if (isIpLiteral(target.host)) return false;
  const suffix = entry.host.slice(1); // `.example.com`
  return target.host.length > suffix.length && target.host.endsWith(suffix);
}

/** How far an entry lets a connection go: as it says, else `any` for an exact entry and `public` for a wildcard. */
export function entryReach(entry: AllowEntry): Reach {
  return entry.reach ?? (isWildcard(entry) ? "public" : "any");
}

/** Whether a connection that went as far as `opened` stays within `allowed`: never to an address `allowed` refuses. */
export function within(opened: Reach, allowed: Reach): boolean {
  if (allowed === "any") return true;
  if (opened === "any") return false; // by name: wherever DNS led, which nothing checked
  if (allowed === "public") return true;
  return opened !== "public" && opened.pinned.every((address) => allowed.pinned.includes(address));
}

/** How far `policy` lets a connection to `target` go: the widest reach of the entries covering it; none: not at all. */
export function reachOf(policy: NetworkPolicy, target: Endpoint, now = Date.now()): Reach | undefined {
  const reaches = policy.allow.filter((entry) => covers(entry, target, now)).map(entryReach);
  if (reaches.length === 0) return undefined;
  if (reaches.includes("any")) return "any";
  if (reaches.includes("public")) return "public";
  return { pinned: [...new Set(reaches.flatMap((reach) => (typeof reach === "object" ? reach.pinned : [])))] };
}

export function isAllowed(policy: NetworkPolicy, target: Endpoint, now = Date.now()): boolean {
  return reachOf(policy, target, now) !== undefined;
}
