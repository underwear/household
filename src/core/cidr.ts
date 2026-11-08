// IPv4 only: Docker gives the internal subject networks IPv4 subnets.

export interface Cidr {
  network: number;
  mask: number;
}

/**
 * Accepts dotted IPv4, also in the IPv4-mapped IPv6 form (`::ffff:a.b.c.d`) that dual-stack sockets report. A part
 * with a leading zero is refused: C resolvers read `012.0.0.1` as octal (10.0.0.1), so it has no one meaning.
 */
export function parseIpv4(text: string): number | undefined {
  const parts = text.replace(/^::ffff:/i, "").split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && !/^0\d/.test(part) && Number(part) <= 255)) {
    return undefined;
  }
  return parts.reduce((ip, part) => ip * 256 + Number(part), 0);
}

export function parseCidr(text: string): Cidr | undefined {
  const [address = "", bitsText, ...rest] = text.split("/");
  const ip = parseIpv4(address);
  const bits = Number(bitsText);
  if (ip === undefined || rest.length > 0 || !/^\d{1,2}$/.test(bitsText ?? "") || bits > 32) return undefined;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { network: (ip & mask) >>> 0, mask };
}

export function cidrContains(cidr: Cidr, ip: number): boolean {
  return ((ip & cidr.mask) >>> 0) === cidr.network;
}
