import { expect, test } from "bun:test";
import { resolveSlackDm } from "../../src/channel-adapters/slack/setup";
import type { SlackApi } from "../../src/channel-adapters/slack/api";

function fake(channel: unknown = { id: "D123", user: "U123", is_im: true }) {
  const calls: string[] = [];
  const api: SlackApi = { async call<T>(method: string) {
    calls.push(method);
    return (method === "auth.test" ? { team_id: "T123", bot_id: "B123", user_id: "UBOT" } : { channel }) as T;
  } };
  return { api, calls };
}
test("resolves a workspace-scoped DM without returning credentials or posting a message", async () => {
  const { api, calls } = fake();
  expect(await resolveSlackDm("private", " U123 ", api)).toEqual({
    chat: "T123:D123", owner: "T123:U123", url: "https://app.slack.com/client/T123/D123",
  });
  expect(calls).toEqual(["auth.test", "conversations.open"]);
});
test("rejects malformed member IDs before contacting Slack", async () => {
  const { api, calls } = fake();
  await expect(resolveSlackDm("private", "T123:U123", api)).rejects.toThrow("member ID");
  expect(calls).toEqual([]);
});
test("does not grant owner access to the bot or an unrelated DM", async () => {
  await expect(resolveSlackDm("private", "UBOT", fake().api)).rejects.toThrow("not the bot");
  for (const channel of [undefined, { id: "D123", user: "UOTHER", is_im: true }, { id: "C123", user: "U123", is_im: false }]) {
    await expect(resolveSlackDm("private", "U123", fake(channel === undefined ? null : channel).api)).rejects.toThrow("personal bot DM");
  }
});
