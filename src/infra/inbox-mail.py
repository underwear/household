"""Host-only read-only mail polling. Credentials arrive on stdin, never argv or logs."""
import email
import email.policy
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
    return {"id": identity, "title": str(msg.get("Subject", "(no subject)"))[:300], "text": text[:16000]}

class BoundedIMAP(imaplib.IMAP4_SSL):
    def read(self, size):
        if size > MAX_MESSAGE: raise ValueError("IMAP literal too large")
        return super().read(size)

def imap_poll(source, cursor, initial):
    context = ssl.create_default_context()
    with BoundedIMAP(source["host"], source["port"], ssl_context=context, timeout=15) as conn:
        conn.sock.settimeout(15)
        conn.login(source["username"], source["password"])
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
                items.append(message(raw[:MAX_MESSAGE], validity + ":" + str(uid), len(raw) >= MAX_MESSAGE))
            last = uid
        return {"items": items, "cursor": json.dumps({"validity": validity, "uid": last})}

class BoundedPOP(poplib.POP3_SSL):
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

def pop_poll(source, cursor, initial):
    conn = BoundedPOP(source["host"], source["port"], timeout=15, context=ssl.create_default_context())
    try:
        conn.user(source["username"])
        conn.pass_(source["password"])
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
            items.append(message(raw, uid, size > MAX_MESSAGE))
            old.add(uid)
        return {"items": items, "cursor": json.dumps({"uids": [uid for uid in all_ids if uid in old]})}
    finally:
        try: conn.quit()
        except Exception: conn.close()

def main():
    socket.setdefaulttimeout(15)
    request = json.load(sys.stdin)
    source = request["source"]
    cursor = json.loads(request["cursor"]) if request.get("cursor") else None
    result = (imap_poll if source["kind"] == "imap" else pop_poll)(source, cursor, request["initial"])
    print(json.dumps(result))

if __name__ == "__main__":
    try: main()
    except Exception:
        # Server messages may echo passwords or contain malicious text.
        print(json.dumps({"error": "Mail polling failed. Check host, TLS port, app password and mailbox; the server must support stable UIDs."}))
        sys.exit(1)
