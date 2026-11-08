import { expect, test } from "bun:test";
import { createServer } from "node:tls";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../../src/infra/process";
import helper from "../../src/infra/inbox-mail.py" with { type: "text" };
import { tempDir } from "../helpers";

test("real TLS POP3 and IMAP polling: baseline, new mail, MIME, dedup, and read-only commands", async () => {
  const dir = tempDir(), key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  const generated = await runCommand(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
  expect(generated.ok).toBe(true);
  const old = "Subject: Old mail\r\nFrom: before@example.com\r\n\r\nold";
  const fresh = "Subject: =?UTF-8?B?TmV3IG1haWw=?=\r\nFrom: sender@example.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello inbox</p><script>do bad things</script>";
  for (const kind of ["pop3", "imap"] as const) {
    const messages = [old], commands: string[] = [];
    let validity = 99;
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, socket => {
      socket.write(kind === "pop3" ? "+OK inbox test\r\n" : "* OK IMAP4rev1 ready\r\n");
      let buffered = "";
      socket.on("data", data => {
        buffered += data.toString();
        for (;;) {
          const end = buffered.indexOf("\r\n"); if (end < 0) break;
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          commands.push(line);
          if (kind === "pop3") {
            const [command, num] = line.split(" ");
            if (command === "UIDL") socket.write("+OK\r\n" + messages.map((_, i) => `${i + 1} stable-${i + 1}\r\n`).join("") + ".\r\n");
            else if (command === "LIST") socket.write(`+OK ${num} ${Buffer.byteLength(messages[Number(num) - 1]!)}\r\n`);
            else if (command === "RETR" || command === "TOP") socket.write("+OK\r\n" + messages[Number(num) - 1] + "\r\n.\r\n");
            else if (command === "QUIT") socket.end("+OK bye\r\n");
            else socket.write("+OK\r\n");
          } else {
            const [tag, command, ...args] = line.split(" ");
            const ok = () => socket.write(`${tag} OK completed\r\n`);
            if (command === "CAPABILITY") { socket.write("* CAPABILITY IMAP4rev1\r\n"); ok(); }
            else if (command === "LOGIN") ok();
            else if (command === "EXAMINE") { socket.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${validity}] stable\r\n* OK [UIDNEXT ${messages.length + 1}] next\r\n`); ok(); }
            else if (command === "UID" && args[0] === "SEARCH") { socket.write("* SEARCH " + messages.map((_, i) => i + 1).join(" ") + "\r\n"); ok(); }
            else if (command === "UID" && args[0] === "FETCH") {
              const n = Number(args[1]), raw = messages[n - 1]!;
              socket.write(`* ${n} FETCH (UID ${n} BODY[]<0> {${Buffer.byteLength(raw)}}\r\n${raw})\r\n`); ok();
            } else if (command === "LOGOUT") { socket.end(`* BYE\r\n${tag} OK logout\r\n`); }
            else socket.write(`${tag} BAD unsupported\r\n`);
          }
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const source = { kind, host: "127.0.0.1", port, username: "test", password: "test-only-password", mailbox: "INBOX" };
    const poll = async (cursor?: string) => {
      const result = await runCommand(["python3", "-c", helper], { stdin: JSON.stringify({ source, cursor, initial: "new" }), env: { SSL_CERT_FILE: cert }, timeoutMs: 10000 });
      expect(result.ok).toBe(true);
      return JSON.parse(result.stdout) as { items: { title: string; text: string; id: string }[]; cursor: string };
    };
    try {
      const baseline = await poll();
      expect(baseline.items).toHaveLength(0);
      messages.push(fresh);
      const next = await poll(baseline.cursor);
      expect(next.items).toHaveLength(1);
      expect(next.items[0]!.title).toBe("New mail");
      expect(next.items[0]!.text).toContain("Hello inbox");
      expect(next.items[0]!.text).not.toContain("do bad things");
      expect((await poll(next.cursor)).items).toHaveLength(0);
      if (kind === "imap") {
        validity += 1;
        expect((await poll(next.cursor)).items).toHaveLength(0);
        expect(commands.some(c => c.includes("EXAMINE"))).toBe(true);
        expect(commands.some(c => c.includes("BODY.PEEK[]"))).toBe(true);
      }
      expect(commands.some(c => /\b(DELE|STORE|EXPUNGE)\b/.test(c))).toBe(false);
      // The same certificate is rejected without its explicit test-only CA.
      const untrusted = await runCommand(["python3", "-c", helper], { stdin: JSON.stringify({ source, initial: "new" }), timeoutMs: 10000 });
      expect(untrusted.ok).toBe(false);
      expect(untrusted.stdout + untrusted.stderr).not.toContain("test-only-password");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}, 30000);
