import { describe, expect, test } from "bun:test";
import { decide, openUntil, petPolicy, type SubjectRule } from "../../src/core/egress";
import { parseAllowEntry, parseTarget } from "../../src/core/network-policy";

const work = { kind: "house", name: "work" } as const;
const home = { kind: "house", name: "home" } as const;
const anthropic = { host: "api.anthropic.com", port: 443 };
const allow = (...hosts: string[]) => ({ kind: "allowlist" as const, allow: hosts.map((host) => parseAllowEntry(host)!) });
const rules: SubjectRule[] = [
  { subject: work, policy: allow("api.anthropic.com", "github.com"), intercept: [anthropic] },
  { subject: home, policy: allow("example.com"), intercept: [] },
  // A wildcard over the host its key goes to: the key's host is intercepted, its siblings only tunnelled.
  { subject: { kind: "house", name: "lab" }, policy: allow("*.anthropic.com", "api.anthropic.com"), intercept: [anthropic] },
  // The whole internet, a private host listed on purpose, and the host its key goes to.
  { subject: { kind: "house", name: "open" }, policy: allow("*:*", "*.corp.example", "db.internal:5432", "api.anthropic.com"), intercept: [anthropic] },
];
// The caller comes from the identity seam (its token); here, by name.
const judge = (house: string, target: string, pet = "sibling") => decide(rules, { house, pet }, parseTarget(target)!);

describe("decide", () => {
  test("the caller's house's rule judges", () => {
    expect(judge("work", "api.anthropic.com:443")).toEqual({ verdict: "allow", subject: work, intercept: true, reach: "any" });
    expect(judge("home", "api.anthropic.com:443").verdict).toBe("deny");
    expect(judge("home", "example.com:443").verdict).toBe("allow");
  });

  test("only a host to intercept is intercepted", () => {
    expect(judge("work", "github.com:443")).toEqual({ verdict: "allow", subject: work, intercept: false, reach: "any" });
  });

  test("a caller of no house is denied", () => {
    expect(judge("nowhere", "api.anthropic.com:443")).toEqual({
      verdict: "deny",
      reason: "the caller's house has no network policy",
    });
    expect(judge("", "api.anthropic.com:443").verdict).toBe("deny");
  });

  test("deny explains host, port and subject", () => {
    expect(judge("work", "example.com:443")).toEqual({
      verdict: "deny",
      subject: work,
      reason: "host example.com:443 is not allowed by Household for house 'work'",
    });
    expect(judge("work", "api.anthropic.com:80").verdict).toBe("deny");
  });

  test("a wildcard allows subdomains, not the apex, and intercepts only the exact hosts keys go to", () => {
    const lab = { kind: "house", name: "lab" } as const;
    expect(judge("lab", "api.anthropic.com:443")).toEqual({ verdict: "allow", subject: lab, intercept: true, reach: "any" });
    expect(judge("lab", "console.anthropic.com:443")).toEqual({ verdict: "allow", subject: lab, intercept: false, reach: "public" });
    expect(judge("lab", "a.b.anthropic.com:443")).toEqual({ verdict: "allow", subject: lab, intercept: false, reach: "public" });
    expect(judge("lab", "anthropic.com:443").verdict).toBe("deny");
    expect(judge("lab", "console.anthropic.com:80").verdict).toBe("deny");
  });
});

describe("decide, for what only a wildcard allows", () => {
  const open = { kind: "house", name: "open" } as const;
  const at = (target: string) => judge("open", target);

  test("a public host: allowed, to public addresses only", () => {
    expect(at("example.com:443")).toEqual({ verdict: "allow", subject: open, intercept: false, reach: "public" });
    expect(at("example.com:22")).toMatchObject({ verdict: "allow", reach: "public" });
    expect(at("93.184.215.14:443")).toMatchObject({ verdict: "allow", reach: "public" });
  });

  test.each(["localhost:443", "localhost.:443", "app.localhost:3000", "host.docker.internal:443", "metadata.google.internal:80", "printer.local:631", "household-gateway:3128", "127.0.0.1:443", "127.0.0.1.:443", "10.0.0.5:22", "169.254.169.254:80", "100.64.1.1:443", "0.0.0.0:443", "172.17.0.1:2375", "192.168.1.1:80", "a.corp.internal:443", "git.corp:443", "1.0.0.10.in-addr.arpa:443"])(
    "a private one (%p) is refused, saying to list it exactly",
    (target) => {
      const decision = judge("open", target);
      expect(decision).toMatchObject({ verdict: "deny", subject: open });
      expect(decision.verdict === "deny" && decision.reason).toContain("only an exact entry the owner wrote reaches a private address; list it so in the allowlist of house 'open'");
    },
  );

  test("an octal-looking address is a name to core: left to the proxy, which checks what it resolves to", () => {
    expect(at("012.0.0.1:443")).toMatchObject({ verdict: "allow", reach: "public" });
  });

  test("an exact entry reaches its private host as before", () => {
    expect(at("db.internal:5432")).toEqual({ verdict: "allow", subject: open, intercept: false, reach: "any" });
  });

  test("* never brings a key: only the exact host the agent declared is intercepted", () => {
    expect(at("api.anthropic.com:443")).toEqual({ verdict: "allow", subject: open, intercept: true, reach: "any" });
    expect(at("api.anthropic.com:8443")).toMatchObject({ intercept: false });
    expect(at("console.anthropic.com:443")).toMatchObject({ intercept: false, reach: "public" });
    expect(at("api.openai.com:443")).toMatchObject({ intercept: false, reach: "public" });
  });
});

describe("grants from chat", () => {
  const work = { kind: "house", name: "work" } as const;
  const pinned = { pinned: ["140.82.112.6"] };
  const grant = { host: "api.github.com", port: 443, expiresAt: 1_000, reach: pinned };
  const granted: SubjectRule[] = [{
    subject: work,
    // `granted` is what the owner approved for good from chat: public addresses only, whatever its name.
    policy: allow("db.internal:5432", "localtest.me:8080"),
    grants: [{ pet: "sibling", entry: grant }, { pet: "sibling", entry: { host: "lan.example.net", port: 22, reach: { pinned: ["93.184.215.14"] } } }],
    intercept: [],
  }];
  granted[0]!.policy.allow.push({ host: "docs.example.org", port: 443, reach: "public" });
  const at = (target: string, pet = "sibling", now = 0) => decide(granted, { house: "work", pet }, parseTarget(target)!, now);

  test("a grant is its pet's only: a housemate is denied it", () => {
    expect(at("api.github.com:443")).toEqual({ verdict: "allow", subject: work, intercept: false, reach: pinned });
    expect(at("api.github.com:443", "chair")).toMatchObject({ verdict: "deny", reason: "host api.github.com:443 is not allowed by Household for house 'work'" });
    expect(petPolicy(granted[0]!, "chair").allow).not.toContainEqual(grant);
  });

  test("a grant reaches only its pinned addresses, a granted entry only public ones; the owner's exact entry anywhere", () => {
    expect(at("docs.example.org:443")).toMatchObject({ verdict: "allow", reach: "public" });
    expect(at("db.internal:5432")).toMatchObject({ verdict: "allow", reach: "any" });
    expect(at("localtest.me:8080")).toMatchObject({ verdict: "allow", reach: "any" });
  });

  test("a grant ends at its deadline", () => {
    expect(at("api.github.com:443", "sibling", 999).verdict).toBe("allow");
    expect(at("api.github.com:443", "sibling", 1_000).verdict).toBe("deny");
  });

  test("an open tunnel stays only as far as it went: by name under an exact entry, at a pinned address under its grant", () => {
    const sibling = { house: "work", pet: "sibling" };
    const github = parseTarget("api.github.com:443")!;
    expect(openUntil(granted, sibling, github, pinned, 0)).toBe(1_000);
    expect(openUntil(granted, sibling, github, { pinned: ["140.82.112.7"] }, 0)).toBeUndefined();
    expect(openUntil(granted, sibling, github, "any", 0)).toBeUndefined();
    expect(openUntil(granted, { house: "work", pet: "chair" }, github, pinned, 0)).toBeUndefined();
    expect(openUntil(granted, sibling, github, pinned, 1_000)).toBeUndefined();
    expect(openUntil(granted, sibling, parseTarget("db.internal:5432")!, "any", 0)).toBe(Infinity);
    expect(openUntil(granted, sibling, parseTarget("docs.example.org")!, "any", 0)).toBeUndefined();
    expect(openUntil(granted, sibling, parseTarget("docs.example.org")!, { pinned: ["93.184.215.14"] }, 0)).toBe(Infinity);
  });
});

describe("interception never grants or widens network access", () => {
  const pet = { house: "work", pet: "sibling" };
  const target = { host: "api.example.com", port: 443 };
  const policy: SubjectRule = { subject: work, policy: allow(), intercept: [target] };
  test("a secret target still needs an allowlist entry", () => {
    expect(decide([policy], pet, target)).toMatchObject({ verdict: "deny" });
  });
  test("intercepted wildcards and requested grants retain their address restrictions", () => {
    const rules = [{ ...policy, policy: allow("*.example.com") }];
    expect(decide(rules, pet, target)).toMatchObject({ verdict: "allow", intercept: true, reach: "public" });
    const local = { host: "printer.local", port: 443 };
    expect(decide([{ ...policy, policy: allow("*"), intercept: [local] }], pet, local)).toMatchObject({ verdict: "deny" });
    const pinned = { pinned: ["93.184.215.14"] };
    const grants = [
      { pet: "sibling", entry: { ...target, reach: pinned, expiresAt: 1000 } },
      { pet: "sibling", entry: { ...target, reach: { pinned: ["93.184.215.15"] }, expiresAt: 2000 } },
    ];
    const granted = [{ ...policy, grants }];
    expect(decide(granted, pet, target, 0)).toMatchObject({ verdict: "allow", intercept: true, reach: { pinned: ["93.184.215.14", "93.184.215.15"] } });
    expect(openUntil(granted, pet, target, pinned, 0)).toBe(1000);
    expect(openUntil(granted, pet, target, pinned, 1000)).toBeUndefined();
    expect(openUntil(granted, pet, target, "any", 0)).toBeUndefined();
  });
});
