import { afterEach, expect, test } from "bun:test";
import { isBotToken, telegramBotToken } from "../../src/channel-adapters/telegram";
import { fakeTelegram } from "../fake-telegram";
import { waitFor } from "../helpers";

const BOT = `4242:${"A".repeat(35)}`;
const OTHER = `4343:${"C".repeat(35)}`;
const stops: (() => unknown)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("a bot token's shape: the bot's id (1–20 digits), a colon, 30 or more of [A-Za-z0-9_-]; nothing else goes to Telegram", () => {
  expect(isBotToken(BOT)).toBe(true);
  for (const bad of ["telegram-work", "sk-ant-x", "4242:short", `${"1".repeat(21)}:${"A".repeat(35)}`, ` ${BOT}`, `4242:${"A".repeat(34)}!`]) expect(isBotToken(bad)).toBe(false);
});

test("what a token is: from memory at once (its bot's id at first), asked in the background; after a failure not again until the pause is over", async () => {
  const api = fakeTelegram(BOT, OTHER);
  stops.push(api.stop);
  let clock = 0;
  const tokens = telegramBotToken(api.url, () => clock);
  expect(tokens.describe(BOT)).toBe("bot 4242"); // never waits
  await waitFor(() => tokens.describe(BOT) === "@fake_bot");
  expect(api.sent("getMe")).toHaveLength(1);
  api.fail("getMe", 502, "Bad Gateway");
  expect(tokens.describe(OTHER)).toBe("bot 4343");
  await waitFor(() => api.sent("getMe").length === 2);
  await Bun.sleep(20);
  expect(tokens.describe(OTHER)).toBe("bot 4343");
  expect(api.sent("getMe")).toHaveLength(2); // Telegram could not tell: not asked again at once
  clock += 30_000;
  tokens.describe(OTHER);
  await waitFor(() => tokens.describe(OTHER) === "@fake_bot");
  expect(tokens.describe("telegram-work")).toBeNull(); // not a token: never sent
  expect(tokens.identityOf(BOT)).toBe("4242");
  expect(tokens.identityOf("telegram-work")).toBeUndefined();
  await Bun.sleep(20);
  expect(api.sent("getMe")).toHaveLength(3);
});
