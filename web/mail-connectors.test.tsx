import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MailConnectionView, MailSendView } from "./api";
import { MAIL_NO_CHAT } from "../src/core/mail-connectors";
import { MailSetup, mailAccessWords, mailInput, mailNotices } from "./components/mail-connectors";
import { CONNECTOR_TYPES } from "./components/workspace-connectors";

const view: MailConnectionView = {
  id: "c1", title: "Personal", email: "me@proton.me", displayName: "Me", connectedAt: "2026-11-01T00:00:00Z",
  imap: { host: "127.0.0.1", port: 1143, username: "me@proton.me", security: "starttls", tlsCertificate: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----" },
  smtp: { host: "127.0.0.1", port: 1025, username: "me@proton.me", security: "starttls" },
  sendPolicy: "approval", allowManage: false, draftsFolder: "Drafts", trashFolder: "Trash", pets: ["owl"],
};

test("connecting mail asks for the address, the incoming server and its sign-in, with no provider presets", () => {
  expect(CONNECTOR_TYPES.find((t) => t.id === "mail")?.label).toBe("Email");
  const html = renderToStaticMarkup(<MailSetup house="home" options={[]} onClose={() => {}} saved={async () => {}} />);
  expect(html).toContain("Connect mail");
  expect(html).toContain("Incoming mail (IMAP)");
  expect(html).toContain('placeholder="imap.example.com"');
  expect(html).toContain('value="993"'); // SSL/TLS's usual port
  expect(html).toContain('type="password"');
  expect(html).not.toContain("Gmail");
  expect(html).not.toContain("Outgoing mail"); // sending comes on its own step
  expect(html).not.toMatch(/<details[^>]*open/); // the certificate is folded
});

test("editing keeps the stored passwords out of the form and shows its servers and certificate", () => {
  const html = renderToStaticMarkup(<MailSetup house="home" existing={view} options={[]} waiting={1} onClose={() => {}} saved={async () => {}} />);
  expect(html).toContain("Mail settings: me@proton.me");
  expect(html).toContain("Leave empty to keep the saved one");
  expect(html).toContain('value="127.0.0.1"');
  expect(html).toContain('value="1143"');
  expect(html).toContain("BEGIN CERTIFICATE");
  expect(html).toContain("Saving cancels the email waiting for your approval");
  expect(html).not.toContain("Next");
});

test("a saved connection saves again without its passwords", () => {
  const input = mailInput(view, ["owl", "cat"]);
  expect(input.imap.password).toBe("");
  expect(input.smtp?.password).toBe("");
  expect(input.pets).toEqual(["owl", "cat"]);
  expect(input.imap.tlsCertificate).toContain("BEGIN CERTIFICATE");
});

test("what bots may do, in words", () => {
  expect(mailAccessWords({ sendPolicy: "disabled", allowManage: false })).toBe("reads only");
  expect(mailAccessWords({ sendPolicy: "approval", allowManage: false })).toBe("reads and sends with your OK");
  expect(mailAccessWords({ sendPolicy: "auto", allowManage: true })).toBe("reads, sends and organizes");
});

test("a connection's notices: emails waiting in a chat, and recent ones that may not have gone out", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const send = (id: string, state: MailSendView["state"], subject: string, hoursAgo = 0, connection = "c1"): MailSendView => ({
    id, connection, pet: "owl", from: "me@proton.me", to: ["a@b.c"], cc: [], bcc: [], subject, text: "", attachments: [], state, messageId: "", createdAt: new Date(now - hoursAgo * 3600e3).toISOString(), expiresAt: "",
  });
  const title = (name: string) => (name === "owl" ? "Owl" : name);
  expect(mailNotices([send("1", "pending", "Dinner")], "c1", title, now)).toEqual([{ key: "waiting-owl", tone: "busy", text: "«Dinner» is waiting for your OK in Owl's chat" }]);
  expect(mailNotices([send("1", "pending", "A"), send("2", "pending", "B")], "c1", title, now)[0]!.text).toBe("2 emails are waiting for your OK in Owl's chat");
  const problems = mailNotices([send("3", "unknown", "Invoice", 2), send("4", "failed", "", 3), send("5", "sent", "Fine"), send("6", "unknown", "Old", 24 * 8), send("7", "pending", "Other", 0, "c2")], "c1", title, now);
  expect(problems.map((n) => n.tone)).toEqual(["danger", "danger"]);
  expect(problems[0]!.text).toContain("«Invoice» may not have gone out: check Sent");
  expect(problems[1]!.text).toBe("«No subject» wasn't sent");
  // An approval no chat could show ended at once: the row says why, since the bot had no chat to say it in.
  const noChat = mailNotices([{ ...send("8", "cancelled", "Hello"), detail: MAIL_NO_CHAT }, send("9", "cancelled", "Withdrawn")], "c1", title, now);
  expect(noChat.map((n) => n.text)).toEqual(["«Hello» wasn't sent: Owl is in no chat where you could approve it. Add it to a channel."]);
});
