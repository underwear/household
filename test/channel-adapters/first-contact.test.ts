import { afterAll, expect, test } from "bun:test";
import { firstPrivateContact } from "../../src/channel-adapters/telegram";

/** getUpdates over a fixed list: offset -1 gives the last, offset n those from n on. */
const updates = [
  { update_id: 10, message: { chat: { id: 1, type: "private" }, from: { id: 1, first_name: "Old" } } },
  { update_id: 11, message: { chat: { id: -5, type: "supergroup" }, from: { id: 2, first_name: "Group" } } },
  { update_id: 12, message: { chat: { id: 3, type: "private" }, from: { id: 3, first_name: "Bot", is_bot: true } } },
  { update_id: 13, message: { chat: { id: 777, type: "private" }, from: { id: 777, first_name: "Igor", last_name: "F", username: "igor" } } },
];
let backlog = 1; // updates[0] was there before we started
const offsets: number[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { offset = 0 } = (await request.json()) as { offset?: number };
    offsets.push(offset);
    const known = updates.slice(0, backlog);
    backlog = updates.length; // the rest arrive once we wait
    const result = offset === -1 ? known.slice(-1) : known.filter((update) => update.update_id >= offset);
    return Response.json({ ok: true, result });
  },
});
afterAll(() => server.stop());

test("the first person writing privately from now on, past older messages, groups and bots; what was read is confirmed", async () => {
  const contact = await firstPrivateContact("4242:token", { apiBase: `http://127.0.0.1:${server.port}`, timeoutMs: 5000 });
  expect(contact).toEqual({ id: "777", name: "Igor F", username: "igor" });
  expect(offsets[0]).toBe(-1);
  expect(offsets[1]).toBe(11); // the update already there is skipped
  expect(offsets.at(-1)).toBe(14); // confirmed, so the daemon does not get it again
});
