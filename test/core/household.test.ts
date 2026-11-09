import { expect, test } from "bun:test";
import type { SenderRef } from "../../src/core/channel";
import { emojiOf } from "../../src/core/emoji";
import { assertCanAddPet, assertCanCreateHouse, petDisplay, petPlace, trustOf, type Household, type Owner, type People } from "../../src/core/household";
import type { Platform } from "../../src/core/channels";

const household: Household = {
  daemon: {},
  keys: [],
  secrets: [],
  houses: [{ name: "work", network: { kind: "allowlist", allow: [] }, pets: [{ name: "sibling", agent: "claude-code-tmux" }], people: { owners: [] }, channels: [] }],
};

test("house names are validated and unique", () => {
  expect(() => assertCanCreateHouse(household, "home")).not.toThrow();
  expect(() => assertCanCreateHouse(household, "work")).toThrow("workspace 'work' already exists");
  for (const bad of ["Work", "1st", "-x", "a_b", "", "a".repeat(32)]) {
    expect(() => assertCanCreateHouse(household, bad)).toThrow("invalid workspace name");
  }
  expect(() => assertCanCreateHouse(household, "a".repeat(31))).not.toThrow();
});

test("pets need a known house and a fresh valid name", () => {
  for (const valid of ["chair", "test_pet-2", "a".repeat(31)]) expect(() => assertCanAddPet(household, "work", valid)).not.toThrow();
  for (const invalid of ["1pet", "_pet", "-pet", "pet.name", "φίλος", "a".repeat(32)]) expect(() => assertCanAddPet(household, "work", invalid)).toThrow("invalid bot name");
  expect(() => assertCanAddPet(household, "home", "chair")).toThrow("unknown workspace 'home'");
  expect(() => assertCanAddPet(household, "work", "sibling")).toThrow("bot 'sibling' already exists");
  expect(() => assertCanAddPet(household, "work", "Sibling")).toThrow("invalid bot name");
});

test("a pet's place in the chat: Household's id for it, its title (or name, capitalised) behind its emoji (a robot by default)", () => {
  expect(petPlace({ name: "sibling" }, "c1")).toEqual({ id: "c1", kind: "pet-thread", title: "🤖 Sibling" });
  expect(petPlace({ name: "sibling", title: "Sibling" }, "c1")).toEqual({ id: "c1", kind: "pet-thread", title: "🤖 Sibling" });
  expect(petPlace({ name: "sibling", title: "Sibling", emoji: "🦉" }, "c1").title).toBe("🦉 Sibling");
  expect(petDisplay({ name: "chair", emoji: "👩‍💻" })).toBe("👩‍💻 Chair");
});

test("a pet's emoji is exactly one, fully qualified: ZWJ sequences, skin tones, flags and keycaps are one; text, digits, two, padding, a lone skin tone or a bare text symbol are not", () => {
  for (const same of ["🤖", "🦉", "👍🏽", "✌🏽", "👩‍💻", "🇺🇦", "1️⃣", "❤️", "❤️‍🔥", "©️"]) expect(emojiOf(same)).toBe(same);
  const qualified: [string, string][] = [
    ["❤", "❤\u{FE0F}"],
    ["☺", "☺\u{FE0F}"],
    ["✌", "✌\u{FE0F}"],
    ["#\u{20E3}", "#\u{FE0F}\u{20E3}"],
    ["❤\u{200D}🔥", "❤\u{FE0F}\u{200D}🔥"],
    ["👨\u{200D}❤\u{200D}👨", "👨\u{200D}❤\u{FE0F}\u{200D}👨"],
    ["🏳\u{200D}🌈", "🏳\u{FE0F}\u{200D}🌈"],
    ["👁\u{200D}🗨", "👁\u{FE0F}\u{200D}🗨\u{FE0F}"],
  ];
  for (const [typed, stored] of qualified) expect(emojiOf(typed)).toBe(stored);
  for (const bad of ["", "a", "1", "🤖🤖", "🤖 ", " 🤖", "x🤖", "owl", "🏽", "©", "™", "‼", "↔", "ℹ"]) expect(emojiOf(bad)).toBeUndefined();
});

test("trust comes from the config: an owner of the house, as a channel of their platform tells its senders apart, is the owner; anyone else a guest", () => {
  // WhatsApp: a platform to come (not in PLATFORMS yet).
  const people: People = { owners: [{ platform: "telegram", id: "42" }, { platform: "whatsapp" as Platform, id: "+34600000000" }] };
  // Only a Telegram channel is open: it knows Telegram's people, in its own terms.
  const from = (ref: string) => (owner: Owner) => owner.platform === "telegram" && ref === `t.user.${owner.id}`;
  expect(trustOf(people, from("t.user.42"))).toBe("owner");
  expect(trustOf(people, from("t.user.+34600000000"))).toBe("guest"); // a WhatsApp owner's id, sent on Telegram
  expect(trustOf(people, from("t.user.43"))).toBe("guest");
  expect(trustOf({ owners: [] }, from("t.user.42"))).toBe("guest");
});
