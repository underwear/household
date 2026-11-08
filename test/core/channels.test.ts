import { expect, test } from "bun:test";
import { knownChannelKinds } from "../../src/app/kinds";
import { channelKey, channelName, channelProblems, defaultPet, joining, parsePlaceKey, petPlaceKey, inboxKey, type ChannelConfig } from "../../src/core/channels";
import type { House } from "../../src/core/household";

const dm: ChannelConfig = { kind: "telegram-private", token: "telegram-work", chat: "100200300", pets: ["sibling"] };
const house = (channels: ChannelConfig[], pets: House["pets"] = [{ name: "sibling", title: "Sibling" }, { name: "diet", title: "Chef", aliases: ["Šéf"] }]): House => ({
  name: "work",
  network: { kind: "allowlist", allow: [] },
  pets,
  people: { owners: [{ platform: "telegram", id: "100200300" }] },
  channels,
});

test("a channel's key is what it is (kind, chat), not its name, its secret or its place in the list; its name is the config's or its kind's", () => {
  expect(channelKey(dm)).toBe("telegram-private:100200300");
  expect(channelKey({ ...dm, name: "DM", token: "telegram-rotated", pets: [] } as typeof dm)).toBe(channelKey(dm));
  expect(channelName(knownChannelKinds(), dm)).toBe("Telegram Bot DM (threaded)"); // its kind's label, from the kind's descriptor
  expect(channelName(knownChannelKinds(), { ...dm, name: "DM" })).toBe("DM");
});

test("place keys name the channel and, for a pet's place, the pet; an unknown key names nothing", () => {
  const key = channelKey(dm);
  expect(parsePlaceKey(petPlaceKey("sibling", key))).toEqual({ channel: key, pet: "sibling" });
  expect(parsePlaceKey(inboxKey(key))).toEqual({ channel: key });
  for (const unknown of ["junk", "junk@x", undefined]) expect(parsePlaceKey(unknown)).toBeUndefined();
});

test("the default pet is the one given, or the only one", () => {
  expect(defaultPet(dm)).toBe("sibling");
  expect(defaultPet({ ...dm, pets: ["sibling", "diet"], default: "diet" })).toBe("diet");
  expect(defaultPet({ ...dm, pets: [] })).toBeUndefined();
});

test("a pet joining a channel: one alone needs no default; joining one pet, that pet stays the default; a named default stays", () => {
  expect(joining({ pets: [] }, "owl")).toEqual({ pets: ["owl"] });
  expect(joining({ pets: ["cat"] }, "owl")).toEqual({ pets: ["cat", "owl"], default: "cat" });
  expect(joining({ pets: ["cat", "dog"], default: "dog" }, "owl")).toEqual({ pets: ["cat", "dog", "owl"], default: "dog" });
  expect(joining({ pets: ["cat", "owl"], default: "cat" }, "owl")).toEqual({ pets: ["cat", "owl"], default: "cat" }); // in it already
  expect(channelProblems(house([{ ...dm, ...joining(dm, "diet") }]))).toEqual([]); // what it gives keeps the config valid
});

test("config checks: the default is required with two pets, pets must be the house's, one chat once, no two pets answering to one name", () => {
  expect(channelProblems(house([dm]))).toEqual([]);
  expect(channelProblems(house([{ ...dm, pets: ["sibling", "diet"], default: "sibling" }]))).toEqual([]);
  expect(channelProblems(house([{ ...dm, pets: ["sibling", "diet"] }]))).toEqual([
    "houses.work.channels[0]: default is required when a channel has two pets or more (one of sibling, diet)",
  ]);
  expect(channelProblems(house([{ ...dm, pets: ["sibling", "ghost", "sibling"], default: "diet" }]))).toEqual([
    "houses.work.channels[0].pets: 'ghost' is not a pet of house work",
    "houses.work.channels[0].pets: 'sibling' is listed twice",
    "houses.work.channels[0].default: 'diet' is not one of the channel's pets",
  ]);
  expect(channelProblems(house([dm, { ...dm, name: "again", token: "another-secret" }]))).toEqual([
    "houses.work.channels[1]: the same chat as an earlier channel (telegram-private, chat 100200300)",
  ]);
  // Names, titles and aliases of two pets of one channel, case aside; the same pets in different channels are fine.
  const pets = [{ name: "sibling", aliases: ["Síbling"] }, { name: "diet", title: "SÍBLING" }];
  expect(channelProblems(house([{ ...dm, pets: ["sibling", "diet"], default: "sibling" }], pets))).toEqual(["houses.work.channels[0]: pets sibling and diet both answer to 'SÍBLING'"]);
  expect(channelProblems(house([dm, { ...dm, chat: "1", pets: ["diet"] }], pets))).toEqual([]);
});
