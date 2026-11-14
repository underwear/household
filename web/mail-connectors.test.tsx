import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailEndpointFields, MailSetup, mailAccessWords } from "./components/mail-connectors";
import { CONNECTOR_TYPES } from "./components/workspace-connectors";

test("mail setup offers verified TLS/STARTTLS with masked password and explicit Bridge guidance", () => {
  expect(CONNECTOR_TYPES.some(t => t.id === "mail")).toBe(true);
  const html = renderToStaticMarkup(<MailSetup house="home" options={[]} onClose={() => {}} saved={async () => {}} />);
  expect(html).toContain("Connect mail");
  expect(html).toContain("Credentials stay on this host");
  expect(html).toContain("STARTTLS");
  expect(html).toContain('type="password"');
  expect(html).toContain("never a private key");
  expect(html).toContain("generated password");
});

test("connection edit does not echo stored passwords and labels send/manage permission separately", () => {
  const html = renderToStaticMarkup(<MailEndpointFields title="SMTP" endpoint={{ host: "127.0.0.1", port: 1025, username: "fixture", password: "", security: "starttls" }} onChange={() => {}} existing />);
  expect(html).toContain("Leave blank to retain");
  expect(html).toContain('value="1025"');
  expect(html).toMatch(/value="starttls" selected=""/);
  expect(mailAccessWords({ sendPolicy: "approval", allowManage: false })).toBe("approve each outgoing email, mailbox read only");
  expect(mailAccessWords({ sendPolicy: "auto", allowManage: true })).toBe("send automatically, mailbox changes allowed");
});
