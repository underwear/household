import { expect, test } from "bun:test";
import type { ChannelConfig } from "../../src/core/channels";
import type { Pet } from "../../src/core/household";
import { addressee, routedPet } from "../../src/core/routing";

const pets: Pet[] = [
  { name: "sibling", title: "Sibling", aliases: ["Sib"] },
  { name: "diet", title: "Chef", aliases: ["Šéf", "Chef for the whole family"] },
  { name: "chair" },
];
const channel: ChannelConfig = { kind: "telegram-private", token: "b", chat: "1", pets: ["sibling", "diet"], default: "sibling" };
const to = (facts: Parameters<typeof routedPet>[2]) => routedPet(channel, pets, facts)?.name;

test("a pet is addressed by a name of it at the very start, followed by a comma, a colon or a line break; case does not count", () => {
  for (const text of ["Chef, plan the menu", "chef: menu", "  ŠÉF,menu", "Chef\nmenu", "Chef for the whole family: menu", "diet, menu", "Chef , menu"]) {
    expect(addressee(text, pets)?.name).toBe("diet");
  }
  for (const text of ["ask the Chef, what is there to eat", "Chefs, ask", "Chef plan the menu", "Šéfe: menu", "Šéf", "", "  , Chef"]) {
    expect(addressee(text, pets)).toBeUndefined();
  }
  expect(addressee("Sibling, hi", pets)?.name).toBe("sibling");
  expect(addressee("Chair: sit", pets)?.name).toBe("chair"); // its name, capitalised, is its title
});

test("routing: what it is about, then its thread, then the line it quotes, then a name at its start, then the channel's default", () => {
  expect(to({})).toBe("sibling");
  expect(to({ text: "Chef, plan the menu" })).toBe("diet");
  expect(to({ text: "ask the Chef about the menu" })).toBe("sibling");
  expect(to({ quoted: "diet", text: "and for dinner?" })).toBe("diet");
  expect(to({ thread: "diet", text: "Sibling, hi" })).toBe("diet");
  expect(to({ thread: "sibling", quoted: "diet" })).toBe("sibling");
  expect(to({ about: "diet", thread: "sibling" })).toBe("diet");
});

test("only pets placed in the channel count: one that is not falls through to the next rule", () => {
  expect(to({ text: "Chair, sit" })).toBe("sibling");
  expect(to({ thread: "chair", quoted: "diet" })).toBe("diet");
  expect(to({ about: "gone" })).toBe("sibling");
  expect(routedPet({ ...channel, pets: [] , default: undefined }, pets, { text: "Sibling, hi" })).toBeUndefined();
});
