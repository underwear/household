import { HouseholdError } from "../../core/errors";
import type { MailConnectionInput } from "../../core/mail-connectors";
import helper from "./driver.py" with { type: "text" };

const errors: Record<string, string> = {
  certificate: "Mail certificate could not be verified. Check the hostname and expiry; for Proton Bridge, add its exported TLS certificate.",
  "certificate-config": "The trusted certificate is not a valid PEM certificate.",
  authentication: "Mail login rejected. Use the provider's app password or the password shown in Proton Bridge.",
  starttls: "Mail server did not accept STARTTLS. Check connection security and port; no credentials were sent.",
  tls: "TLS negotiation failed. Check that connection security matches the server port.",
  connection: "Could not connect to the mail server. Bridge must be running on the Household host.",
  timeout: "Mail request timed out.",
  "reply-too-large": "Mail server response exceeds the size limit.",
  "stale-message": "Mailbox UIDVALIDITY changed. Search again; old message references are no longer valid.",
  uidvalidity: "The mailbox did not provide stable UIDVALIDITY.",
  "message-too-large": "Mail message, MIME structure or attachment exceeds the size limit; use a mail client for this item.",
  "mailbox-too-large": "Mail result exceeds the limit. Narrow the mailbox search with dates or other filters.",
  "message-not-found": "Message no longer exists in this mailbox. Search again.",
  "attachment-not-found": "Attachment no longer matches this message. Read it again.",
  "header-search-text": "Local header search supports from, to and subject. Use server search for body text.",
  "search-charset": "The server rejected Unicode search. Try headers search mode for from, to or subject filters.",
  "move-unsupported": "This server does not support UID MOVE. No copy, delete or global expunge was attempted.",
  "reply-header": "Original message has no usable Message-ID for a threaded reply.",
  "smtp-refused": "SMTP refused the message; it was not accepted for delivery.",
  "recipients-refused": "SMTP refused one or more recipients. No message data was sent to any recipient.",
  "imap-operation": "IMAP operation failed. Check mailbox, permissions and server support.",
  mail: "Mail operation failed. Check the connection and retry reads; inspect the mailbox before retrying a change.",
};
export class MailTransportError extends HouseholdError {
  constructor(readonly code: string) { super(errors[code] ?? errors.mail!); }
}
export type MailDriver = (config: MailConnectionInput, operation: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;

/** One bounded host process. Never forwards stderr or server text into errors. */
export const mailDriver: MailDriver = async (config, operation, params, signal) => {
  signal?.throwIfAborted();
  const proc = Bun.spawn(["python3", "-c", helper], { stdin: new Blob([JSON.stringify({ config, operation, params })]), stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL", signal });
  const read = async (stream: ReadableStream<Uint8Array>, limit: number) => {
    const reader = stream.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) { proc.kill(); throw new MailTransportError("message-too-large"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const results = await Promise.allSettled([read(proc.stdout, 20 * 1024 * 1024), read(proc.stderr, 128 * 1024), proc.exited]);
  const output = results[0], exit = results[2];
  if (output.status !== "fulfilled" || exit.status !== "fulfilled") throw new MailTransportError("mail");
  let parsed: { data?: unknown; error?: string };
  try { parsed = JSON.parse(output.value); } catch { throw new MailTransportError("mail"); }
  if (exit.value !== 0 || parsed.error) throw new MailTransportError(typeof parsed.error === "string" && Object.hasOwn(errors, parsed.error) ? parsed.error : "mail");
  if (!Object.hasOwn(parsed, "data")) throw new MailTransportError("mail");
  return parsed.data;
};
export const mailErrorText = (code: string) => Object.hasOwn(errors, code) ? errors[code]! : errors.mail!;
