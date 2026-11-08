import { describe, expect, test } from "bun:test";
import { allowEntryError, covers, formatAllowEntry, isAllowed, reachOf, within, isIpLiteral, parseAllowEntry, parseEndpoint, parseTarget, type NetworkPolicy } from "../../src/core/network-policy";

describe("parseEndpoint", () => {
  test("host means port 443, host is lower-cased", () => {
    expect(parseEndpoint("API.Anthropic.com")).toEqual({ host: "api.anthropic.com", port: 443 });
    expect(parseEndpoint("db.internal:5432")).toEqual({ host: "db.internal", port: 5432 });
    expect(parseEndpoint("127.0.0.1:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  test.each(["", "host:", "host:0", "host:70000", "a b", "host:443:1", "http://host", "host.", "*.host"])(
    "rejects %p",
    (text) => expect(parseEndpoint(text)).toBeUndefined(),
  );
});

describe("isAllowed", () => {
  const policy: NetworkPolicy = {
    kind: "allowlist",
    allow: [parseEndpoint("api.anthropic.com")!, parseEndpoint("db.internal:5432")!],
  };
  const allowed = (target: string) => isAllowed(policy, parseEndpoint(target)!);

  test("exact host and port", () => {
    expect(allowed("api.anthropic.com:443")).toBe(true);
    expect(allowed("API.ANTHROPIC.COM:443")).toBe(true);
    expect(allowed("db.internal:5432")).toBe(true);
  });

  test("no port, suffix or prefix leaks", () => {
    expect(allowed("api.anthropic.com:80")).toBe(false);
    expect(allowed("db.internal")).toBe(false);
    expect(allowed("evil.api.anthropic.com")).toBe(false);
    expect(allowed("anthropic.com")).toBe(false);
  });
});

describe("parseAllowEntry", () => {
  test("a host, or *. and two labels or more; lower case, port 443 when left out", () => {
    expect(parseAllowEntry("db.internal:5432")).toEqual({ host: "db.internal", port: 5432 });
    expect(parseAllowEntry("*.Example.com")).toEqual({ host: "*.example.com", port: 443 });
    expect(parseAllowEntry("*.example.com:8443")).toEqual({ host: "*.example.com", port: 8443 });
    expect(parseAllowEntry("*.co.uk")).toEqual({ host: "*.co.uk", port: 443 });
  });

  test.each(["*.com", "*.co", "*.com:443", "api.*.com", "*foo.com", "*.*.example.com", "**.example.com", "example.*", "*.example.com:0", "*.example.com.", " *.example.com", "*.0.1", "*.1.2.3", "*.0.1:443", "*:0", "*:70000", "**", "*.", "host:*", "*.example.com:*", "*:*:*", "münchen.de", "*.münchen.de"])(
    "rejects %p",
    (text) => expect(parseAllowEntry(text)).toBeUndefined(),
  );

  test("a target is never a wildcard", () => {
    expect(parseEndpoint("*.example.com")).toBeUndefined();
    expect(parseEndpoint("*")).toBeUndefined();
    expect(parseTarget("*:443")).toBeUndefined();
  });

  test("the whole internet: *, *:port, *:*", () => {
    expect(parseAllowEntry("*")).toEqual({ host: "*", port: 443 });
    expect(parseAllowEntry("*:8080")).toEqual({ host: "*", port: 8080 });
    expect(parseAllowEntry("*:*")).toEqual({ host: "*", port: "*" });
  });

  test("written back in one spelling: 443 left out", () => {
    for (const [text, written] of [["PyPI.org:443", "pypi.org"], ["db.internal:5432", "db.internal:5432"], ["*.Example.com:443", "*.example.com"], ["*:443", "*"], ["*:8080", "*:8080"], ["*:*", "*:*"]]) {
      expect(formatAllowEntry(parseAllowEntry(text!)!)).toBe(written!);
    }
  });

  test("a non-ASCII host is told to use punycode", () => {
    expect(allowEntryError("münchen.de")).toBe("'münchen.de' is not host or host:port: a non-ASCII host is written in punycode (xn--…)");
    expect(parseAllowEntry("xn--mnchen-3ya.de")).toEqual({ host: "xn--mnchen-3ya.de", port: 443 });
    expect(allowEntryError("a b")).toStartWith("'a b' is not host or host:port (wildcards: *.example.com, *");
  });
});

describe("parseTarget", () => {
  test("drops one trailing dot of a fully qualified name", () => {
    expect(parseTarget("api.example.com.:443")).toEqual({ host: "api.example.com", port: 443 });
    expect(parseTarget("API.example.com.")).toEqual({ host: "api.example.com", port: 443 });
    expect(parseTarget("api.example.com..:443")).toBeUndefined();
    expect(parseTarget(".:443")).toBeUndefined();
  });
});

describe("a wildcard entry", () => {
  const entry = parseAllowEntry("*.example.com")!;
  const reaches = (target: string) => covers(entry, parseEndpoint(target)!);

  test("covers subdomains at any depth, case-insensitively", () => {
    expect(reaches("api.example.com")).toBe(true);
    expect(reaches("a.b.example.com")).toBe(true);
    expect(reaches("API.Example.COM")).toBe(true);
  });

  test("not the apex, not a look-alike, not another port", () => {
    expect(reaches("example.com")).toBe(false);
    expect(reaches("badexample.com")).toBe(false);
    expect(reaches("api.example.com.evil.net")).toBe(false);
    expect(reaches("api.example.com:80")).toBe(false);
    expect(covers(parseAllowEntry("*.example.com:8443")!, parseEndpoint("api.example.com:8443")!)).toBe(true);
  });

  test("the apex is its own entry", () => {
    const policy: NetworkPolicy = { kind: "allowlist", allow: [entry, parseEndpoint("example.com")!] };
    expect(isAllowed(policy, parseEndpoint("example.com")!)).toBe(true);
    expect(isAllowed(policy, parseEndpoint("www.example.com")!)).toBe(true);
  });

  test("a target holding * matches nothing", () => expect(covers(entry, { host: "*.example.com", port: 443 })).toBe(false));

  test("an octal-looking address is no IP literal (a resolver's to read; the proxy checks what it says)", () => {
    for (const host of ["012.0.0.1", "010.0.0.1", "0177.0.0.1"]) expect(isIpLiteral(host)).toBe(false);
    expect(isIpLiteral("10.0.0.1")).toBe(true);
  });

  test("never an IP address, even a wildcard that slipped past the parser", () => {
    expect(covers({ host: "*.0.1", port: 443 }, parseEndpoint("10.0.0.1")!)).toBe(false);
    expect(covers({ host: "*.0.0.1", port: 443 }, parseEndpoint("127.0.0.1")!)).toBe(false);
    expect(covers({ host: "*.1", port: 443 }, { host: "::1", port: 443 })).toBe(false);
  });
});

describe("the whole internet", () => {
  const reaches = (entry: string, target: string) => covers(parseAllowEntry(entry)!, parseTarget(target)!);

  test("* is any host on 443, *:port on that port, *:* on any", () => {
    expect(reaches("*", "example.com")).toBe(true);
    expect(reaches("*", "a.b.example.org:443")).toBe(true);
    expect(reaches("*", "93.184.215.14")).toBe(true); // an address: public or not, the proxy's to say
    expect(reaches("*", "example.com:80")).toBe(false);
    expect(reaches("*:8080", "example.com:8080")).toBe(true);
    expect(reaches("*:8080", "example.com")).toBe(false);
    expect(reaches("*:*", "example.com:22")).toBe(true);
    expect(reaches("*:*", "example.com")).toBe(true);
  });

  test("an exact entry is exact even next to a wildcard; the rest is only the wildcard's", () => {
    const policy: NetworkPolicy = { kind: "allowlist", allow: [parseAllowEntry("*:*")!, parseAllowEntry("*.example.com")!, parseAllowEntry("db.internal:5432")!] };
    expect(reachOf(policy, parseTarget("db.internal:5432")!)).toBe("any");
    expect(reachOf(policy, parseTarget("api.example.com")!)).toBe("public");
    expect(reachOf(policy, parseTarget("example.org:22")!)).toBe("public");
    expect(reachOf({ kind: "allowlist", allow: [parseAllowEntry("*")!] }, parseTarget("example.org:22")!)).toBeUndefined();
  });
});

test("a temporary allowlist entry expires on each new connection, without waiting for a policy reload", () => {
  const entry = { host: "github.com", port: 443, expiresAt: 1_000 };
  const policy: NetworkPolicy = { kind: "allowlist", allow: [entry] };
  const target = { host: "github.com", port: 443 };
  expect(isAllowed(policy, target, 999)).toBe(true);
  expect(isAllowed(policy, target, 1_000)).toBe(false);
  expect(isAllowed(policy, target, 1_001)).toBe(false);
  expect(isAllowed({ kind: "allowlist", allow: [{ ...entry, expiresAt: NaN }] }, target, 0)).toBe(false);
  expect(isAllowed({ kind: "allowlist", allow: [entry, { host: "github.com", port: 443 }] }, target, 1_001)).toBe(true);
});

describe("reach", () => {
  const exact = { host: "api.example.org", port: 443 };
  const pinned = (...addresses: string[]) => ({ ...exact, reach: { pinned: addresses } });
  const target = { host: "api.example.org", port: 443 };

  test("an exact entry a grant marks reaches no further than it says; the widest covering entry wins", () => {
    expect(reachOf({ kind: "allowlist", allow: [{ ...exact, reach: "public" }] }, target)).toBe("public");
    expect(reachOf({ kind: "allowlist", allow: [pinned("93.184.215.14"), pinned("93.184.215.15", "93.184.215.14")] }, target)).toEqual({ pinned: ["93.184.215.14", "93.184.215.15"] });
    expect(reachOf({ kind: "allowlist", allow: [pinned("93.184.215.14"), parseAllowEntry("*")!] }, target)).toBe("public");
    expect(reachOf({ kind: "allowlist", allow: [pinned("93.184.215.14"), exact] }, target)).toBe("any");
  });

  test("a connection stays within what allows it only as far as it went", () => {
    const at = { pinned: ["93.184.215.14"] };
    expect(within("any", "any")).toBe(true);
    expect(within("any", "public")).toBe(false);
    expect(within("any", at)).toBe(false);
    expect(within(at, "public")).toBe(true);
    expect(within(at, { pinned: ["93.184.215.14", "93.184.215.15"] })).toBe(true);
    expect(within(at, { pinned: ["93.184.215.15"] })).toBe(false);
    expect(within("public", at)).toBe(false);
  });
});
