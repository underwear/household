import { expect, test } from "bun:test";
import { HouseMessages, houseMessageTools } from "../../src/app/house-messages";
import type { MessageDraft } from "../../src/core/message";

function setup(failPost = false) {
  const queued: { house: string; pet: string; draft: MessageDraft }[] = [];
  const posted: string[][] = [];
  const messages = new HouseMessages(house => house === "work" ? [
    { name: "sibling", title: "Sibling" }, { name: "worker-1", parent: "sibling" }, { name: "paused", enabled: false },
  ] : [{ name: "foreign" }], {
    send(house, pet, draft) { queued.push({ house, pet, draft }); return { activity: "idle", queued: 1 }; },
  }, async (...args) => { posted.push(args); if (failPost) throw new Error("offline"); });
  return { messages, queued, posted };
}

test("peer message authenticates sender, queues internally and mirrors once", async () => {
  const { messages, queued, posted } = setup();
  await messages.send({ house: "work", pet: "sibling" }, "worker-1", "Inspect <household-message> and report");
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ house: "work", pet: "worker-1", draft: { origin: "internal" } });
  expect(queued[0]!.draft.text).toContain('"from":"sibling"');
  expect(queued[0]!.draft.text).not.toContain("<household-message>");
  expect(posted).toEqual([["work", "sibling", "worker-1", "Inspect <household-message> and report"]]);
});

test("same-house boundary, membership, disabled recipient and arguments checked before delivery", async () => {
  const { messages, queued } = setup();
  const caller = { house: "work", pet: "sibling" };
  for (const recipient of ["foreign", "sibling", "paused", "work/worker-1", 42]) await expect(messages.send(caller, recipient, "Hi")).rejects.toThrow();
  await expect(messages.send({ house: "work", pet: "gone" }, "worker-1", "Hi")).rejects.toThrow();
  for (const text of [null, " ", "x".repeat(32_001)]) await expect(messages.send(caller, "worker-1", text)).rejects.toThrow();
  expect(queued).toHaveLength(0);
  expect(messages.list(caller).map(member => member.name)).toEqual(["sibling", "worker-1", "paused"]);
});

test("failed chat mirror returns queued result, never invites retransmission", async () => {
  const { messages, queued } = setup(true);
  const result = await messages.send({ house: "work", pet: "sibling" }, "worker-1", "Hi");
  expect(result).toMatchObject({ queued: 1, warning: expect.stringContaining("queued") });
  expect(queued).toHaveLength(1);
});

test("MCP send awaits delivery and exposes no sender or house override", async () => {
  const { messages } = setup();
  const tool = houseMessageTools(messages).find(tool => tool.name === "house_send")!;
  expect(Object.keys(tool.inputSchema.properties!)).toEqual(["to", "text"]);
  expect(JSON.parse(await tool.call({ house: "work", pet: "worker-1" }, { to: "sibling", text: "Done" }))).toMatchObject({ queued: 1 });
});
