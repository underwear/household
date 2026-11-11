import { expect, test } from "bun:test";
import { hostProblems, knownChannelKinds, knownPlatforms, ownerProblems } from "../../src/app/kinds";
import { isTelegramId } from "../../src/channel-adapters/telegram";
import { audienceOf, platformOf, type ChannelConfig } from "../../src/core/channels";
import type { House } from "../../src/core/household";

const dm: ChannelConfig = { kind: "telegram-private", token: "b", chat: "100200300", pets: [] };
const house = (owners: House["people"]["owners"], channels = [dm]): House => ({ name: "work", network: { kind: "allowlist", allow: [] }, pets: [], people: { owners }, channels });

test("the kinds' descriptors are the one source of a kind: its platform and audience; each platform a kind is on is described once", () => {
  const kinds = knownChannelKinds();
  expect([...kinds.keys()]).toEqual(["telegram-dm", "telegram-group", "slack-private", "telegram-private"]);
  expect(platformOf(kinds, "telegram-private")).toBe("telegram");
  expect(audienceOf(kinds, "telegram-private")).toBe("private");
  expect(audienceOf(kinds, "telegram-group")).toBe("group"); // unknown: the safer guess
  for (const kind of kinds.values()) expect(knownPlatforms().has(kind.platform)).toBe(true);
});

test("a Telegram user id: digits up to 2^53 − 1, compared as written", () => {
  for (const good of ["1", "100200300", "9007199254740991"]) expect(isTelegramId(good)).toBe(true);
  for (const bad of ["0", "01", "-1", "1.5", "@oleg", "9007199254740992", "123456789012345678901"]) expect(isTelegramId(bad)).toBe(false);
});

test("owners: validate assigned identities, while channels do not require an owner", () => {
  const platforms = knownPlatforms();
  expect(ownerProblems(platforms, [house([{ platform: "telegram", id: "100200300" }])])).toEqual([]);
  expect(ownerProblems(platforms, [house([{ platform: "telegram", id: "@oleg" }])])).toEqual([
    "houses.work.people.owners.telegram: '@oleg' is not a Telegram user id (A number; @userinfobot tells yours.)",
  ]);
  expect(ownerProblems(platforms, [house([])])).toEqual([]);
  expect(ownerProblems(platforms, [house([{ platform: "slack", id: "TTEST:UOWNER" }])])).toEqual([]); // owner on another platform
  expect(ownerProblems(platforms, [house([], [])])).toEqual([]);
});

test("pets given more than the host has: a line per pet and resource, the defaults counted for unset values", () => {
  const pets = [{ name: "owl", cpus: 4, memoryMiB: 4096 }, { name: "cat" }, { name: "big", cpus: 16, memoryMiB: 8192 }];
  const houses = [{ ...house([]), pets }];
  expect(hostProblems({ cpus: 16, memoryMiB: 8192 }, houses)).toEqual([]); // all of the host: fits
  expect(hostProblems({ cpus: 4, memoryMiB: 4096 }, houses)).toEqual([
    "bot work/big: 16 vCPU, more than this host's 4",
    "bot work/big: 8 GiB of RAM, more than this host's 4 GiB",
  ]);
  expect(hostProblems({ cpus: 1, memoryMiB: 1024 }, [{ ...house([]), pets: [{ name: "cat" }] }])).toEqual(["bot work/cat: 2 vCPU, more than this host's 1"]); // the default too
});
