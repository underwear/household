import { describe, expect, test } from "bun:test";
import { cidrContains, parseCidr, parseIpv4 } from "../../src/core/cidr";

describe("parseIpv4", () => {
  test("dotted and IPv4-mapped forms", () => {
    expect(parseIpv4("172.20.0.3")).toBe(0xac140003);
    expect(parseIpv4("::ffff:172.20.0.3")).toBe(0xac140003);
    expect(parseIpv4("0.0.0.0")).toBe(0);
    expect(parseIpv4("10.0.0.10")).toBe(0x0a00000a);
  });

  test.each(["", "1.2.3", "1.2.3.256", "a.b.c.d", "::1", "1.2.3.4.5", "012.0.0.1", "010.0.0.1", "0177.0.0.1", "1.2.3.04", "00.0.0.0"])("rejects %p (a leading zero is octal to C)", (text) => {
    expect(parseIpv4(text)).toBeUndefined();
  });
});

describe("cidr", () => {
  const contains = (cidr: string, ip: string) => cidrContains(parseCidr(cidr)!, parseIpv4(ip)!);

  test("membership", () => {
    expect(contains("172.20.0.0/16", "172.20.255.1")).toBe(true);
    expect(contains("172.20.0.0/16", "172.21.0.1")).toBe(false);
    expect(contains("127.0.0.0/8", "127.0.0.1")).toBe(true);
    expect(contains("10.0.0.5/32", "10.0.0.5")).toBe(true);
    expect(contains("10.0.0.5/32", "10.0.0.6")).toBe(false);
    expect(contains("0.0.0.0/0", "8.8.8.8")).toBe(true);
  });

  test("host bits in the base are masked off", () => {
    expect(contains("172.20.9.9/16", "172.20.0.1")).toBe(true);
  });

  test.each(["172.20.0.0", "172.20.0.0/33", "172.20.0.0/x", "1.2.3/8", "1.2.3.4/8/8"])("rejects %p", (text) => {
    expect(parseCidr(text)).toBeUndefined();
  });
});
