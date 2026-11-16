import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatsAppSettings, WhatsAppSetup, whatsappLinkWords } from "./components/whatsapp-connectors";
import { CONNECTOR_TYPES } from "./components/workspace-connectors";
import type { WhatsAppConnectionView } from "./api";

const options = [{ value: "alice", label: "Alice" }];
const connection: WhatsAppConnectionView = { id: "w1", name: "Personal", phone: "+34600111222", account: "Igor", writePolicy: "approval", pets: ["alice"], connectedAt: "", needsReconnect: false, link: "online", chats: 12, messages: 340 };

test("WhatsApp is in Add connector and starts private, read only, with a QR code", () => {
  expect(CONNECTOR_TYPES.find(t => t.id === "whatsapp")?.label).toBe("WhatsApp");
  const html = renderToStaticMarkup(<WhatsAppSetup house="home" options={options} onClose={() => {}} saved={async () => {}} />);
  expect(html).toContain("Connect WhatsApp");
  expect(html).toContain("Show QR code");
  expect(html).toContain("Phone number");
  expect(html).toMatch(/checked=""[^>]*value="disabled"|value="disabled"[^>]*checked=""/);
  expect(html).not.toMatch(/role="switch"[^>]*checked=""/);
  expect(html).toContain("not an official WhatsApp app");
});

test("pairing again and settings keep the account's name, access and bots", () => {
  const again = renderToStaticMarkup(<WhatsAppSetup house="home" existing={connection} options={options} onClose={() => {}} saved={async () => {}} />);
  expect(again).toContain("Pair Personal again");
  expect(again).toContain("keeps its history");
  expect(again).toMatch(/checked=""[^>]*value="approval"|value="approval"[^>]*checked=""/);
  expect(again).toMatch(/role="switch"[^>]*checked=""/);
  const settings = renderToStaticMarkup(<WhatsAppSettings house="home" connection={connection} options={options} onClose={() => {}} saved={async () => {}} />);
  expect(settings).toContain("Settings: Personal");
  expect(settings).toContain("12 chats and 340 messages kept");
  expect(settings).toContain('value="Personal"');
  expect(whatsappLinkWords(connection)).toBe("Connected");
  expect(whatsappLinkWords({ ...connection, needsReconnect: true })).toBe("Pair again");
  expect(whatsappLinkWords({ ...connection, link: "offline" })).toBe("Offline, retrying");
});
