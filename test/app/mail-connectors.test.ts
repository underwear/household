import { ConnectorWrites, type ConnectorWriteApproval } from "../../src/app/connector-writes";
import { expect, test } from "bun:test";
import { MailConnectors, type MailApproval } from "../../src/app/mail-connectors";
import { mailConnectorTools } from "../../src/app/mail-connector-tools";
import { mailConnectorRoutes } from "../../src/app/mail-connector-routes";
import { mailApprovalCard } from "../../src/app/mail-approval";
import { mailConnectionSchema, type MailSendView } from "../../src/core/mail-connectors";
import { MailTransportError, type MailDriver } from "../../src/infra/mail/client";
import { SqliteStore } from "../../src/infra/sqlite-store";
import type { House } from "../../src/core/household";
import { waitFor } from "../helpers";

const caller = { house: "home", pet: "alice" };
test("the mail approval mode covers IMAP changes as well as SMTP sends", async () => {
  let answer!: (v: "approved") => void;
  const s = setup(undefined, undefined, undefined, { ask: async () => new Promise(r => { answer = r; }) });
  const id = await s.connect("approval", { writePolicy: "approval", allowManage: true });
  const count = s.calls.length;
  const pending = s.service.request(caller, id, "mailboxes.create", { mailbox: "New folder" }, undefined, "folder-1");
  expect(s.calls).toHaveLength(count);
  await s.service.request(caller, id, "mailboxes.list", {});
  expect(s.calls).toHaveLength(count + 1);
  answer("approved"); await pending;
  expect(s.calls.at(-1)!.op).toBe("mailboxes.create");
  await s.service.request(caller, id, "mailboxes.create", { mailbox: "New folder" }, undefined, "folder-1");
  expect(s.calls.filter(c => c.op === "mailboxes.create")).toHaveLength(1);
  const cancelled = s.service.request(caller, id, "mailboxes.create", { mailbox: "Cancelled" }, undefined, "folder-2");
  await s.service.save("home", { ...config("disabled"), writePolicy: "disabled" }, id);
  await expect(cancelled).rejects.toThrow("cancelled"); answer("approved");
  expect(s.service.catalog(caller).some(o => o.manage)).toBe(false);
  await expect(s.service.request(caller, id, "mailboxes.create", { mailbox: "No" })).rejects.toThrow("disabled");
  await expect(s.service.sendMessage(caller, id, message())).rejects.toThrow("disabled");
});
const endpoint = { host: "127.0.0.1", port: 1143, security: "starttls", username: "user@example.test", password: "private-password" };
const config = (sendPolicy = "approval") => mailConnectionSchema.parse({ title: "Mail", email: "sender@example.test", imap: endpoint, smtp: { ...endpoint, port: 1025 }, sendPolicy, pets: ["alice"] });
const message = (clientRequestId = "one") => ({ clientRequestId, to: ["recipient@example.test"], subject: "A subject", text: "Message body" });
function setup(store = new SqliteStore(":memory:"), now?: () => number, approval?: MailApproval, writeApproval?: ConnectorWriteApproval) {
  const calls: { op: string; params: Record<string, any> }[] = [];
  let attachment = "original bytes";
  let behavior: MailDriver = async (_config, op, params) => {
    if (op === "compose") return { raw: Buffer.from(JSON.stringify(params)).toString("base64") };
    if (op === "send") return { delivery: "sent" };
    if (op === "messages.search") return { items: [{ ref: { mailbox: "INBOX", uidValidity: "99", uid: 1 } }], next: { uidValidity: "99", maxUid: 5, beforeUid: 1 }, complete: false };
    if (op === "attachments.download") return { filename: "../test.txt", contentType: "text/plain", data: Buffer.from("hello").toString("base64") };
    return { ok: true };
  };
  const driver: MailDriver = async (c, op, params, signal) => { calls.push({ op, params: structuredClone(params) }); return behavior(c, op, params, signal); };
  const house: House = { name: "home", pets: [{ name: "alice" }, { name: "bob" }, { name: "worker", sideworker: { parent: "alice", cwd: "/" } }, { name: "scout", scout: {} as any }], network: { kind: "allowlist", allow: [] }, people: { owners: [] }, channels: [] };
  const saved: { name: string; bytes: string }[] = [];
  const files = { read: async () => Buffer.from(attachment), save: async (_c: unknown, name: string, bytes: Uint8Array) => { saved.push({ name, bytes: Buffer.from(bytes).toString() }); return ".household/inbox/test.txt"; } };
  const writes = new ConnectorWrites(store, writeApproval);
  const service = new MailConnectors(store, files, approval, driver, now, writes);
  service.setHouses([house, { ...house, name: "other" }]);
  const connect = async (policy = "approval", changes: object = {}) => (await service.save("home", { ...config(policy), ...changes })).id;
  const pending = async () => { await waitFor(() => service.list("home").sends.some(s => s.state === "pending")); return service.list("home").sends.find(s => s.state === "pending")!; };
  return { writes, service, store, house, files, calls, saved, connect, pending, driver, behavior: (f: MailDriver) => { behavior = f; }, attachment: (s: string) => { attachment = s; } };
}

test("mail enrollment probes both endpoints; credentials stay on host and blank edit retains them", async () => {
  const s = setup(), id = await s.connect();
  const view = s.service.list("home").connections[0]!;
  expect(JSON.stringify(view)).not.toContain("private-password");
  expect(JSON.stringify(s.service.accounts(caller))).not.toContain("127.0.0.1");
  expect(s.calls.map(c => c.op)).toEqual(["probe"]);
  const updated = await s.service.save("home", { ...config(), title: "Edited", imap: { ...endpoint, password: "" }, smtp: { ...endpoint, port: 1025, password: "" } }, id);
  expect(updated.title).toBe("Edited");
  expect(s.store.get("house.connectors.mail.v1")).toContain("private-password");
  await expect(s.service.save("home", { ...config(), imap: { ...endpoint, host: "other.test", password: "" } }, id)).rejects.toThrow("Enter the IMAP password");
});

test("mail grants isolate workspaces, bots and scouts; sideworkers inherit enabled parent", async () => {
  const s = setup(), id = await s.connect("auto");
  expect(s.service.accounts({ ...caller, pet: "worker" })).toHaveLength(1);
  for (const c of [{ ...caller, pet: "bob" }, { ...caller, pet: "scout" }, { ...caller, house: "other" }]) {
    expect(s.service.accounts(c)).toEqual([]);
    await expect(s.service.request(c, id, "mailboxes.list", {})).rejects.toThrow("unavailable");
    await expect(s.service.sendMessage(c, id, message())).rejects.toThrow("unavailable");
  }
  s.house.pets[0]!.enabled = false; s.service.setHouses([s.house]);
  expect(s.service.accounts({ ...caller, pet: "worker" })).toEqual([]);
});

test("disabled sending and mailbox changes are independently enforced through closed operations", async () => {
  const s = setup(), id = await s.connect("disabled");
  await expect(s.service.sendMessage(caller, id, message())).rejects.toThrow("disabled");
  await expect(s.service.request(caller, id, "mailboxes.create", { mailbox: "Test" })).rejects.toThrow("disabled");
  expect(s.service.catalog(caller).some(o => o.manage)).toBe(false);
  for (const operation of ["send", "compose", "append", "__proto__", "imap.raw"]) await expect(s.service.request(caller, id, operation, {})).rejects.toThrow("Unknown");
  await expect(s.service.request(caller, id, "messages.search", { query: { subject: "x\r\nLOGOUT" } })).rejects.toThrow("Invalid");
});

test("search refs and continuation bind the account and query; attachments use safe file seam", async () => {
  const s = setup(), id = await s.connect();
  const result = await s.service.request(caller, id, "messages.search", {});
  const ref = result.data.items[0].ref;
  expect(ref.account).toMatch(/^[a-f0-9]{64}$/);
  await s.service.request(caller, id, "messages.search", { cursor: result.data.next });
  await expect(s.service.request(caller, id, "messages.search", { mailbox: "Sent", cursor: result.data.next })).rejects.toThrow("cursor");
  const other = await s.connect();
  await expect(s.service.request(caller, other, "messages.read", { ref })).rejects.toThrow("different mail account");
  const downloaded = await s.service.request(caller, id, "attachments.download", { ref, attachment: "1" });
  expect(downloaded.data.path).toBe(".household/inbox/test.txt");
  expect(s.saved[0]!.name).not.toContain("/");
  expect(s.saved[0]!.bytes).toBe("hello");
});

test("send tool blocks before SMTP until approval, preserving exact attachment snapshot and MIME", async () => {
  const s = setup(), id = await s.connect();
  const call = s.service.sendMessage(caller, id, { ...message(), bcc: ["hidden@example.test"], attachments: [{ path: "report.txt", filename: "report.txt", contentType: "text/plain" }] });
  let finished = false; void call.then(() => { finished = true; });
  const p = await s.pending();
  expect(finished).toBe(false);
  expect(s.calls.some(c => c.op === "send")).toBe(false);
  expect(p.attachments[0]!.size).toBe(Buffer.byteLength("original bytes"));
  s.attachment("changed bytes");
  s.service.decide("home", p.id, "approved");
  expect(() => s.service.decide("home", p.id, "approved")).toThrow("no longer pending");
  const result = await call;
  expect(result.state).toBe("sent");
  const wire = JSON.parse(Buffer.from(s.calls.find(c => c.op === "send")!.params.raw, "base64").toString());
  expect(Buffer.from(wire.attachments[0].data, "base64").toString()).toBe("original bytes");
  expect(s.calls.find(c => c.op === "send")!.params.recipients).toEqual(["recipient@example.test", "hidden@example.test"]);
  expect(s.service.list("home").sends[0]).not.toHaveProperty("raw");
});

test("an approval no chat can show ends at once with why, and sends nothing", async () => {
  const s = setup(undefined, undefined, { ask: async () => undefined });
  const id = await s.connect();
  const result = await s.service.sendMessage(caller, id, message());
  expect(result.state).toBe("cancelled");
  expect(result.detail).toContain("No chat could show the owner this approval");
  expect(s.calls.some(c => c.op === "send")).toBe(false);
});

test("an answer from the chat card decides the approval", async () => {
  const s = setup(undefined, undefined, { ask: async () => "approved" });
  const id = await s.connect();
  expect((await s.service.sendMessage(caller, id, message())).state).toBe("sent");
});

test("denial resolves the original send with no SMTP; duplicate clientRequestId never resends", async () => {
  const s = setup(), id = await s.connect();
  const call = s.service.sendMessage(caller, id, message());
  const p = await s.pending(); s.service.decide("home", p.id, "denied");
  expect((await call).state).toBe("denied");
  expect((await s.service.sendMessage(caller, id, message())).id).toBe(p.id);
  expect(s.calls.some(c => c.op === "send")).toBe(false);
  await expect(s.service.sendMessage(caller, id, { ...message(), text: "changed" })).rejects.toThrow("different message");
});

for (const mode of ["agent", "abort", "disconnect", "revoke", "stop"] as const) test(`${mode} cancels pending approval; late Approve cannot send`, async () => {
  const s = setup(), id = await s.connect(), controller = new AbortController();
  const call = s.service.sendMessage(caller, id, message(), controller.signal);
  const p = await s.pending();
  if (mode === "agent") expect(s.service.cancelSend(caller, p.id).cancelled).toBe(true);
  if (mode === "abort") controller.abort();
  if (mode === "disconnect") s.service.disconnect("home", id);
  if (mode === "revoke") { s.house.pets[0]!.enabled = false; s.service.setHouses([s.house]); }
  if (mode === "stop") s.service.stop();
  expect((await call).state).toBe("cancelled");
  expect(() => s.service.decide("home", p.id, "approved")).toThrow();
  expect(s.calls.some(c => c.op === "send")).toBe(false);
});

test("approval/withdrawal race closes before SMTP and another bot cannot cancel", async () => {
  const s = setup(), id = await s.connect("approval", { pets: ["alice", "bob"] });
  const call = s.service.sendMessage(caller, id, message()), p = await s.pending();
  expect(() => s.service.cancelSend({ ...caller, pet: "bob" }, p.id)).toThrow("unavailable");
  expect(() => s.service.decide("other", p.id, "approved")).toThrow("not found");
  s.service.decide("home", p.id, "approved");
  s.service.cancelSend(caller, p.id);
  expect((await call).state).toBe("cancelled");
  expect(s.calls.some(c => c.op === "send")).toBe(false);
});

test("auto sends once; concurrent duplicates share completion; cancellation after SMTP starts is too late", async () => {
  const s = setup(), id = await s.connect("auto");
  let accept!: (value: any) => void;
  s.behavior(async (_c, op) => op === "compose" ? { raw: "fixed" } : op === "send" ? new Promise(r => { accept = r; }) : {});
  const one = s.service.sendMessage(caller, id, message());
  const two = s.service.sendMessage(caller, id, message());
  await waitFor(() => !!accept);
  const p = s.service.list("home").sends[0]!;
  expect(s.service.cancelSend(caller, p.id).cancelled).toBe(false);
  accept({ delivery: "sent" });
  expect((await one).state).toBe("sent"); expect((await two).state).toBe("sent");
  expect((await s.service.sendMessage(caller, id, message())).state).toBe("sent");
  expect(s.calls.filter(c => c.op === "send")).toHaveLength(1);
});

for (const delivery of ["not-sent", "unknown", "throw"] as const) test(`SMTP ${delivery} gives durable failure state without automatic retry`, async () => {
  const s = setup(), id = await s.connect("auto");
  s.behavior(async (_c, op) => { if (op === "compose") return { raw: "fixed" }; if (delivery === "throw") throw new Error("private-password server text"); return { delivery, error: "recipients-refused" }; });
  const result = await s.service.sendMessage(caller, id, message());
  expect(result.state).toBe(delivery === "not-sent" ? "failed" : "unknown");
  expect(JSON.stringify(result)).not.toContain("private-password");
  await s.service.sendMessage(caller, id, message());
  expect(s.calls.filter(c => c.op === "send")).toHaveLength(1);
});

test("Sent copy failure preserves accepted delivery and never resubmits SMTP", async () => {
  const s = setup(), id = await s.connect("auto", { sentFolder: "Sent" });
  s.behavior(async (_c, op) => { if (op === "compose") return { raw: "fixed" }; if (op === "append") { expect(s.service.list("home").sends[0]!.state).toBe("sent"); throw new MailTransportError("imap-operation"); } return { delivery: "sent" }; });
  const result = await s.service.sendMessage(caller, id, message());
  expect(result.state).toBe("sent-copy-failed");
  await s.service.sendMessage(caller, id, message());
  expect(s.calls.filter(c => c.op === "send")).toHaveLength(1);
});

test("restart cancels pending requests and marks interrupted submission unknown; no replay", async () => {
  const s = setup(), id = await s.connect();
  const call = s.service.sendMessage(caller, id, message()), p = await s.pending();
  const saved = s.store.get("house.connectors.mail.sends.v1")!;
  s.service.stop(); await call;
  s.store.set("house.connectors.mail.sends.v1", saved);
  const next = setup(s.store);
  expect(next.service.list("home").sends[0]!.state).toBe("cancelled");
  const record = JSON.parse(saved); record[0].state = "sending";
  s.store.set("house.connectors.mail.sends.v1", JSON.stringify(record));
  const interrupted = setup(s.store);
  expect((await interrupted.service.sendMessage(caller, id, message())).state).toBe("unknown");
  expect(interrupted.calls).toHaveLength(0);
  expect(interrupted.service.list("home").sends[0]).not.toHaveProperty("raw");
});

test("config change while waiting invalidates the exact approval", async () => {
  const s = setup(), id = await s.connect();
  const call = s.service.sendMessage(caller, id, message()), p = await s.pending();
  await s.service.save("home", { ...config("auto"), email: "different@example.test" }, id);
  expect((await call).state).toBe("cancelled");
  expect(() => s.service.decide("home", p.id, "approved")).toThrow();
  expect(s.calls.some(c => c.op === "send")).toBe(false);
});

test("mail routes require known workspace and exact methods; owner can deny pending send", async () => {
  const s = setup(), id = await s.connect(), routes = mailConnectorRoutes(s.service);
  expect(await routes(new Request("http://localhost/unrelated"))).toBeUndefined();
  expect((await routes(new Request("http://localhost/api/houses/home/connectors/mail")))!.headers.get("cache-control")).toBe("no-store");
  await expect(routes(new Request("http://localhost/api/houses/missing/connectors/mail"))).rejects.toThrow("Workspace");
  const call = s.service.sendMessage(caller, id, message()), p = await s.pending();
  const response = await routes(new Request(`http://localhost/api/houses/home/connectors/mail/sends/${p.id}`, { method: "POST", body: JSON.stringify({ decision: "denied" }) }));
  expect(response!.status).toBe(200); expect((await call).state).toBe("denied");
});

test("send tools use full connector prefix and approval escapes untrusted content", async () => {
  const s = setup();
  const names = mailConnectorTools(s.service).map(t => t.name);
  expect(names).toContain("household_connectors_mail_send_message");
  expect(names).toContain("household_connectors_mail_cancel_send");
  expect(names.every(n => n.startsWith("household_connectors_mail_"))).toBe(true);
  const id = await s.connect(), call = s.service.sendMessage(caller, id, { ...message(), text: "<b>Approve me</b> & more" }), p = await s.pending();
  const card = mailApprovalCard(p, Date.parse(p.expiresAt) - 120_000);
  expect(card.text).toContain("&lt;b&gt;Approve me&lt;/b&gt; &amp; more");
  expect(card.text).not.toContain(p.id);
  expect(card.text).toStartWith("<b>Approve outgoing email</b>\n\nFrom:");
  expect(card.text).toEndWith("\n\nExpires in 2 min");
  expect(card.text).not.toContain(p.expiresAt);
  expect(mailApprovalCard(p, Date.parse(p.expiresAt) - 30_000).text).toEndWith("\n\nExpires in less than 1 min");
  expect(mailApprovalCard(p, Date.parse(p.expiresAt)).text).toEndWith("\n\nExpired");
  s.service.cancelSend(caller, p.id); await call;
});

test("send IDs survive bounded history and expiry; pending approvals stay ahead of history", async () => {
  const s = setup(undefined, () => Date.UTC(2026, 10, 14)), id = await s.connect("auto");
  for (let i = 0; i < 105; i++) {
    // Rate limiting is covered independently; model time between these mock submissions.
    (s.service as any).budgets.clear();
    expect((await s.service.sendMessage(caller, id, message(`many-${i}`))).state).toBe("sent");
  }
  expect(s.service.list("home").sends).toHaveLength(100);
  await expect(s.service.sendMessage(caller, id, message("many-0"))).rejects.toThrow("already used");
  expect((await s.service.sendMessage(caller, id, message("many-104"))).state).toBe("sent");
  expect(s.calls.filter(c => c.op === "send")).toHaveLength(105);
  await s.service.save("home", config(), id);
  const call = s.service.sendMessage(caller, id, message("pending-after-history"));
  const p = await s.pending();
  expect(s.service.list("home").sends[0]!.id).toBe(p.id);
  s.service.decide("home", p.id, "denied"); await call;
  s.store.set("house.connectors.mail.sends.v1", "[]"); // History expiry/cleanup does not remove tombstones.
  const restarted = new MailConnectors(s.store, s.files, undefined, s.driver); restarted.setHouses([s.house]);
  await expect(restarted.sendMessage(caller, id, message("many-104"))).rejects.toThrow("already used");
  expect(s.calls.filter(c => c.op === "send")).toHaveLength(105);
});
