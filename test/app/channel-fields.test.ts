import { afterAll, expect, test } from "bun:test";
import { channelChecks, checkFields, fieldsShown } from "../../src/app/channel-fields";
import { knownChannelKinds } from "../../src/app/kinds";
import type { ChannelConfig } from "../../src/core/channels";
import type { House, Household } from "../../src/core/household";
import { fakeTelegram } from "../fake-telegram";

const TOKEN = "4242:fake-token-for-the-channel-fields-test";
const NEW = "4242:another-token-of-the-same-bot-000000000";
const OTHER = "777:a-token-of-another-bot-000000000000000";
const telegram = fakeTelegram(TOKEN, NEW, OTHER);
afterAll(() => telegram.stop());

const channel = (chat: string, token: string): ChannelConfig => ({ kind: "telegram-private", token, chat, pets: [] });
const house = (name: string, channels: ChannelConfig[]): House => ({ name, network: { kind: "allowlist", allow: [] }, pets: [], people: { owners: [] }, channels });
const household = (...houses: House[]): Household => ({ daemon: {}, keys: [], houses });

test("a token given is checked with Telegram and kept trimmed; one the channel has is not asked about again; empty is refused", async () => {
  const checks = channelChecks(telegram.url);
  const kinds = knownChannelKinds();
  const at = { household: household(house("work", [channel("1", TOKEN)])), house: "work" };
  expect(await checkFields(kinds, checks, "telegram-private", { token: ` ${OTHER} ` }, at)).toEqual({ own: { token: OTHER }, also: [] });
  await expect(checkFields(kinds, checks, "telegram-private", { token: "not a token" }, at)).rejects.toThrow("that is not a bot token");
  await expect(checkFields(kinds, checks, "telegram-private", { token: "  " }, at)).rejects.toThrow("Bot token is required");
  const asked = telegram.sent("getMe").length;
  expect((await checkFields(kinds, checks, "telegram-private", { token: TOKEN }, { ...at, chat: "1" })).own).toEqual({ token: TOKEN });
  expect(telegram.sent("getMe").length).toBe(asked);
});

test("one bot, one house: another house's bot is refused; this house's other channels on the bot take its new token", async () => {
  const checks = channelChecks(telegram.url);
  const kinds = knownChannelKinds();
  const both = household(house("work", [channel("1", TOKEN), channel("2", TOKEN)]), house("home", [channel("3", OTHER)]));
  await expect(checkFields(kinds, checks, "telegram-private", { token: OTHER }, { household: both, house: "work" })).rejects.toThrow("is workspace home's bot, and a bot serves one workspace");
  const rotated = await checkFields(kinds, checks, "telegram-private", { token: NEW }, { household: both, house: "work", chat: "1" });
  expect(rotated).toEqual({ own: { token: NEW }, also: [{ chat: "2", fields: { token: NEW } }] });
});

test("a token shows as its bot: its id at once, its @username once Telegram told", async () => {
  const checks = channelChecks(telegram.url);
  expect(fieldsShown(checks, channel("1", "not a token"))).toEqual({ token: null });
  expect(fieldsShown(checks, channel("1", TOKEN))).toEqual({ token: "bot 4242" });
  await Bun.sleep(100);
  expect(fieldsShown(checks, channel("1", TOKEN))).toEqual({ token: "@fake_bot" });
});

test("ordinary Telegram DM accepts a bot with Threaded Mode off", async () => {
  const api = fakeTelegram(TOKEN);
  api.botInfo.has_topics_enabled = false;
  try {
    const checks = channelChecks(api.url);
    const at = { household: household(house("work", [])), house: "work" };
    expect((await checkFields(knownChannelKinds(), checks, "telegram-dm", { token: TOKEN }, at)).own).toEqual({ token: TOKEN });
    await expect(checkFields(knownChannelKinds(), checks, "telegram-private", { token: TOKEN }, at)).rejects.toThrow("threads off");
  } finally { api.stop(); }
});
