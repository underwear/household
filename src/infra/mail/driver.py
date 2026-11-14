"""Host mail operations. All input (including credentials) is on stdin, no shell or server error text."""
import base64
import contextlib
import datetime
import email
import email.policy
import email.utils
from email.message import EmailMessage
import imaplib
import json
import re
import smtplib
import socket
import ssl
import sys

MAX_MESSAGE = 12 * 1024 * 1024
MAX_HEADER = 65536
MAX_UIDS = 100000

class MailError(Exception):
    pass

def tls_context(endpoint):
    context = ssl.create_default_context()
    if endpoint.get("tlsCertificate"):
        try: context.load_verify_locations(cadata=endpoint["tlsCertificate"])
        except (ssl.SSLError, ValueError): raise MailError("certificate-config") from None
    return context

class BoundedRead:
    def _charge(self, size):
        self.response_bytes = getattr(self, "response_bytes", 0) + size
        if self.response_bytes > 32 * 1024 * 1024: raise MailError("message-too-large")

    def _get_line(self):
        line = super()._get_line()
        self._charge(len(line))
        return line

    def read(self, size):
        if size > getattr(self, "literal_limit", MAX_MESSAGE): raise MailError("message-too-large")
        self._charge(size)
        return super().read(size)

class TLSIMAP(BoundedRead, imaplib.IMAP4_SSL): pass
class StartIMAP(BoundedRead, imaplib.IMAP4): pass

class SMTPReplyReader:
    def __init__(self, file, conn): self.file, self.conn = file, conn
    def readline(self, limit):
        line = self.file.readline(limit)
        self.conn.response_bytes = getattr(self.conn, "response_bytes", 0) + len(line)
        if self.conn.response_bytes > 1024 * 1024: raise MailError("reply-too-large")
        return line
    def close(self): self.file.close()

class BoundedSMTP:
    def getreply(self):
        if self.file is None: self.file = SMTPReplyReader(self.sock.makefile("rb"), self)
        return super().getreply()

class TLSSMTP(BoundedSMTP, smtplib.SMTP_SSL): pass
class StartSMTP(BoundedSMTP, smtplib.SMTP): pass

@contextlib.contextmanager
def imap(endpoint):
    context = tls_context(endpoint)
    start = endpoint["security"] == "starttls"
    conn = (StartIMAP if start else TLSIMAP)(endpoint["host"], endpoint["port"], timeout=15, **({} if start else {"ssl_context": context}))
    try:
        if start:
            if "STARTTLS" not in conn.capabilities: raise MailError("starttls")
            try: conn.starttls(ssl_context=context)
            except imaplib.IMAP4.error: raise MailError("starttls") from None
        try: conn.login(endpoint["username"], endpoint["password"])
        except imaplib.IMAP4.error: raise MailError("authentication") from None
        yield conn
    finally:
        try: conn.logout()
        except Exception:
            try: conn.shutdown()
            except Exception: pass

@contextlib.contextmanager
def smtp(endpoint):
    context = tls_context(endpoint)
    start = endpoint["security"] == "starttls"
    conn = (StartSMTP if start else TLSSMTP)(endpoint["host"], endpoint["port"], timeout=15, **({} if start else {"context": context}))
    try:
        conn.ehlo_or_helo_if_needed()
        if start:
            if not conn.has_extn("starttls"): raise MailError("starttls")
            try: conn.starttls(context=context)
            except smtplib.SMTPResponseException: raise MailError("starttls") from None
            conn.ehlo()
        try: conn.login(endpoint["username"], endpoint["password"])
        except smtplib.SMTPAuthenticationError: raise MailError("authentication") from None
        yield conn
    finally:
        try: conn.quit()
        except Exception:
            try: conn.close()
            except Exception: pass

def folder_encode(name):
    # RFC 3501 modified UTF-7, including literal ampersands.
    def encoded(match):
        return "&" + base64.b64encode(match.group().encode("utf-16be")).decode().rstrip("=").replace("/", ",") + "-"
    return re.sub(r"[^\x20-\x7e]+", encoded, name.replace("&", "&-"))

def folder_decode(name):
    def decoded(match):
        value = match.group(1)
        if not value: return "&"
        return base64.b64decode(value.replace(",", "/") + "=" * (-len(value) % 4)).decode("utf-16be")
    return re.sub(r"&([A-Za-z0-9+,]*)-", decoded, name)

def quote_folder(conn, name): return conn._quote(folder_encode(name))
def ok(response):
    status, data = response
    if status != "OK": raise MailError("imap-operation")
    return data

def selected(conn, mailbox, expected=None, write=False):
    ok(conn.select(quote_folder(conn, mailbox), readonly=not write))
    value = (conn.response("UIDVALIDITY")[1] or [None])[0]
    if not value or not re.fullmatch(rb"[1-9][0-9]*", value): raise MailError("uidvalidity")
    validity = value.decode()
    if expected is not None and expected != validity: raise MailError("stale-message")
    next_uid = (conn.response("UIDNEXT")[1] or [b"0"])[0] or b"0"
    return validity, int(next_uid)

def literal(data):
    chunks = [entry[1] for entry in data if isinstance(entry, tuple)]
    if not chunks: raise MailError("message-not-found")
    raw = b"".join(chunks)
    if len(raw) > MAX_MESSAGE: raise MailError("message-too-large")
    return raw

def fetch_message(conn, uid, headers=False):
    conn.literal_limit = MAX_HEADER if headers else MAX_MESSAGE
    if headers:
        raw = literal(ok(conn.uid("FETCH", str(uid), "(BODY.PEEK[HEADER]<0.%d>)" % (MAX_HEADER + 1))))
        if len(raw) > MAX_HEADER: raise MailError("message-too-large")
        return raw
    size_data = ok(conn.uid("FETCH", str(uid), "(RFC822.SIZE)"))
    sizes = [re.search(rb"RFC822.SIZE\s+(\d+)", d) for d in size_data if isinstance(d, bytes)]
    sizes = [int(m.group(1)) for m in sizes if m]
    if not sizes: raise MailError("message-not-found")
    if max(sizes) > MAX_MESSAGE: raise MailError("message-too-large")
    return literal(ok(conn.uid("FETCH", str(uid), "(BODY.PEEK[]<0.%d>)" % (MAX_MESSAGE + 1))))

def parsed(raw):
    count = 0
    def factory(policy):
        nonlocal count
        count += 1
        if count > 200: raise MailError("message-too-large")
        return EmailMessage(policy=policy)
    return email.message_from_bytes(raw, policy=email.policy.default.clone(message_factory=factory))
def addresses(msg, field):
    return [{"name": name[:200], "email": addr[:320]} for name, addr in email.utils.getaddresses(msg.get_all(field, []))][:50]

def envelope(raw, ref):
    msg = parsed(raw)
    return {"ref": ref, "subject": str(msg.get("Subject", ""))[:998], "from": addresses(msg, "From"), "to": addresses(msg, "To"), "cc": addresses(msg, "Cc"), "date": str(msg.get("Date", ""))[:100], "messageId": str(msg.get("Message-ID", ""))[:998], "inReplyTo": str(msg.get("In-Reply-To", ""))[:998], "references": str(msg.get("References", ""))[:4000]}

def parts(msg):
    result = list(msg.walk())
    if len(result) > 200: raise MailError("message-too-large")
    return result

def attachment_parts(msg):
    found = []
    index = 0
    def visit(part):
        nonlocal index
        current = index
        index += 1
        if part.get_content_disposition() == "attachment" or part.get_filename() is not None:
            found.append((current, part))
            return  # An attached .eml is one file, not its enclosed attachments.
        if part.is_multipart():
            for child in part.get_payload(): visit(child)
    visit(msg)
    return found

def attachment_bytes(part):
    payload = part.get_payload(decode=True)
    if payload is not None: return payload
    if part.get_content_maintype() == "message" and isinstance(part.get_payload(), list):
        return b"\r\n".join(child.as_bytes(policy=email.policy.SMTP) for child in part.get_payload())
    return part.as_bytes(policy=email.policy.SMTP)

def read_message(raw, ref):
    msg = parsed(raw)
    parts(msg)
    body = msg.get_body(preferencelist=("plain", "html")) if msg.is_multipart() else msg
    text = ""
    content_type = "text/plain"
    if body is not None and body.get_content_maintype() == "text":
        try: text = body.get_content()
        except Exception: text = (body.get_payload(decode=True) or b"").decode("utf-8", "replace")
        content_type = body.get_content_type()
    attachments = [{"id": str(i), "filename": str(part.get_filename() or "attachment")[:200], "contentType": part.get_content_type(), "size": len(attachment_bytes(part))} for i, part in attachment_parts(msg)]
    return {**envelope(raw, ref), "text": text[:64000], "contentType": content_type, "truncated": len(text) > 64000, "attachments": attachments}

def folders(conn):
    result = []
    for item in ok(conn.list()):
        if item is None: continue
        head, name_literal = (item[0], item[1]) if isinstance(item, tuple) else (item, None)
        match = re.match(rb'^\((.*?)\)\s+(?:NIL|"(?:[^"\\]|\\.)*")\s+(.*)$', head)
        if not match: raise MailError("imap-operation")
        name = name_literal if name_literal is not None else match.group(2)
        if name.startswith(b'"') and name.endswith(b'"'): name = re.sub(rb'\\(.)', rb'\1', name[1:-1])
        flags = match.group(1).decode("ascii", "replace").split()
        result.append({"name": folder_decode(name.decode("ascii")), "flags": flags, "selectable": "\\Noselect" not in flags})
        if len(result) > 500: raise MailError("mailbox-too-large")
    return {"mailboxes": result}

def search(conn, params):
    mailbox = params["mailbox"]
    cursor = params.get("cursor")
    validity, uid_next = selected(conn, mailbox, cursor.get("uidValidity") if cursor else None)
    criteria = []
    query = params.get("query", {})
    local = params.get("searchMode", "server") == "headers"
    if local and query.get("text"): raise MailError("header-search-text")
    if not cursor and uid_next == 0:
        baseline = ok(conn.uid("SEARCH", None, "ALL"))
        baseline_uids = (baseline[0] or b"").split()
        if len(baseline_uids) > MAX_UIDS: raise MailError("mailbox-too-large")
        uid_next = max((int(uid) for uid in baseline_uids), default=0) + 1
    upper = cursor["maxUid"] if cursor else max(0, uid_next - 1)
    before = cursor["beforeUid"] if cursor else upper + 1
    if upper == 0: return {"items": [], "complete": True, "scanned": 0}
    criteria += ["UID", "1:" + str(min(upper, before - 1))]
    if before <= 1: return {"items": [], "complete": True, "scanned": 0}
    conn._encoding = "utf-8"
    for field in ("from", "to", "subject", "text"):
        if query.get(field) and not local: criteria += [field.upper(), conn._quote(query[field])]
    for field, command in (("since", "SINCE"), ("before", "BEFORE")):
        if query.get(field): criteria += [command, datetime.date.fromisoformat(query[field]).strftime("%d-%b-%Y")]
    if query.get("unread"): criteria += ["UNSEEN"]
    unicode_query = any(not value.isascii() for value in criteria)
    conn._encoding = "utf-8" if unicode_query else "ascii"
    response = conn.uid("SEARCH", *(["CHARSET", "UTF-8"] if unicode_query else []), *criteria)
    if unicode_query and response[0] != "OK": raise MailError("search-charset")
    data = ok(response)
    uids = sorted((int(uid) for uid in (data[0] or b"").split() if 0 < int(uid) < before and int(uid) <= upper), reverse=True)
    if len(uids) > MAX_UIDS: raise MailError("mailbox-too-large")
    items, scanned, last = [], 0, before
    for uid in uids[:200 if local else params["limit"]]:
        raw = fetch_message(conn, uid, headers=True)
        last = uid
        scanned += 1
        entry = envelope(raw, {"mailbox": mailbox, "uidValidity": validity, "uid": uid})
        if local:
            headers = parsed(raw)
            values = {field: " ".join(str(value) for value in headers.get_all(field, [])) for field in ("from", "to", "subject")}
            if any(query.get(field) and query[field].casefold() not in value.casefold() for field, value in values.items()): continue
        items.append(entry)
        if len(items) >= params["limit"]: break
    more = len(uids) > scanned
    return {"items": items, "scanned": scanned, "complete": not more, **({"next": {"uidValidity": validity, "maxUid": upper, "beforeUid": last}} if more else {})}

def compose(config, params):
    msg = EmailMessage(policy=email.policy.SMTP)
    msg["From"] = email.utils.formataddr((config.get("displayName", ""), config["email"]))
    for field in ("to", "cc"):
        if params.get(field): msg[field.title()] = ", ".join(params[field])
    msg["Subject"] = params["subject"]
    msg["Date"] = params["date"]
    msg["Message-ID"] = params["messageId"]
    if params.get("replyHeaders"):
        original = params["replyHeaders"]
        parent = original.get("messageId", "")
        if not re.fullmatch(r"<[^<>\r\n\s]{1,900}>", parent): raise MailError("reply-header")
        msg["In-Reply-To"] = parent
        refs = re.findall(r"<[^<>\r\n\s]{1,900}>", original.get("references", ""))[-20:]
        msg["References"] = " ".join(refs + [parent])
    msg.set_content(params["text"], cte="quoted-printable")
    for item in params.get("attachments", []):
        data = base64.b64decode(item["data"], validate=True)
        maintype, subtype = item["contentType"].split("/", 1)
        if maintype.lower() in ("message", "multipart"): maintype, subtype = "application", "octet-stream"
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=item["filename"])
    raw = msg.as_bytes()
    if len(raw) > MAX_MESSAGE: raise MailError("message-too-large")
    return {"raw": base64.b64encode(raw).decode()}

def send(config, params):
    raw = base64.b64decode(params["raw"], validate=True)
    if len(raw) > MAX_MESSAGE: raise MailError("message-too-large")
    # The transport envelope includes Bcc, but the transmitted MIME never does.
    headers = parsed(raw)
    if headers.get_all("Bcc") or headers.get_all("Resent-Bcc"): raise MailError("invalid-wire-message")
    phase = "before-data"
    try:
        with smtp(config["smtp"]) as conn:
            if conn.mail(config["email"])[0] != 250: raise MailError("smtp-refused")
            refused = []
            for recipient in params["recipients"]:
                if conn.rcpt(recipient)[0] not in (250, 251): refused.append(recipient)
            if refused:
                try: conn.rset()
                except Exception: pass
                return {"delivery": "not-sent", "error": "recipients-refused", "refused": refused}
            phase = "data"
            code, _ = conn.data(raw)
            if code != 250: return {"delivery": "not-sent", "error": "smtp-refused"}
            phase = "accepted"
            return {"delivery": "sent"}
    except smtplib.SMTPDataError:
        return {"delivery": "not-sent", "error": "smtp-refused"}
    except Exception as error:
        return {"delivery": "unknown" if phase == "data" else "not-sent", "error": safe_error(error)}

def execute(config, operation, params):
    if operation == "compose": return compose(config, params)
    if operation == "send": return send(config, params)
    if operation == "probe":
        with imap(config["imap"]) as conn: folders(conn)
        if config.get("smtp"):
            with smtp(config["smtp"]): pass
        return {"ok": True}
    with imap(config["imap"]) as conn:
        if operation == "mailboxes.list": return folders(conn)
        if operation == "messages.search": return search(conn, params)
        if operation == "mailboxes.create":
            ok(conn.create(quote_folder(conn, params["mailbox"])))
            return {"done": True}
        if operation == "mailboxes.rename":
            ok(conn.rename(quote_folder(conn, params["mailbox"]), quote_folder(conn, params["destination"])))
            return {"done": True}
        if operation in ("append", "drafts.save"):
            folder = params["mailbox"]
            raw = base64.b64decode(params["raw"], validate=True)
            if len(raw) > MAX_MESSAGE: raise MailError("message-too-large")
            ok(conn.append(quote_folder(conn, folder), "(\\Draft)" if operation == "drafts.save" else "(\\Seen)", None, raw))
            return {"done": True}
        ref = params["ref"]
        write = operation in ("flags.update", "messages.move", "messages.trash")
        selected(conn, ref["mailbox"], ref["uidValidity"], write=write)
        if operation in ("messages.read", "attachments.download", "reply.headers"):
            raw = fetch_message(conn, ref["uid"], headers=operation == "reply.headers")
            if operation == "reply.headers": return envelope(raw, ref)
            if operation == "messages.read": return read_message(raw, ref)
            for index, part in attachment_parts(parsed(raw)):
                if str(index) == params["attachment"]:
                    data = attachment_bytes(part)
                    if len(data) > 8 * 1024 * 1024: raise MailError("message-too-large")
                    return {"filename": str(part.get_filename() or "attachment")[:200], "contentType": part.get_content_type(), "data": base64.b64encode(data).decode()}
            raise MailError("attachment-not-found")
        # Verify existence without changing Seen before a mutation.
        fetch_message(conn, ref["uid"], headers=True)
        if operation == "flags.update":
            for mode, field in (("+FLAGS.SILENT", "add"), ("-FLAGS.SILENT", "remove")):
                if params.get(field): ok(conn.uid("STORE", str(ref["uid"]), mode, "(" + " ".join("\\" + flag for flag in params[field]) + ")"))
            return {"done": True}
        if operation in ("messages.move", "messages.trash"):
            if "MOVE" not in conn.capabilities: raise MailError("move-unsupported")
            destination = config["trashFolder"] if operation == "messages.trash" else params["destination"]
            ok(conn.uid("MOVE", str(ref["uid"]), quote_folder(conn, destination)))
            return {"done": True, "destination": destination}
        raise MailError("operation")

def safe_error(error):
    if isinstance(error, MailError): return str(error)
    if isinstance(error, ssl.SSLCertVerificationError): return "certificate"
    if isinstance(error, ssl.SSLError): return "tls"
    if isinstance(error, (TimeoutError, socket.timeout)): return "timeout"
    if isinstance(error, (ConnectionError, socket.gaierror)): return "connection"
    return "mail"

if __name__ == "__main__":
    socket.setdefaulttimeout(15)
    try:
        request = json.load(sys.stdin)
        print(json.dumps({"data": execute(request["config"], request["operation"], request.get("params", {}))}))
    except Exception as error:
        print(json.dumps({"error": safe_error(error)}))
        sys.exit(1)
