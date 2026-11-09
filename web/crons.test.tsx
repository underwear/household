import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BotCrons, cronInWords, relative, whenIn } from "./components/bot-crons";
import { TimezoneSettings } from "./components/timezone-settings";

test("a common cron expression in words; any other stays as it is (null)", () => {
  expect(cronInWords("0 9 * * *")).toBe("Every day at 09:00");
  expect(cronInWords("30 7 * * 1-5")).toBe("Weekdays at 07:30");
  expect(cronInWords("0 10 * * 6,0")).toBe("Weekends at 10:00");
  expect(cronInWords("30 22 * * 0")).toBe("Every Sunday at 22:30");
  expect(cronInWords("0 8 1 * *")).toBe("Monthly on day 1 at 08:00");
  expect(cronInWords("*/15 * * * *")).toBe("Every 15 minutes");
  expect(cronInWords("5 * * * *")).toBe("Every hour at :05");
  expect(cronInWords("0 9 * 1 *")).toBeNull(); // January only: not said in words
  expect(cronInWords("0 9 * *")).toBeNull();
});

test("times: in the Household zone, and how far off", () => {
  expect(whenIn("2026-11-05T08:00:00Z", "Europe/Madrid")).toBe("Thu 5 Nov, 09:00");
  const now = Date.parse("2026-11-05T08:00:00Z");
  expect(relative("2026-11-05T08:20:00Z", now)).toBe("in 20 min");
  expect(relative("2026-11-05T11:00:00Z", now)).toBe("in 3 h");
  expect(relative("2026-11-08T08:00:00Z", now)).toBe("in 3 days");
  expect(relative("2026-11-05T07:55:00Z", now)).toBe("5 min ago");
});

test("a bot's tasks section and the time zone setting render in the design's parts", () => {
  const tasks = renderToStaticMarkup(<BotCrons house="work" pet="sibling" crons={{ view: undefined, error: "", now: 0, refresh: async () => {} }} />);
  expect(tasks).toContain('<h2 class="h2">Scheduled tasks</h2>');
  expect(tasks).toContain('<button class="btn small" disabled="">+ New task</button>'); // until the tasks come
  expect(tasks).toContain("Loading…");
  const zone = renderToStaticMarkup(<TimezoneSettings />);
  expect(zone).toContain('<h2 class="h2">Time zone</h2>');
  expect(zone).toContain('class="control"'); // a select of zones, not a free text field
});
