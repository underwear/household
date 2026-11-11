import { afterAll, expect, test } from "bun:test";
import { watchSetup, type Contact, type FoundGroup } from "../../src/channel-adapters/telegram";

/**
 * A Bot API over a fixed list of updates (offset n: those from n on), and a group whose settings the test changes:
 * the bot added to group -1005 before the watch starts, then an older private message, a bot's, and the owner's.
 */
const updates = [
  { update_id: 10, my_chat_member: { chat: { id: -1005, type: "supergroup", title: "Home" }, new_chat_member: { status: "member" } } },
  { update_id: 11, message: { chat: { id: 1, type: "private" }, from: { id: 1, first_name: "Old" } } },
  { update_id: 12, message: { chat: { id: 3, type: "private" }, from: { id: 3, first_name: "Bot", is_bot: true } } },
  { update_id: 13, message: { chat: { id: 777, type: "private" }, from: { id: 777, first_name: "Igor", last_name: "F", username: "igor" } } },
  { update_id: 14, my_chat_member: { chat: { id: -1005, type: "supergroup", title: "Home" }, new_chat_member: { status: "administrator" } } },
];
let backlog = 2; // the bot was added, and someone wrote, before the watch
const offsets: number[] = [];
const member = { status: "member", can_manage_topics: false, can_delete_messages: false };
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1);
    const body = (await request.json()) as { offset?: number };
    if (method === "getChat") return Response.json({ ok: true, result: { id: -1005, type: "supergroup", title: "Home", is_forum: true } });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 4242, is_bot: true } });
    if (method === "getChatMember") return Response.json({ ok: true, result: member });
    offsets.push(body.offset ?? 0);
    const known = updates.slice(0, backlog);
    if (offsets.length > 1) { backlog = 4; } // the owner writes once we wait
    if (offsets.length > 3) { backlog = updates.length; Object.assign(member, { status: "administrator", can_manage_topics: true, can_delete_messages: true }); } // then makes the bot an admin
    return Response.json({ ok: true, result: known.filter((update) => update.update_id >= (body.offset ?? 0)) });
  },
});
afterAll(() => server.stop());

test("the owner is the first to write privately from now on; the group is found from before, checked, and checked again as it changes", async () => {
  const contacts: Contact[] = [];
  const groups: FoundGroup[] = [];
  const end = await watchSetup("4242:token", { apiBase: `http://127.0.0.1:${server.port}`, timeoutMs: 5000, group: true, onContact: (contact) => contacts.push(contact), onGroup: (group) => groups.push(group) });
  expect(end).toBe("done");
  expect(contacts).toEqual([{ id: "777", name: "Igor F", username: "igor" }]); // not the older message, not the bot
  expect(groups[0]).toEqual({ id: "-1005", title: "Home", problems: ["make the bot an administrator of the group, with Manage topics and Delete messages"] });
  expect(groups.at(-1)).toEqual({ id: "-1005", title: "Home", problems: [] });
  expect(offsets[0]).toBe(0); // the backlog is read for the group
  expect(offsets[1]).toBe(12); // the private message already there is passed over for the owner
  expect(offsets.at(-1)).toBe(15); // confirmed, so the daemon does not get it again
});

test("a group that became a supergroup (Topics on) is followed to its new id; its old id is never taken back", async () => {
  // As Telegram sent them for a real bot: added to the new supergroup, the migration both ways, then promoted.
  const migration = [
    { update_id: 7, my_chat_member: { chat: { id: -1004391098876, type: "supergroup", title: "Ours" }, new_chat_member: { status: "member" } } },
    { update_id: 8, message: { chat: { id: -1004391098876, type: "supergroup", title: "Ours" }, migrate_from_chat_id: -5198099867 } },
    { update_id: 9, message: { chat: { id: -5198099867, type: "group", title: "Ours" }, migrate_to_chat_id: -1004391098876 } },
    { update_id: 10, my_chat_member: { chat: { id: -1004391098876, type: "supergroup", title: "Ours" }, new_chat_member: { status: "administrator" } } },
  ];
  const asked: string[] = [];
  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split("/").at(-1);
      const body = (await request.json()) as { offset?: number; chat_id?: number };
      if (method === "getChat") { asked.push(String(body.chat_id)); return Response.json({ ok: true, result: body.chat_id === -5198099867 ? { id: -5198099867, type: "group", title: "Ours" } : { id: -1004391098876, type: "supergroup", title: "Ours", is_forum: true } }); }
      if (method === "getMe") return Response.json({ ok: true, result: { id: 4242, is_bot: true } });
      if (method === "getChatMember") return Response.json({ ok: true, result: body.chat_id === -5198099867 ? { status: "member" } : { status: "administrator", can_manage_topics: true, can_delete_messages: true } });
      return Response.json({ ok: true, result: (body.offset ?? 0) === 0 ? migration : [] });
    },
  });
  const groups: FoundGroup[] = [];
  await watchSetup("4242:token", { apiBase: `http://127.0.0.1:${api.port}`, timeoutMs: 300, group: true, onContact: () => {}, onGroup: (found) => groups.push(found) });
  api.stop();
  expect(asked).not.toContain("-5198099867");
  expect(groups.at(-1)).toEqual({ id: "-1004391098876", title: "Ours", problems: [] });
});
