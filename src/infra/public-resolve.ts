import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isIpLiteral } from "../core/network-policy";
import { canonicalAddress, inSubnet, isLanAddress, isPublicAddress } from "../core/private-address";

/** Every address a host name resolves to. */
export type Resolve = (host: string) => Promise<string[]>;

export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address);

/**
 * Interfaces a hypervisor or a container engine makes on this machine. macOS: vmnet's bridges (`bridge100`, never
 * `bridge0`, Thunderbolt's). Linux: Docker's and Podman's, libvirt's, LXD's and Incus's, Kubernetes CNIs',
 * VirtualBox's, VMware's, Multipass's. What is on their networks runs on this machine.
 */
const VIRTUAL_INTERFACE = /^(?:bridge[1-9]\d{2,}|vmenet\d+|vmnet\d+|vboxnet\d+|docker.*|br-[0-9a-f]+|virbr\d+|veth.+|cni.+|flannel.+|cali.+|cilium.+|lxc.+|lxdbr\d+|incusbr\d+|podman\d+|nerdctl\d+|mpqemubr\d+|tap\d+)$/;

/**
 * What is this machine, to a connection: the addresses of its own interfaces, and the subnets (`address/bits`) of
 * its virtual networks, where its VMs and containers live.
 */
export function ownAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  return Object.entries(interfaces).flatMap(([name, list]) => (list ?? []).flatMap(({ address, cidr }) => (cidr && VIRTUAL_INTERFACE.test(name) ? [address, cidr] : [address])));
}

/** A host screened: every address it resolves to (canonical) and the one to connect to; or why not. */
export type Screened = { address: string; addresses: string[]; /** One of them that is on the local network, when `lan` let it through. */ lan?: string } | { private: string } | { failed: string };

/**
 * Where a connection that may reach public addresses only may go: the host resolved once (within `timeoutMs`),
 * refused (`private`, the address) when any of its addresses is not public or is this machine's own; else the
 * address to connect to (an IPv4 one when there is one), which is the one checked: connecting by name would resolve
 * again, and DNS may answer otherwise the second time (rebinding). With `lan`, addresses on the local network pass
 * too (what an owner approves, the address shown to them): still never this machine's own, one of its VMs' or
 * containers' (a subnet in `own`), loopback or a reserved range.
 */
export async function screenHost(host: string, resolve: Resolve, own: () => string[], timeoutMs = 10_000, lan = false): Promise<Screened> {
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
  const owned = own();
  const mine = new Set(owned.filter((entry) => !entry.includes("/")).map(canonicalAddress));
  const subnets = owned.filter((entry) => entry.includes("/"));
  const local = (address: string) => lan && isLanAddress(address);
  const refused = addresses.find((address) => (!isPublicAddress(address) && !local(address)) || mine.has(address) || subnets.some((subnet) => inSubnet(address, subnet)));
  if (refused !== undefined) return { private: refused };
  const onLan = addresses.find(local);
  return { address: addresses.find((address) => !address.includes(":")) ?? addresses[0]!, addresses: [...new Set(addresses)], ...(onLan === undefined ? {} : { lan: onLan }) };
}
