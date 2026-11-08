import { cidrContains, parseCidr, parseIpv4, type Cidr } from "./cidr";

// What a host allowed only by a wildcard (`*`, `*.example.com`) or by a grant from chat may not be: anything but the
// public internet. An exact entry the owner wrote names its host on purpose (`db.internal:5432`), so none of this
// applies to it.

/** Not the public internet: this network, private, CGNAT, loopback, link-local (cloud metadata), reserved, multicast. */
const PRIVATE_V4: Cidr[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((text) => parseCidr(text)!);

/** Names that never leave the local network, whatever DNS says of them. */
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "lan", "localdomain", "home.arpa", "home", "corp", "intranet", "private", "test", "example", "invalid", "onion", "in-addr.arpa", "ip6.arpa"];

/** The eight 16-bit groups of an IPv6 address (`::`, an IPv4 tail and a `%zone` allowed), or undefined. */
export function parseIpv6(text: string): number[] | undefined {
  let rest = text.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(rest);
  if (dotted) {
    const ip = parseIpv4(dotted[1]!);
    if (ip === undefined || !rest.includes(":")) return undefined;
    rest = `${rest.slice(0, -dotted[1]!.length)}${Math.floor(ip / 0x10000).toString(16)}:${(ip % 0x10000).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (![...head, ...tail].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const hex = (group: string) => parseInt(group, 16);
  return [...head.map(hex), ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail.map(hex)];
}

const publicV4 = (ip: number) => !PRIVATE_V4.some((cidr) => cidrContains(cidr, ip));

/**
 * Whether an address (IPv4 or IPv6, as DNS or a CONNECT gives it) is on the public internet. Anything that does
 * not parse is not. IPv6 forms that carry an IPv4 address (mapped, NAT64, 6to4) are judged by it.
 */
export function isPublicAddress(text: string): boolean {
  const v4 = parseIpv4(text);
  if (v4 !== undefined) return publicV4(v4);
  const groups = parseIpv6(text);
  if (!groups) return false;
  const [a, b, c, d, e, f, g, h] = groups as [number, number, number, number, number, number, number, number];
  const zeros = (...parts: number[]) => parts.every((part) => part === 0);
  if (zeros(a, b, c, d, e) && f === 0xffff) return publicV4(g * 0x10000 + h); // ::ffff:a.b.c.d
  if (a === 0x64 && b === 0xff9b && zeros(c, d, e, f)) return publicV4(g * 0x10000 + h); // NAT64
  if (a === 0x2002) return publicV4(b * 0x10000 + c); // 6to4
  // Only 2000::/3 is global unicast: ::1, ::, fc00::/7, fe80::/10, ff00::/8 and the rest are not.
  if ((a & 0xe000) !== 0x2000) return false;
  // 2001::/23 is special-purpose (Teredo, benchmarking, …); 2001:db8::/32 is for documentation.
  return !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
}

/** One spelling per address, to compare them (`::FFFF:10.0.0.1` is `10.0.0.1`, `fe80:0::1` is `fe80::1`). */
export function canonicalAddress(text: string): string {
  const v4 = parseIpv4(text);
  if (v4 !== undefined) return [v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".");
  return parseIpv6(text)?.map((group) => group.toString(16)).join(":") ?? text.toLowerCase();
}

/**
 * Whether a host name stays on the local network: one label (Docker's container names), `localhost`, `*.local`,
 * `*.internal` (`host.docker.internal`, cloud metadata), and the like.
 */
export function isLocalName(host: string): boolean {
  return !host.includes(".") || LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
