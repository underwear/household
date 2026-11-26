import { expect, test } from "bun:test";
import { ownAddresses, screenHost, type Resolve } from "../../src/infra/public-resolve";

/** A stub DNS that answers from `table` and counts what it was asked. */
function dns(table: Record<string, string[]>) {
  const asked: string[] = [];
  const resolve: Resolve = async (host) => {
    asked.push(host);
    if (!(host in table)) throw new Error(`queryA ENOTFOUND ${host}`);
    return table[host]!;
  };
  return { asked, resolve };
}
const none = () => [];

test("resolves once and gives the address it checked, an IPv4 one first", async () => {
  const { asked, resolve } = dns({ "example.com": ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "93.184.215.14"] });
  expect(await screenHost("example.com", resolve, none)).toEqual({ address: "93.184.215.14", addresses: ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "93.184.215.14"] });
  expect(asked).toEqual(["example.com"]);
  expect(await screenHost("v6.example", dns({ "v6.example": ["2606:4700::1111"] }).resolve, none)).toEqual({ address: "2606:4700:0:0:0:0:0:1111", addresses: ["2606:4700:0:0:0:0:0:1111"] });
});

test("one private address among public ones refuses the host (DNS rebinding)", async () => {
  const { asked, resolve } = dns({ "rebind.example": ["93.184.215.14", "127.0.0.1"], "meta.example": ["169.254.169.254"], "ula.example": ["fd00::1"], "mapped.example": ["::ffff:10.0.0.1"] });
  expect(await screenHost("rebind.example", resolve, none)).toEqual({ private: "127.0.0.1" });
  expect(await screenHost("meta.example", resolve, none)).toEqual({ private: "169.254.169.254" });
  expect(await screenHost("ula.example", resolve, none)).toEqual({ private: "fd00:0:0:0:0:0:0:1" });
  expect(await screenHost("mapped.example", resolve, none)).toEqual({ private: "10.0.0.1" });
  expect(asked).toEqual(["rebind.example", "meta.example", "ula.example", "mapped.example"]);
});

test("the gateway's own addresses are refused, in any spelling", async () => {
  const own = () => ["127.0.0.1", "203.0.114.7", "2a01:4f8::7"];
  expect(await screenHost("me.example", dns({ "me.example": ["203.0.114.7"] }).resolve, own)).toEqual({ private: "203.0.114.7" });
  expect(await screenHost("me6.example", dns({ "me6.example": ["2A01:4F8:0::7"] }).resolve, own)).toEqual({ private: "2a01:4f8:0:0:0:0:0:7" });
});

test("an octal-looking host is a name: what the resolver makes of it is what is checked", async () => {
  const { asked, resolve } = dns({ "012.0.0.1": ["10.0.0.1"], "0177.0.0.1": ["127.0.0.1"] });
  expect(await screenHost("012.0.0.1", resolve, none)).toEqual({ private: "10.0.0.1" });
  expect(await screenHost("0177.0.0.1", resolve, none)).toEqual({ private: "127.0.0.1" });
  expect(asked).toEqual(["012.0.0.1", "0177.0.0.1"]);
});

test("an address is connected to in the spelling it was judged in", async () => {
  expect(await screenHost("[2606:4700::1111]", dns({}).resolve, none)).toMatchObject({ address: "2606:4700:0:0:0:0:0:1111" });
  expect(await screenHost("::ffff:93.184.215.14", dns({}).resolve, none)).toMatchObject({ address: "93.184.215.14" });
});

test("an address is not resolved; a name that does not resolve fails", async () => {
  const { asked, resolve } = dns({});
  expect(await screenHost("93.184.215.14", resolve, none)).toEqual({ address: "93.184.215.14", addresses: ["93.184.215.14"] });
  expect(await screenHost("10.0.0.1", resolve, none)).toEqual({ private: "10.0.0.1" });
  expect(asked).toEqual([]);
  expect(await screenHost("nowhere.example", resolve, none)).toEqual({ failed: "cannot resolve nowhere.example: queryA ENOTFOUND nowhere.example" });
  expect(await screenHost("empty.example", dns({ "empty.example": [] }).resolve, none)).toEqual({ failed: "cannot resolve empty.example: no address" });
});

test("a resolver that does not answer in time fails, without the answer it never gave", async () => {
  expect(await screenHost("slow.example", () => new Promise<string[]>(() => {}), none, 20)).toEqual({ failed: "cannot resolve slow.example: timed out after 20 ms" });
});

test("with lan, the local network passes and is marked; this machine, loopback and reserved ranges never do", async () => {
  const { resolve } = dns({ "printer.example": ["192.168.2.120"], "ula.example": ["fd00::1"], "rebind.example": ["192.168.2.120", "127.0.0.1"], "meta.example": ["169.254.169.254"], "cgnat.example": ["100.64.1.1"] });
  const lan = (host: string, own: () => string[] = none) => screenHost(host, resolve, own, undefined, true);
  expect(await lan("printer.example")).toEqual({ address: "192.168.2.120", addresses: ["192.168.2.120"], lan: "192.168.2.120" });
  expect(await lan("192.168.2.120")).toEqual({ address: "192.168.2.120", addresses: ["192.168.2.120"], lan: "192.168.2.120" });
  expect(await lan("ula.example")).toMatchObject({ lan: "fd00:0:0:0:0:0:0:1" });
  expect(await lan("printer.example", () => ["192.168.2.120"])).toEqual({ private: "192.168.2.120" });
  expect(await lan("rebind.example")).toEqual({ private: "127.0.0.1" });
  expect(await lan("meta.example")).toEqual({ private: "169.254.169.254" });
  expect(await lan("cgnat.example")).toEqual({ private: "100.64.1.1" });
  expect(await lan("127.0.0.1")).toEqual({ private: "127.0.0.1" });
});

test("the networks of this machine's VMs and containers are this machine: never let through, the real network is", async () => {
  const face = (address: string, cidr: string) => [{ address, cidr, netmask: "", family: address.includes(":") ? "IPv6" : "IPv4", mac: "", internal: false } as never];
  const own = () => ownAddresses({ en1: face("192.168.2.2", "192.168.2.2/24"), bridge0: face("192.168.9.1", "192.168.9.1/24"), bridge100: [...face("192.168.139.3", "192.168.139.3/23"), ...face("fd07:b51a:cc66::1", "fd07:b51a:cc66::1/64")], docker0: face("172.17.0.1", "172.17.0.1/16") });
  expect(own()).toEqual(["192.168.2.2", "192.168.9.1", "192.168.139.3", "192.168.139.3/23", "fd07:b51a:cc66::1", "fd07:b51a:cc66::1/64", "172.17.0.1", "172.17.0.1/16"]);
  const lan = (host: string) => screenHost(host, async () => [], own, undefined, true);
  expect(await lan("192.168.2.120")).toMatchObject({ lan: "192.168.2.120" });
  expect(await lan("192.168.9.7")).toMatchObject({ lan: "192.168.9.7" }); // bridge0 is Thunderbolt's: a real network
  expect(await lan("10.0.0.5")).toMatchObject({ lan: "10.0.0.5" }); // routed, beyond this machine's own subnets
  for (const address of ["192.168.138.20", "192.168.139.200", "172.17.0.2", "192.168.2.2"]) expect(await lan(address)).toEqual({ private: address });
  expect(await lan("fd07:b51a:cc66::9")).toEqual({ private: "fd07:b51a:cc66:0:0:0:0:9" });
  // Linux names: Docker's user networks, libvirt, LXD, a CNI; a real NIC and a VPN are not virtual networks of this machine.
  const linux = ownAddresses(Object.fromEntries(["br-3f2a9c1d0e4b", "virbr0", "lxdbr0", "cni0", "docker_gwbridge", "enp3s0", "eth0", "wlan0", "wg0", "br0"].map((name, index) => [name, face(`10.9.${index}.1`, `10.9.${index}.1/24`)])));
  expect(linux.filter((entry) => entry.includes("/"))).toEqual(["10.9.0.1/24", "10.9.1.1/24", "10.9.2.1/24", "10.9.3.1/24", "10.9.4.1/24"]);
  expect(await lan("fd07:b51a:cc67::9")).toMatchObject({ lan: "fd07:b51a:cc67:0:0:0:0:9" });
});
