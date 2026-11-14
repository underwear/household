import { html } from "../core/card";
import type { MailSendView } from "../core/mail-connectors";
import type { OwnerCard } from "./chat";

type Decision = "pending" | "approved" | "denied";
/** Full immutable text, split by the channel adapter if needed; buttons follow the final chunk. */
export function mailApprovalCard(send: MailSendView): OwnerCard<Decision> {
  const header = ["<b>Approve outgoing email</b>", `Request: <code>${html(send.id)}</code>`, `From: ${html(send.from)}`, `To: ${html(send.to.join(", ") || "—")}`, ...(send.cc.length ? [`Cc: ${html(send.cc.join(", "))}`] : []), ...(send.bcc.length ? [`Bcc (hidden from recipients): ${html(send.bcc.join(", "))}`] : []), `Subject: ${html(send.subject)}`].join("\n");
  const attachments = send.attachments.length ? "\n\nAttachments (fixed copies):\n" + send.attachments.map(a => `${html(a.filename)} — ${a.size} bytes`).join("\n") : "\n\nNo attachments.";
  const text = `${header}\n\n<blockquote>${html(send.text)}</blockquote>${attachments}\n\nApprove sends exactly this message. Deny sends nothing. Expires at ${html(send.expiresAt)}.`;
  return { text, format: "html", start: "pending", view: state => state === "pending" ? { choices: [["Approve send"], ["Deny"]], text } : { outcome: state === "approved" ? "Approved for submission" : "Email denied" }, press: (state, index) => state !== "pending" ? state : index === 0 ? "approved" : index === 1 ? "denied" : state, cancelledText: () => `${header}\n\nThis approval request is closed. Check its current state in Household → Connectors.` };
}
