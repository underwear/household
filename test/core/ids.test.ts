import { expect, test } from "bun:test";
import { expectId, makeId, parseId } from "../../src/core/ids";

test("Household ids are a kind's letter and a number; anything else, a channel's raw id included, is refused by name", () => {
  expect([makeId("message", 42), makeId("person", 1), makeId("channel", 2)]).toEqual(["m42", "p1", "c2"]);
  expect(parseId("c2")).toEqual({ kind: "channel", seq: 2 });
  for (const value of ["m0", "M2", "m02", "x2", "m", "100200300", "m2; DROP TABLE", "pet:sibling", "inbox"]) expect(parseId(value)).toBeUndefined();
  expect(expectId("message", "m42")).toBe(42);
  expect(() => expectId("message", "100200300")).toThrow("100200300 is not a Household id: use an id from a header (event.id, from.id, channel.id)");
  expect(() => expectId("channel", "m42")).toThrow("m42 is a message id, not a channel id (c<n>)");
  expect(() => expectId("channel", "x".repeat(100))).toThrow(`${"x".repeat(39)}… is not a Household id`);
});
