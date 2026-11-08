import { describe, expect, test } from "bun:test";
import { canonicalAddress, isLocalName, isPublicAddress, parseIpv6 } from "../../src/core/private-address";

describe("isPublicAddress", () => {
  test.each(["93.184.215.14", "1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "2a00:1450:4001::200e", "::ffff:93.184.215.14", "::ffff:5db8:d70e", "64:ff9b::808:808", "2002:808:808::1"])(
    "%p is public",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  test.each([
    ["0.0.0.0", "unspecified"],
    ["0.250.250.254", "this network (OrbStack's host)"],
    ["10.1.2.3", "RFC 1918"],
    ["172.16.0.1", "RFC 1918"],
    ["172.31.255.255", "RFC 1918 (Docker)"],
    ["192.168.65.254", "RFC 1918 (Docker Desktop's host)"],
    ["127.0.0.1", "loopback"],
    ["127.8.9.10", "loopback"],
    ["169.254.169.254", "link-local: cloud metadata"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.255", "CGNAT"],
    ["198.19.249.3", "benchmarking (OrbStack's machines)"],
    ["192.0.2.1", "documentation"],
    ["224.0.0.251", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["[::1]", "loopback, bracketed"],
    ["fe80::1%eth0", "link-local with a zone"],
    ["fd00:ec2::254", "unique-local (AWS metadata)"],
    ["fc00::1", "unique-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::FFFF:7f00:1", "IPv4-mapped loopback, hex"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::a00:1", "NAT64 of 10.0.0.1"],
    ["2002:c0a8:101::1", "6to4 of 192.168.1.1"],
    ["2001:db8::1", "documentation"],
    ["2001::1", "Teredo"],
    ["::127.0.0.1", "IPv4-compatible"],
    ["localhost", "not an address"],
    ["1.2.3", "not an address"],
    ["1::2::3", "not an address"],
    ["012.0.0.1", "octal to C (10.0.0.1): no one meaning"],
    ["010.0.0.1", "octal to C"],
    ["0177.0.0.1", "octal to C (127.0.0.1)"],
  ])("%p is not public (%s)", (address) => expect(isPublicAddress(address)).toBe(false));
});

test("parseIpv6 reads every spelling into eight groups", () => {
  expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  expect(parseIpv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  expect(parseIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
  expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  for (const bad of ["1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1::2::3", "::g", "12345::", "::a1.2.3.4", "1.2.3.4"]) expect(parseIpv6(bad)).toBeUndefined();
  expect(canonicalAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  expect(canonicalAddress("fe80:0::1")).toBe(canonicalAddress("FE80::1"));
});

describe("isLocalName", () => {
  test.each(["localhost", "app.localhost", "host.docker.internal", "metadata.google.internal", "printer.local", "nas.lan", "router.home.arpa", "household-gateway", "db", "nas.home", "git.corp", "wiki.intranet", "box.private", "app.test", "www.example", "x.invalid", "abc.onion", "1.0.0.10.in-addr.arpa", "b.a.ip6.arpa"])(
    "%p stays local",
    (host) => expect(isLocalName(host)).toBe(true),
  );
  test.each(["example.com", "internal.example.com", "local.example.com", "localhost.example.com"])("%p does not", (host) => expect(isLocalName(host)).toBe(false));
});
