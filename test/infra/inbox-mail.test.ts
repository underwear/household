import { beforeAll, expect, test } from "bun:test";
import { createServer as createTLSServer, createSecureContext, TLSSocket } from "node:tls";
import { createServer, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../../src/infra/process";
import { pollInbox } from "../../src/infra/inbox-pollers";
import { pollSourceSchema, type PollSource } from "../../src/core/house-inboxes";
import helper from "../../src/infra/inbox-mail.py" with { type: "text" };
import { tempDir } from "../helpers";

let certificate: string, privateKey: string, wrongCertificate: string, wrongKey: string;
beforeAll(async () => {
  const dir = tempDir();
  for (const name of ["localhost", "wrong.example"]) {
    const key = join(dir, name + ".key"), cert = join(dir, name + ".pem");
    const generated = await runCommand(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}${name === "localhost" ? ",IP:127.0.0.1" : ""}`]);
    expect(generated.ok).toBe(true);
    if (name === "localhost") { certificate = readFileSync(cert, "utf8"); privateKey = readFileSync(key, "utf8"); }
    else { wrongCertificate = readFileSync(cert, "utf8"); wrongKey = readFileSync(key, "utf8"); }
  }
});

const old = "Subject: Old mail\r\nFrom: before@example.com\r\n\r\nold";
const fresh = "Subject: =?UTF-8?B?TmV3IG1haWw=?=\r\nFrom: sender@example.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello inbox</p><script>do bad things</script>";
async function mailbox(kind: "imap" | "pop3", security: "tls" | "starttls", options: { unsupported?: boolean; rejectUpgrade?: boolean; rejectLogin?: boolean; wrongHost?: boolean; oversized?: boolean } = {}) {
  const messages = [old], commands: { line: string; encrypted: boolean }[] = [], sockets = new Set<Socket>();
  let validity = 99;
  const tlsOptions = { key: options.wrongHost ? wrongKey : privateKey, cert: options.wrongHost ? wrongCertificate : certificate };
  const connect = (socket: Socket) => {
    const track = (socket: Socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); };
    track(socket);
    socket.write(kind === "pop3" ? "+OK inbox test\r\n" : "* OK IMAP4rev1 ready\r\n");
    let buffered = "", encrypted = security === "tls";
    const read = (data: Buffer) => {
      buffered += data.toString();
      for (;;) {
        const end = buffered.indexOf("\r\n"); if (end < 0) break;
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        commands.push({ line, encrypted });
        const [tag, command, ...args] = line.split(" ");
        const upgrade = () => {
          if (options.rejectUpgrade) { socket.write(kind === "imap" ? `${tag} NO upgrade refused\r\n` : "-ERR upgrade refused\r\n"); return; }
          socket.write(kind === "imap" ? `${tag} OK begin TLS\r\n` : "+OK begin TLS\r\n");
          socket.removeListener("data", read);
          socket = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(tlsOptions) });
          encrypted = true; track(socket); socket.on("data", read);
        };
        if (kind === "pop3") {
          if (tag === "CAPA") socket.write("+OK\r\nUIDL\r\n" + (!encrypted && !options.unsupported ? "STLS\r\n" : "") + ".\r\n");
          else if (tag === "STLS") upgrade();
          else if (tag === "UIDL") socket.write("+OK\r\n" + messages.map((_, i) => `${i + 1} stable-${i + 1}\r\n`).join("") + ".\r\n");
          else if (tag === "LIST") socket.write(`+OK ${command} ${Buffer.byteLength(messages[Number(command) - 1]!)}\r\n`);
          else if (tag === "RETR" || tag === "TOP") socket.write("+OK\r\n" + messages[Number(command) - 1] + "\r\n.\r\n");
          else if (tag === "QUIT") socket.end("+OK bye\r\n");
          else if (options.rejectLogin && tag === "PASS") socket.write("-ERR test-only-password rejected\r\n");
          else socket.write("+OK\r\n");
        } else {
          const ok = () => socket.write(`${tag} OK completed\r\n`);
          if (command === "CAPABILITY") { socket.write("* CAPABILITY IMAP4rev1" + (!encrypted && !options.unsupported ? " STARTTLS" : "") + "\r\n"); ok(); }
          else if (command === "STARTTLS") upgrade();
          else if (command === "LOGIN") { if (options.rejectLogin) socket.write(`${tag} NO test-only-password rejected\r\n`); else ok(); }
          else if (command === "EXAMINE") { socket.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${validity}] stable\r\n* OK [UIDNEXT ${messages.length + 1}] next\r\n`); ok(); }
          else if (command === "UID" && args[0] === "SEARCH") { socket.write("* SEARCH " + messages.map((_, i) => i + 1).join(" ") + "\r\n"); ok(); }
          else if (command === "UID" && args[0] === "FETCH") {
            const n = Number(args[1]), raw = messages[n - 1]!;
            socket.write(`* ${n} FETCH (UID ${n} BODY[]<0> {${options.oversized ? 65537 : Buffer.byteLength(raw)}}\r\n${raw})\r\n`); ok();
          } else if (command === "LOGOUT") socket.end(`* BYE\r\n${tag} OK logout\r\n`);
          else socket.write(`${tag} BAD unsupported\r\n`);
        }
      }
    };
    socket.on("data", read);
  };
  const server = security === "tls" ? createTLSServer(tlsOptions, connect) : createServer(connect);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const source = pollSourceSchema.parse({ kind, host: "127.0.0.1", port, username: "test", password: "test-only-password", security, tlsCertificate: tlsOptions.cert, ...(kind === "imap" ? { mailbox: "INBOX" } : {}) });
  return { source, commands, messages, resetValidity: () => { validity++; }, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const rawPoll = (source: PollSource, initial = "new") => runCommand(["python3", "-c", helper], { stdin: JSON.stringify({ source, initial }), timeoutMs: 5000 });
const poll = (source: PollSource, cursor?: string) => pollInbox(source, cursor, "new", new AbortController().signal);

for (const kind of ["pop3", "imap"] as const) for (const security of ["tls", "starttls"] as const) {
  test(`${kind} ${security}: verified TLS, baseline, new mail, MIME, dedup and read-only commands`, async () => {
    const m = await mailbox(kind, security);
    try {
      // Missing security preserves the pre-existing implicit TLS behavior.
      const source = { ...m.source, ...(security === "tls" ? { security: undefined } : {}) };
      const baseline = await poll(source);
      expect(baseline.items).toHaveLength(0);
      m.messages.push(fresh);
      const next = await poll(source, baseline.cursor);
      expect(next.items).toHaveLength(1);
      expect(next.items[0]!.title).toBe("New mail");
      expect(next.items[0]!.text).toContain("Hello inbox");
      expect(next.items[0]!.text).not.toContain("do bad things");
      expect((await poll(source, next.cursor)).items).toHaveLength(0);
      if (kind === "imap") {
        m.resetValidity();
        expect((await poll(source, next.cursor)).items).toHaveLength(0);
        expect(m.commands.some(c => c.line.includes("EXAMINE"))).toBe(true);
        expect(m.commands.some(c => c.line.includes("BODY.PEEK[]"))).toBe(true);
      }
      const auth = m.commands.filter(c => /\b(LOGIN|USER|PASS)\b/.test(c.line));
      expect(auth.length).toBeGreaterThan(0);
      expect(auth.every(c => c.encrypted)).toBe(true);
      expect(m.commands.some(c => /\b(DELE|STORE|EXPUNGE)\b/.test(c.line))).toBe(false);
      if (security === "starttls") expect(m.commands.some(c => /\b(STARTTLS|STLS)\b/.test(c.line))).toBe(true);
      const start = m.commands.length;
      const untrusted = { ...source, tlsCertificate: undefined };
      const rejected = await rawPoll(untrusted);
      expect(rejected.ok).toBe(false);
      expect(JSON.parse(rejected.stdout).error).toBe("certificate");
      await expect(poll(untrusted)).rejects.toThrow("certificate could not be verified");
      expect(m.commands.slice(start).some(c => /\b(LOGIN|USER|PASS)\b/.test(c.line))).toBe(false);
      expect(rejected.stdout + rejected.stderr).not.toContain("test-only-password");
    } finally { await m.close(); }
  }, 15000);

  test(`${kind} ${security}: rejects a trusted certificate for another hostname`, async () => {
    const m = await mailbox(kind, security, { wrongHost: true });
    try {
      await expect(poll(m.source)).rejects.toThrow("certificate could not be verified");
      expect(m.commands.some(c => /\b(LOGIN|USER|PASS)\b/.test(c.line))).toBe(false);
    } finally { await m.close(); }
  });

  test(`${kind} ${security}: safe authentication error without server text or password`, async () => {
    const m = await mailbox(kind, security, { rejectLogin: true });
    try {
      const result = await rawPoll(m.source);
      expect(JSON.parse(result.stdout)).toEqual({ error: "authentication" });
      expect(result.stdout + result.stderr).not.toContain("test-only-password");
      await expect(poll(m.source)).rejects.toThrow("Mail login was rejected");
    } finally { await m.close(); }
  });
}

for (const kind of ["imap", "pop3"] as const) for (const failure of ["unsupported", "rejectUpgrade"] as const) {
  test(`${kind} STARTTLS ${failure}: never falls back or sends credentials`, async () => {
    const m = await mailbox(kind, "starttls", { [failure]: true });
    try {
      await expect(poll(m.source)).rejects.toThrow("did not accept STARTTLS");
      expect(m.commands.some(c => /\b(LOGIN|USER|PASS)\b/.test(c.line))).toBe(false);
    } finally { await m.close(); }
  });
}

for (const security of ["tls", "starttls"] as const) test(`IMAP ${security}: oversized literals remain bounded`, async () => {
  const m = await mailbox("imap", security, { oversized: true });
  try {
    const result = await rawPoll(m.source, "latest");
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.stdout).error).toBe("mail");
  } finally { await m.close(); }
});

test("mail config accepts old TLS and STARTTLS with public certificates, refuses plaintext and private keys", () => {
  for (const kind of ["imap", "pop3"] as const) {
    const source = { kind, host: "127.0.0.1", port: 1143, username: "test", password: "test-only" };
    expect(pollSourceSchema.safeParse(source).success).toBe(true);
    expect(pollSourceSchema.safeParse({ ...source, security: "starttls", tlsCertificate: certificate }).success).toBe(true);
    for (const fields of [{ security: "none" }, { tlsCertificate: privateKey }, { tlsCertificate: certificate + privateKey }, { tlsCertificate: "/path/to/cert" }]) {
      expect(pollSourceSchema.safeParse({ ...source, ...fields }).success).toBe(false);
    }
  }
});

test("invalid PEM data reports a safe actionable error", async () => {
  const source = pollSourceSchema.parse({ kind: "imap", host: "127.0.0.1", port: 1143, username: "test", password: "test-only", tlsCertificate: "-----BEGIN CERTIFICATE-----\nYmFk\n-----END CERTIFICATE-----" });
  await expect(poll(source)).rejects.toThrow("certificate could not be loaded");
});
