"""Host-only read-only mail polling. Credentials arrive on stdin, never argv or logs."""
import email
import email.policy
import email.utils
import datetime
import html
import imaplib
import json
import poplib
import re
import socket
import ssl
import sys
from html.parser import HTMLParser

MAX_MESSAGE = 65536
MAX_MAILBOX = 10000

class TextHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0
    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"): self.hidden += 1
        if tag in ("p", "br", "div", "li"): self.parts.append("\n")
    def handle_endtag(self, tag):
        if tag in ("script", "style"): self.hidden = max(0, self.hidden - 1)
    def handle_data(self, text):
        if not self.hidden: self.parts.append(text)

def message(raw, identity, truncated=False):
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    body = msg.get_body(preferencelist=("plain", "html")) if msg.is_multipart() else msg
    text = ""
    if body is not None and body.get_content_maintype() == "text":
        try:
            text = body.get_content()
        except Exception:
            text = (body.get_payload(decode=True) or b"").decode("utf-8", "replace")
        if body.get_content_subtype() == "html":
            parser = TextHTML()
            parser.feed(text)
            text = "".join(parser.parts)
    text = "From: " + str(msg.get("From", ""))[:500] + "\nDate: " + str(msg.get("Date", ""))[:150] + "\n\n" + text
    if truncated or len(text) > 15000: text = text[:15000] + "\n[Message truncated; open your mail client for the full email.]"
    item = {"id": identity, "title": str(msg.get("Subject", "(no subject)"))[:300], "text": text[:16000], "metadata": {
        "from": str(msg.get("From", ""))[:500], "to": str(msg.get("To", ""))[:1000], "cc": str(msg.get("Cc", ""))[:1000],
        "subject": str(msg.get("Subject", ""))[:300], "messageId": str(msg.get("Message-ID", ""))[:500],
        "date": str(msg.get("Date", ""))[:150], "contentType": msg.get_content_type(), "truncated": truncated or len(text) > 15000}}
    try:
        dt = email.utils.parsedate_to_datetime(str(msg.get("Date", "")))
        if dt.tzinfo: item["occurredAt"] = dt.astimezone(datetime.timezone.utc).isoformat()
    except Exception: pass
    return item

class MailError(Exception):
    pass

def tls_context(source):
    context = ssl.create_default_context()
    if source.get("tlsCertificate"):
        try: context.load_verify_locations(cadata=source["tlsCertificate"])
        except (ssl.SSLError, ValueError): raise MailError("certificate-config") from None
    return context

class BoundedIMAPRead:
    def __exit__(self, exc_type, exc_value, traceback):
        # A failed TLS upgrade can leave no usable socket. Logout must not hide
        # the original certificate/handshake error (or its safe diagnostic).
        try: self.logout()
        except Exception: pass

    def read(self, size):
        if size > MAX_MESSAGE: raise ValueError("IMAP literal too large")
        return super().read(size)

class BoundedIMAP(BoundedIMAPRead, imaplib.IMAP4_SSL):
    pass

class BoundedSTARTTLSIMAP(BoundedIMAPRead, imaplib.IMAP4):
    pass

def imap_poll(source, cursor, initial):
    context = tls_context(source)
    starttls = source.get("security", "tls") == "starttls"
    client = BoundedSTARTTLSIMAP if starttls else BoundedIMAP
    options = {} if starttls else {"ssl_context": context}
    with client(source["host"], source["port"], timeout=15, **options) as conn:
        conn.sock.settimeout(15)
        if starttls:
            if "STARTTLS" not in conn.capabilities: raise MailError("starttls")
            try: conn.starttls(ssl_context=context)
            except imaplib.IMAP4.error: raise MailError("starttls") from None
        try: conn.login(source["username"], source["password"])
        except imaplib.IMAP4.error: raise MailError("authentication") from None
        status, _ = conn.select(conn._quote(source.get("mailbox", "INBOX")), readonly=True)
        if status != "OK": raise ValueError("mailbox")
        validity = (conn.response("UIDVALIDITY")[1] or [None])[0]
        if not validity: raise ValueError("uidvalidity")
        validity = validity.decode()
        fresh = not cursor or cursor.get("validity") != validity
        last = 0 if fresh else int(cursor.get("uid", 0))
        status, data = conn.uid("SEARCH", None, "ALL" if fresh else "UID", *([] if fresh else [str(last + 1) + ":*"]))
        if status != "OK": raise ValueError("search")
        uids = sorted(int(uid) for uid in (data[0] or b"").split() if int(uid) > last)
        if len(uids) > MAX_MAILBOX: raise ValueError("mailbox too large")
        if fresh and (initial == "new" or cursor):
            return {"items": [], "cursor": json.dumps({"validity": validity, "uid": max(uids, default=0)})}
        selected = uids[-50:] if fresh else uids[:50]
        items = []
        for uid in selected:
            status, data = conn.uid("FETCH", str(uid), "(BODY.PEEK[]<0.65536>)")
            if status != "OK": raise ValueError("fetch")
            chunks = [entry[1] for entry in data if isinstance(entry, tuple)]
            if chunks:
                raw = b"".join(chunks)
                item = message(raw[:MAX_MESSAGE], validity + ":" + str(uid), len(raw) >= MAX_MESSAGE)
                item["metadata"].update({"uid": uid, "uidValidity": validity, "mailbox": source.get("mailbox", "INBOX")})
                items.append(item)
            last = uid
        return {"items": items, "cursor": json.dumps({"validity": validity, "uid": last})}

class BoundedPOPRead:
    def _getlongresp(self):
        response = self._getresp()
        lines = []
        total = 0
        while True:
            line, octets = self._getline()
            if line == b".": break
            total += octets
            if total > 2000000: raise ValueError("POP response too large")
            if line.startswith(b".."): line = line[1:]
            lines.append(line)
        return response, lines, total

class BoundedPOP(BoundedPOPRead, poplib.POP3_SSL):
    pass

class BoundedSTARTTLSPOP(BoundedPOPRead, poplib.POP3):
    pass

def pop_poll(source, cursor, initial):
    context = tls_context(source)
    starttls = source.get("security", "tls") == "starttls"
    client = BoundedSTARTTLSPOP if starttls else BoundedPOP
    options = {} if starttls else {"context": context}
    conn = client(source["host"], source["port"], timeout=15, **options)
    try:
        if starttls:
            try: conn.stls(context=context)
            except poplib.error_proto: raise MailError("starttls") from None
        try:
            conn.user(source["username"])
            conn.pass_(source["password"])
        except poplib.error_proto: raise MailError("authentication") from None
        listing = conn.uidl()[1]
        if len(listing) > MAX_MAILBOX: raise ValueError("mailbox too large")
        entries = [line.decode("ascii").split() for line in listing]
        all_ids = [uid for _, uid in entries]
        old = set(cursor.get("uids", [])) if cursor else set()
        if cursor is None and initial == "new":
            return {"items": [], "cursor": json.dumps({"uids": all_ids})}
        todo = [(n, uid) for n, uid in entries if uid not in old]
        selected = todo[-50:] if cursor is None else todo[:50]
        # A partial initial backfill deliberately skips older messages.
        if cursor is None: old.update(all_ids)
        items = []
        for number, uid in selected:
            size = int(conn.list(number).split()[2])
            if size > MAX_MESSAGE:
                raw = b"\r\n".join(conn.top(number, 30)[1])[:MAX_MESSAGE]
            else:
                raw = b"\r\n".join(conn.retr(number)[1])[:MAX_MESSAGE]
            item = message(raw, uid, size > MAX_MESSAGE)
            item["metadata"]["uidl"] = uid
            items.append(item)
            old.add(uid)
        return {"items": items, "cursor": json.dumps({"uids": [uid for uid in all_ids if uid in old]})}
    finally:
        try: conn.quit()
        except Exception:
            try: conn.close()
            except Exception: pass

def main():
    socket.setdefaulttimeout(15)
    request = json.load(sys.stdin)
    source = request["source"]
    cursor = json.loads(request["cursor"]) if request.get("cursor") else None
    result = (imap_poll if source["kind"] == "imap" else pop_poll)(source, cursor, request["initial"])
    print(json.dumps(result))

if __name__ == "__main__":
    try: main()
    except Exception as error:
        # Server messages may echo passwords or contain malicious text.
        code = "mail"
        if isinstance(error, MailError): code = str(error)
        elif isinstance(error, ssl.SSLCertVerificationError): code = "certificate"
        elif isinstance(error, ssl.SSLError): code = "tls"
        elif isinstance(error, (ConnectionError, socket.gaierror)): code = "connection"
        elif isinstance(error, (TimeoutError, socket.timeout)): code = "timeout"
        print(json.dumps({"error": code}))
        sys.exit(1)
