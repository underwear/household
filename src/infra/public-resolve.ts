import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isIpLiteral } from "../core/network-policy";
import { canonicalAddress, isPublicAddress } from "../core/private-address";

/** Every address a host name resolves to. */
export type Resolve = (host: string) => Promise<string[]>;

export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);

/** The addresses of this machine's own interfaces. */
export function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map(({ address }) => address));
}

/** A host screened: every address it resolves to (canonical) and the one to connect to; or why not. */
export type Screened = { address: string; addresses: string[] } | { private: string } | { failed: string };

/**
 * Where a connection that may reach public addresses only may go: the host resolved once (within `timeoutMs`),
 * refused (`private`, the address) when any of its addresses is not public or is this machine's own; else the
 * address to connect to (an IPv4 one when there is one), which is the one checked: connecting by name would resolve
 * again, and DNS may answer otherwise the second time (rebinding).
 */
export async function screenHost(host: string, resolve: Resolve, own: () => string[], timeoutMs = 10_000): Promise<Screened> {
  let addresses: string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    // An address is connected to as it was judged, in its one spelling.
    addresses = (isIpLiteral(host) ? [host] : await Promise.race([resolve(host), late])).map(canonicalAddress);
  } catch (error) {
    return { failed: `cannot resolve ${host}: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
  if (addresses.length === 0) return { failed: `cannot resolve ${host}: no address` };
  const mine = new Set(own().map(canonicalAddress));
  const refused = addresses.find((address) => !isPublicAddress(address) || mine.has(address));
  if (refused !== undefined) return { private: refused };
  return { address: addresses.find((address) => !address.includes(":")) ?? addresses[0]!, addresses: [...new Set(addresses)] };
}
