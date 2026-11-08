import { expect, test } from "bun:test";
import { scoutDomain } from "../../src/core/scout-facts";

test("scout facts reveal registrable domain only, with public and private suffixes", () => {
  expect(scoutDomain("https://secret.login.example.co.uk:8443/private?token=secret#fragment")).toEqual({ domain: "example.co.uk" });
  expect(scoutDomain("https://owner.github.io/private")).toEqual({ domain: "owner.github.io" });
  expect(scoutDomain("https://deep.customer.appspot.com/private")).toEqual({ domain: "customer.appspot.com" });
  expect(scoutDomain("api.example.com")).toEqual({ domain: "example.com" });
});

test("scout domain facts use punycode and cap attacker-controlled label length", () => {
  expect(scoutDomain("https://μυστικό.παράδειγμα.ελ/path")).toEqual({ domain: "xn--hxajbheg2az3al.xn--qxam" });
  const long = "a".repeat(63) + ".com";
  expect(scoutDomain(long)).toEqual({ domain: "a".repeat(57) + "..." });
});

test("known infrastructure is folded without revealing subdomains or URL text", () => {
  for (const domain of ["storage.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "api.anthropic.com", "api.openai.com", "chatgpt.com", "cloudflare.com"]) {
    expect(scoutDomain(`https://${domain}/secret?credential=secret`)).toEqual({ infrastructure: true });
  }
  expect(scoutDomain("api.openai.com.evil.org")).toEqual({ domain: "evil.org" });
  for (const invalid of ["http://127.0.0.1/secret", "http://[::1]/secret", "https://localhost/secret", "not a domain"]) expect(scoutDomain(invalid)).toEqual({});
});
