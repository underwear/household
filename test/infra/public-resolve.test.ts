import { expect, test } from "bun:test";
import { screenHost, type Resolve } from "../../src/infra/public-resolve";

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
