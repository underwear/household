import { beforeAll, expect, test } from "bun:test";
import { createServer as tlsServer, TLSSocket, createSecureContext } from "node:tls";
import { createServer as netServer, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { runCommand } from "../../src/infra/process";
import { mailDriver } from "../../src/infra/mail/client";
import { mailConnectionSchema, type MailConnectionInput } from "../../src/core/mail-connectors";

let cert: string, key: string, wrongCert: string, wrongKey: string;
beforeAll(async () => {
  const root = tempDir();
  for (const host of ["localhost", "wrong.test"]) {
    const path = join(root, host);
    const result = await runCommand(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path + ".key", "-out", path + ".pem", "-days", "1", "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}${host === "localhost" ? ",IP:127.0.0.1" : ""}`]);
    expect(result.ok).toBe(true);
    if (host === "localhost") { cert = readFileSync(path + ".pem", "utf8"); key = readFileSync(path + ".key", "utf8"); }
    else { wrongCert = readFileSync(path + ".pem", "utf8"); wrongKey = readFileSync(path + ".key", "utf8"); }
  }
});

type Options = { noStarttls?: boolean; rejectStarttls?: boolean; wrongHost?: boolean; rejectRecipient?: boolean; rejectData?: boolean; dropDataAck?: boolean; rejectAppend?: boolean; oversized?: boolean; noMove?: boolean; noUidNext?: boolean; asciiOnly?: boolean; largeReply?: boolean };
async function fixture(protocol: "imap" | "smtp", security: "tls" | "starttls", options: Options = {}) {
  const tls = { cert: options.wrongHost ? wrongCert : cert, key: options.wrongHost ? wrongKey : key };
  const commands: { line: string; encrypted: boolean }[] = [], delivered: string[] = [], appended: string[] = [];
  const messages = ["Subject: First\r\nFrom: old@example.test\r\nTo: owner@example.test\r\nMessage-ID: <first@example.test>\r\n\r\nfirst", "Subject: Second\r\nFrom: new@example.test\r\nTo: owner@example.test\r\nMessage-ID: <second@example.test>\r\n\r\nsecond"];
  let validity = "42";
  const sockets = new Set<Socket>();
  const connect = (initial: Socket) => {
    let socket = initial, encrypted = security === "tls", buffer = Buffer.alloc(0), inData = false, appendBytes = 0, appendTag = "";
    const track = (s: Socket) => { sockets.add(s); s.on("error", () => {}); s.on("close", () => sockets.delete(s)); };
    track(socket);
    socket.write(protocol === "imap" ? "* OK IMAP4rev1 fixture\r\n" : "220 fixture ESMTP\r\n");
    const read = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n"); if (end < 0) return;
          delivered.push(buffer.subarray(0, end).toString()); buffer = buffer.subarray(end + 5); inData = false;
          if (options.dropDataAck) { socket.destroy(); return; }
          socket.write(options.rejectData ? "550 no delivery\r\n" : "250 accepted\r\n"); continue;
        }
        if (appendBytes) {
          if (buffer.length < appendBytes + 2) return;
          appended.push(buffer.subarray(0, appendBytes).toString()); buffer = buffer.subarray(appendBytes + 2); appendBytes = 0;
          socket.write(`${appendTag} ${options.rejectAppend ? "NO" : "OK"} append completed\r\n`); continue;
        }
        const end = buffer.indexOf("\r\n"); if (end < 0) return;
        const line = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 2);
        commands.push({ line, encrypted });
        const [tag, command, ...args] = line.split(" ");
        const upgrade = () => {
          if (options.rejectStarttls) { socket.write(protocol === "imap" ? `${tag} NO TLS unavailable\r\n` : "454 TLS unavailable\r\n"); return; }
          socket.write(protocol === "imap" ? `${tag} OK begin TLS\r\n` : "220 begin TLS\r\n");
          socket.removeListener("data", read);
          socket = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(tls) });
          encrypted = true; track(socket); socket.on("data", read);
        };
        if (protocol === "smtp") {
          if (tag?.toUpperCase() === "EHLO" && options.largeReply) socket.write(("250-" + "a".repeat(8000) + "\r\n").repeat(140) + "250 AUTH PLAIN\r\n");
          else if (tag?.toUpperCase() === "EHLO") socket.write("250-fixture\r\n" + (!encrypted && !options.noStarttls ? "250-STARTTLS\r\n" : "") + "250 AUTH PLAIN\r\n");
          else if (tag?.toUpperCase() === "STARTTLS") upgrade();
          else if (tag?.toUpperCase() === "AUTH") socket.write("235 authenticated\r\n");
          else if (tag?.toUpperCase() === "RCPT" && options.rejectRecipient && line.includes("refused@")) socket.write("550 rejected\r\n");
          else if (tag?.toUpperCase() === "DATA") { socket.write("354 send message\r\n"); inData = true; }
          else if (tag?.toUpperCase() === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 OK\r\n");
          continue;
        }
        const ok = () => socket.write(`${tag} OK completed\r\n`);
        if (command === "CAPABILITY") { socket.write(`* CAPABILITY IMAP4rev1${!options.noMove ? " MOVE" : ""}${!encrypted && !options.noStarttls ? " STARTTLS" : ""}\r\n`); ok(); }
        else if (command === "STARTTLS") upgrade();
        else if (command === "LOGIN") ok();
        else if (command === "LIST") { socket.write('* LIST () "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent"\r\n* LIST () "/" "&BB8EQAQ4BDIENQRC-"\r\n'); ok(); }
        else if (command === "EXAMINE" || command === "SELECT") { socket.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${validity}] stable\r\n${options.noUidNext ? "" : `* OK [UIDNEXT ${messages.length + 1}] next\r\n`}`); ok(); }
        else if (command === "UID" && args[0] === "SEARCH" && options.asciiOnly && line.includes("CHARSET")) { socket.write(`${tag} NO [BADCHARSET (US-ASCII)] unsupported charset\r\n`); }
        else if (command === "UID" && args[0] === "SEARCH") { socket.write("* SEARCH " + messages.map((_, i) => i + 1).join(" ") + "\r\n"); ok(); }
        else if (command === "UID" && args[0] === "FETCH") {
          const uid = Number(args[1]), message = messages[uid - 1];
          if (message === undefined) { ok(); continue; }
          if (line.includes("RFC822.SIZE")) { socket.write(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${options.oversized ? 20_000_000 : Buffer.byteLength(message)})\r\n`); ok(); }
          else {
            const raw = line.includes("[HEADER]") ? message.split("\r\n\r\n")[0]! + "\r\n\r\n" : message;
            socket.write(`* ${uid} FETCH (UID ${uid} BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n`); ok();
          }
        } else if (command === "UID" && ["STORE", "MOVE"].includes(args[0]!)) ok();
        else if (command === "APPEND") { appendBytes = Number(/\{(\d+)\}$/.exec(line)?.[1]); appendTag = tag!; socket.write("+ send literal\r\n"); }
        else if (command === "CREATE" || command === "RENAME") ok();
        else if (command === "LOGOUT") socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        else socket.write(`${tag} BAD unsupported\r\n`);
      }
    };
    socket.on("data", read);
  };
  const server = security === "tls" ? tlsServer(tls, connect) : netServer(connect);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = { host: "127.0.0.1", port: (server.address() as { port: number }).port, security, username: "fixture", password: "fixture-private-password", tlsCertificate: tls.cert };
  return { endpoint, messages, commands, delivered, appended, reset: () => { validity = "43"; }, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const config = (imap: object, smtp?: object) => mailConnectionSchema.parse({ title: "Test", email: "sender@example.test", displayName: "Sender", imap, ...(smtp ? { smtp } : {}), pets: [] });
const ref = (uid = 1) => ({ account: "a".repeat(64), mailbox: "INBOX", uidValidity: "42", uid });
const message = { to: ["to@example.test"], cc: ["cc@example.test"], bcc: ["hidden@example.test"], subject: "Тест ✓", text: "Hello\n.leading dot\nBye", messageId: "<stable@example.test>", date: "Sat, 14 Nov 2026 10:00:00 GMT" };

for (const security of ["tls", "starttls"] as const) {
  test(`IMAP ${security}: list, Unicode folders, stable search pagination, readonly MIME and attachment reads`, async () => {
    const server = await fixture("imap", security);
    const c = config(server.endpoint);
    try {
      const folders = await mailDriver(c, "mailboxes.list", {});
      expect(folders.mailboxes.map((f: any) => f.name)).toContain("Привет");
      const one = await mailDriver(c, "messages.search", { mailbox: "INBOX", limit: 1 });
      expect(one.items[0].ref.uid).toBe(2); expect(one.complete).toBe(false);
      server.messages.push("Subject: Arrived later\r\n\r\nnew");
      const two = await mailDriver(c, "messages.search", { mailbox: "INBOX", limit: 1, cursor: one.next });
      expect(two.items[0].ref.uid).toBe(1); expect(two.complete).toBe(true);
      const wire = await mailDriver(c, "compose", { ...message, replyHeaders: { messageId: "<parent@example.test>", references: "<ancestor@example.test>" }, attachments: [{ filename: "report.txt", contentType: "text/plain", data: Buffer.from("attachment bytes").toString("base64") }] });
      server.messages[0] = Buffer.from(wire.raw, "base64").toString();
      const read = await mailDriver(c, "messages.read", { ref: ref() });
      expect(read.subject).toBe("Тест ✓"); expect(read.inReplyTo).toBe("<parent@example.test>");
      expect(read.references).toBe("<ancestor@example.test> <parent@example.test>");
      expect(read.text).toContain("Hello"); expect(read.attachments).toHaveLength(1);
      const file = await mailDriver(c, "attachments.download", { ref: ref(), attachment: read.attachments[0].id });
      expect(Buffer.from(file.data, "base64").toString()).toBe("attachment bytes");
      expect(server.commands.some(c => c.line.includes("EXAMINE"))).toBe(true);
      expect(server.commands.some(c => /\b(STORE|SELECT|EXPUNGE)\b/.test(c.line))).toBe(false);
      expect(server.commands.filter(c => c.line.includes("LOGIN")).every(c => c.encrypted)).toBe(true);
      server.reset();
      await expect(mailDriver(c, "messages.read", { ref: ref() })).rejects.toThrow("UIDVALIDITY changed");
      await expect(mailDriver(c, "messages.move", { ref: ref(), destination: "Archive" })).rejects.toThrow("UIDVALIDITY changed");
      expect(server.commands.some(c => /\bMOVE\b/.test(c.line))).toBe(false);
    } finally { await server.close(); }
  }, 15000);

  test(`SMTP ${security}: fixed MIME with Date/Message-ID, threaded reply, Bcc-free wire and explicit hidden recipient`, async () => {
    const server = await fixture("smtp", security);
    const c = config(server.endpoint, server.endpoint);
    try {
      const wire = await mailDriver(c, "compose", message);
      const result = await mailDriver(c, "send", { raw: wire.raw, recipients: [...message.to, ...message.cc, ...message.bcc] });
      expect(result.delivery).toBe("sent"); expect(server.delivered).toHaveLength(1);
      expect(server.delivered[0]).toContain("Date:"); expect(server.delivered[0]).toContain("Message-ID: <stable@example.test>");
      expect(server.delivered[0]).not.toMatch(/^Bcc:/im); expect(server.delivered[0]).not.toContain("hidden@example.test");
      expect(server.commands.some(c => /^rcpt to:<hidden@example\.test>$/i.test(c.line))).toBe(true);
      expect(server.commands.filter(c => c.line.toUpperCase().startsWith("AUTH ")).every(c => c.encrypted)).toBe(true);
      expect(server.delivered[0]).toContain("..leading dot");
    } finally { await server.close(); }
  });

  for (const protocol of ["imap", "smtp"] as const) for (const trust of ["untrusted", "wrongHost"] as const) test(`${protocol} ${security}: ${trust} fails before credentials`, async () => {
    const server = await fixture(protocol, security, { wrongHost: trust === "wrongHost" });
    const endpoint = { ...server.endpoint, ...(trust === "untrusted" ? { tlsCertificate: undefined } : {}) };
    const c = config(endpoint, endpoint);
    try {
      if (protocol === "imap") await expect(mailDriver(c, "mailboxes.list", {})).rejects.toThrow("certificate");
      else {
        const wire = await mailDriver(c, "compose", message);
        expect(await mailDriver(c, "send", { raw: wire.raw, recipients: message.to })).toEqual({ delivery: "not-sent", error: "certificate" });
      }
      expect(server.commands.some(c => /\b(LOGIN|AUTH)\b/i.test(c.line))).toBe(false);
    } finally { await server.close(); }
  });
}

for (const protocol of ["imap", "smtp"] as const) for (const failure of ["noStarttls", "rejectStarttls"] as const) test(`${protocol}: ${failure} never downgrades`, async () => {
  const server = await fixture(protocol, "starttls", { [failure]: true }), c = config(server.endpoint, server.endpoint);
  try {
    if (protocol === "imap") await expect(mailDriver(c, "mailboxes.list", {})).rejects.toThrow("STARTTLS");
    else { const wire = await mailDriver(c, "compose", message); expect((await mailDriver(c, "send", { raw: wire.raw, recipients: message.to })).error).toBe("starttls"); }
    expect(server.commands.some(c => /\b(LOGIN|AUTH)\b/i.test(c.line))).toBe(false);
  } finally { await server.close(); }
});

for (const failure of ["rejectRecipient", "rejectData", "dropDataAck"] as const) test(`SMTP ${failure}: rejected recipients send no DATA; uncertain acceptance never means safe retry`, async () => {
  const server = await fixture("smtp", "starttls", { [failure]: true }), c = config(server.endpoint, server.endpoint);
  try {
    const wire = await mailDriver(c, "compose", message);
    const result = await mailDriver(c, "send", { raw: wire.raw, recipients: ["accepted@example.test", "refused@example.test"] });
    expect(result.delivery).toBe(failure === "dropDataAck" ? "unknown" : "not-sent");
    if (failure === "rejectRecipient") { expect(server.delivered).toHaveLength(0); expect(server.commands.some(c => c.line.toUpperCase() === "DATA")).toBe(false); expect(server.commands.some(c => c.line.toUpperCase() === "RSET")).toBe(true); }
    else expect(server.delivered).toHaveLength(1);
  } finally { await server.close(); }
});

test("header fallback paginates all older candidates, reports empty intermediate pages, and UIDNEXT is optional", async () => {
  const server = await fixture("imap", "tls", { noUidNext: true }), c = config(server.endpoint);
  try {
    server.messages.length = 0;
    for (let i = 1; i <= 205; i++) server.messages.push(`Subject: ${i === 1 ? "Find me" : "noise"}\r\n\r\nbody`);
    const one = await mailDriver(c, "messages.search", { mailbox: "INBOX", limit: 20, searchMode: "headers", query: { subject: "find me" } });
    expect(one.items).toHaveLength(0); expect(one.scanned).toBe(200); expect(one.complete).toBe(false);
    const two = await mailDriver(c, "messages.search", { mailbox: "INBOX", limit: 20, searchMode: "headers", query: { subject: "find me" }, cursor: one.next });
    expect(two.items[0].ref.uid).toBe(1); expect(two.complete).toBe(true);
  } finally { await server.close(); }
}, 15000);

test("IMAP message size bound, explicit flags/MOVE, and independent Sent APPEND", async () => {
  const large = await fixture("imap", "tls", { oversized: true });
  try { await expect(mailDriver(config(large.endpoint), "messages.read", { ref: ref() })).rejects.toThrow("size limit"); expect(large.commands.some(c => c.line.includes("BODY.PEEK[]"))).toBe(false); } finally { await large.close(); }
  const server = await fixture("imap", "starttls"), c = config(server.endpoint);
  try {
    await mailDriver(c, "flags.update", { ref: ref(), add: ["Seen"], remove: ["Flagged"] });
    await mailDriver(c, "messages.move", { ref: ref(), destination: "Archive" });
    expect(server.commands.some(c => c.line.includes('+FLAGS.SILENT (\\Seen)'))).toBe(true);
    expect(server.commands.some(c => c.line.includes('UID MOVE 1 "Archive"'))).toBe(true);
    expect(server.commands.some(c => c.line.includes("EXPUNGE"))).toBe(false);
    const wire = await mailDriver(c, "compose", message);
    await mailDriver(c, "append", { mailbox: "Sent", raw: wire.raw });
    expect(server.appended[0]).toBe(Buffer.from(wire.raw, "base64").toString());
  } finally { await server.close(); }
});

test("unsupported MOVE does not copy/delete/expunge as a fallback", async () => {
  const server = await fixture("imap", "tls", { noMove: true });
  try { await expect(mailDriver(config(server.endpoint), "messages.move", { ref: ref(), destination: "Archive" })).rejects.toThrow("UID MOVE"); expect(server.commands.some(c => /\b(STORE|COPY|EXPUNGE|MOVE)\b/.test(c.line))).toBe(false); } finally { await server.close(); }
});

test("ASCII-only servers support default and local Unicode header search", async () => {
  const server = await fixture("imap", "tls", { asciiOnly: true }), c = config(server.endpoint);
  try {
    expect((await mailDriver(c, "messages.search", { mailbox: "INBOX", limit: 10 })).items).toHaveLength(2);
    expect((await mailDriver(c, "messages.search", { mailbox: "INBOX", limit: 10, searchMode: "headers", query: { subject: "Тест" } })).complete).toBe(true);
    expect(server.commands.filter(c => c.line.includes("SEARCH")).every(c => !c.line.includes("CHARSET"))).toBe(true);
    await expect(mailDriver(c, "messages.search", { mailbox: "INBOX", limit: 10, query: { subject: "Тест" } })).rejects.toThrow("rejected Unicode search");
  } finally { await server.close(); }
});

test("oversized headers and excessive MIME parts fail explicitly", async () => {
  const server = await fixture("imap", "tls"), c = config(server.endpoint);
  try {
    server.messages[0] = "X-Large: " + "a".repeat(65536) + "\r\nSubject: hidden match\r\n\r\nbody";
    await expect(mailDriver(c, "reply.headers", { ref: ref() })).rejects.toThrow("size limit");
    expect(server.commands.some(c => c.line.includes("[HEADER]<0.65537>"))).toBe(true);
    server.messages[0] = 'Content-Type: multipart/mixed; boundary="many"\r\n\r\n' + '--many\r\nContent-Type: text/plain\r\n\r\nx\r\n'.repeat(201) + '--many--\r\n';
    await expect(mailDriver(c, "messages.read", { ref: ref() })).rejects.toThrow("size limit");
  } finally { await server.close(); }
});

test("Unicode body uses seven-bit wire and opaque .eml snapshots retain exact bytes", async () => {
  const server = await fixture("smtp", "tls"), inbound = await fixture("imap", "tls"), c = config(inbound.endpoint, server.endpoint);
  const eml = 'From: enclosed@example.test\r\nContent-Type: multipart/mixed; boundary="inner"\r\n\r\n--inner\r\nContent-Type: text/plain\r\n\r\nEnclosed\r\n--inner\r\nContent-Disposition: attachment; filename="nested.txt"\r\n\r\nnested\r\n--inner--\r\n';
  try {
    const wire = await mailDriver(c, "compose", { ...message, text: "Привет, мир! 👋", attachments: [{ filename: "forward.eml", contentType: "message/rfc822", data: Buffer.from(eml).toString("base64") }] });
    const raw = Buffer.from(wire.raw, "base64");
    expect([...raw].every(byte => byte < 128)).toBe(true);
    expect((await mailDriver(c, "send", { raw: wire.raw, recipients: message.to })).delivery).toBe("sent");
    inbound.messages[0] = raw.toString();
    const outgoing = await mailDriver(c, "messages.read", { ref: ref() });
    expect(outgoing.text.trim()).toBe("Привет, мир! 👋");
    const opaque = await mailDriver(c, "attachments.download", { ref: ref(), attachment: outgoing.attachments[0].id });
    expect(Buffer.from(opaque.data, "base64").toString()).toBe(eml);
    inbound.messages[0] = 'Content-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: text/plain\r\n\r\nBody\r\n--outer\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forward.eml"\r\n\r\n' + eml + '\r\n--outer--\r\n';
    const read = await mailDriver(c, "messages.read", { ref: ref() });
    expect(read.attachments).toHaveLength(1);
    expect(read.attachments[0].filename).toBe("forward.eml");
    const downloaded = await mailDriver(c, "attachments.download", { ref: ref(), attachment: read.attachments[0].id });
    expect(Buffer.from(downloaded.data, "base64").toString()).toContain("nested.txt");
  } finally { await server.close(); await inbound.close(); }
});

for (const security of ["tls", "starttls"] as const) test(`SMTP ${security}: bounds multiline responses before credentials`, async () => {
  const server = await fixture("smtp", security, { largeReply: true }), c = config(server.endpoint, server.endpoint);
  try {
    const wire = await mailDriver(c, "compose", message);
    const result = await mailDriver(c, "send", { raw: wire.raw, recipients: message.to });
    expect(result.delivery).toBe("not-sent"); expect(result.error).toBe("reply-too-large");
    expect(server.commands.some(c => c.line.startsWith("AUTH"))).toBe(false);
    expect(server.delivered).toHaveLength(0);
  } finally { await server.close(); }
});
