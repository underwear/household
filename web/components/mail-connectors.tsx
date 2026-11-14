import { useEffect, useState } from "react";
import { api, type MailConnectionInput, type MailConnectionView, type MailConnectorsView, type MailEndpoint, type MailSendView } from "../api";
import { Dialog } from "./dialog";
import { ChoiceList, Field, FormGroup, SelectField, Switch, SwitchList, TextField } from "./fields";
import { Cell, FormGrid, List, ListRow, Section } from "./layout";

export const mailAccessWords = (c: Pick<MailConnectionView, "sendPolicy" | "allowManage">) => `${c.sendPolicy === "auto" ? "send automatically" : c.sendPolicy === "approval" ? "approve each outgoing email" : "no sending"}${c.allowManage ? ", mailbox changes allowed" : ", mailbox read only"}`;
export function useMailConnections(house: string) {
  const [view, setView] = useState<MailConnectorsView>();
  const [error, setError] = useState("");
  const refresh = async () => { try { setView(await api.mailConnections(house)); setError(""); } catch (e) { setError((e as Error).message); } };
  useEffect(() => {
    let live = true;
    setView(undefined);
    const load = async () => { try { const v = await api.mailConnections(house); if (live) { setView(v); setError(""); } } catch (e) { if (live) setError((e as Error).message); } };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { live = false; clearInterval(timer); };
  }, [house]);
  return { ...view, error, refresh };
}
const emptyEndpoint = (port: number): MailEndpoint => ({ host: "", port, username: "", password: "", security: "tls" });

export function MailEndpointFields({ title, endpoint, onChange, existing }: { title: "IMAP" | "SMTP"; endpoint: MailEndpoint; onChange: (v: MailEndpoint) => void; existing?: boolean }) {
  const set = (fields: Partial<MailEndpoint>) => onChange({ ...endpoint, ...fields });
  const defaultPort = title === "IMAP" ? (endpoint.security === "tls" ? 993 : 143) : (endpoint.security === "tls" ? 465 : 587);
  return <FormGroup title={title}>
    <FormGrid>
      <TextField label={`${title} server`} mono value={endpoint.host} onChange={host => set({ host })} placeholder={title === "IMAP" ? "imap.example.com" : "smtp.example.com"} />
      <TextField label={`${title} port`} mono inputMode="numeric" value={String(endpoint.port || "")} onChange={port => set({ port: Number(port) })} placeholder={String(defaultPort)} />
    </FormGrid>
    <SelectField label={`${title} security`} value={endpoint.security} onChange={v => set({ security: v as MailEndpoint["security"], ...(endpoint.port === defaultPort ? { port: title === "IMAP" ? (v === "tls" ? 993 : 143) : (v === "tls" ? 465 : 587) } : {}) })} options={[{ value: "tls", label: "TLS — encrypted from the start" }, { value: "starttls", label: "STARTTLS — require encryption before login" }]} />
    <FormGrid>
      <TextField label={`${title} username`} mono value={endpoint.username} onChange={username => set({ username })} />
      <TextField label={`${title} password`} type="password" value={endpoint.password} onChange={password => set({ password })} hint={existing ? "Leave blank to retain the password for the same server, port and username." : "Use the app password; for Proton, use the password shown in Bridge."} />
    </FormGrid>
    <Field id={`mail-${title}-certificate`} label={`${title} trusted certificate (optional)`} hint="PEM certificate, never a private key. For Bridge, export it from Settings → Advanced settings → Export TLS certificates. Publicly trusted servers need none.">
      <textarea id={`mail-${title}-certificate`} className="control mono" rows={3} spellCheck={false} value={endpoint.tlsCertificate ?? ""} onChange={e => set({ tlsCertificate: e.target.value || undefined })} />
    </Field>
  </FormGroup>;
}

export function MailSetup({ house, existing, options, onClose, saved, back }: { house: string; existing?: MailConnectionView; options: { value: string; label: string }[]; onClose: () => void; saved: () => Promise<void>; back?: () => void }) {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState(existing?.title ?? "Mail");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
  const [imap, setImap] = useState<MailEndpoint>(existing ? { ...existing.imap, password: "" } : emptyEndpoint(993));
  const [smtp, setSmtp] = useState<MailEndpoint>(existing?.smtp ? { ...existing.smtp, password: "" } : emptyEndpoint(465));
  const [sendPolicy, setSendPolicy] = useState<MailConnectionInput["sendPolicy"]>(existing?.sendPolicy ?? "disabled");
  const [allowManage, setAllowManage] = useState(existing?.allowManage ?? false);
  const [sentFolder, setSentFolder] = useState(existing?.sentFolder ?? "");
  const [draftsFolder, setDraftsFolder] = useState(existing?.draftsFolder ?? "Drafts");
  const [trashFolder, setTrashFolder] = useState(existing?.trashFolder ?? "Trash");
  const [pets, setPets] = useState(existing?.pets ?? []);
  const fields = (): MailConnectionInput => ({ title, email, displayName, imap, ...(sendPolicy !== "disabled" ? { smtp } : {}), sendPolicy, allowManage, ...(sentFolder.trim() ? { sentFolder: sentFolder.trim() } : {}), draftsFolder, trashFolder, pets });
  return <Dialog onClose={onClose} spec={{ title: existing ? `Edit ${existing.title}` : "Connect mail", wide: true, step: `mail-setup-${step}`, confirmLabel: step < 2 ? "Next" : "Test and save", busyLabel: "Verifying connection…", back: step ? () => setStep(step - 1) : back, onConfirm: async () => {
    if (step < 2) { setStep(step + 1); return "stay"; }
    await api.saveMail(house, fields(), existing?.id); await saved();
  }, children: <>
    <ol className="steps" aria-label="Steps">{["Account", "Sending", "Access"].map((label, i) => <li key={label} className={i === step ? "current" : i < step ? "done" : undefined}>{label}</li>)}</ol>
    {step === 0 && <>
      <p className="dialog-text">Search and read the live mailbox. Credentials stay on this host. For Proton Bridge, run Bridge here and use the ports and generated password shown in its account settings.</p>
      <TextField label="Connection name" value={title} onChange={setTitle} />
      <FormGrid><TextField label="Email address" value={email} onChange={setEmail} /><TextField label="Sender name" value={displayName} onChange={setDisplayName} /></FormGrid>
      <MailEndpointFields title="IMAP" endpoint={imap} onChange={setImap} existing={!!existing} />
    </>}
    {step === 1 && <>
      <ChoiceList label="Sending" value={sendPolicy} onChange={v => setSendPolicy(v as MailConnectionInput["sendPolicy"])} options={[
        { value: "disabled", label: "No sending", description: "Bots can read mail. SMTP is not connected." },
        { value: "approval", label: "Approve each outgoing email", description: "The send tool waits for your approval of its recipients, text and fixed attachments. You can deny or withdraw it before submission." },
        { value: "auto", label: "Send automatically", description: "Selected bots may send from this address without an approval prompt." },
      ]} />
      {sendPolicy !== "disabled" && <>
        <p className="hint">Outgoing mail always uses {email || "the configured email address"}. {sendPolicy === "approval" && "The full approval is shown in the requesting bot’s chat and in Household Connectors. Choose bot access accordingly."}</p>
        <MailEndpointFields title="SMTP" endpoint={smtp} onChange={setSmtp} existing={!!existing?.smtp} />
        <TextField label="Save an additional Sent copy to (optional)" value={sentFolder} onChange={setSentFolder} placeholder="Sent" hint="Leave empty if your server already saves sent mail, as Proton Bridge normally does. A copy failure never resends the email." />
      </>}
    </>}
    {step === 2 && <>
      <FormGroup title="Mailbox changes">
        <Switch label="Allow mailbox changes" on={allowManage} onChange={setAllowManage} />
        <p className="hint">Allows flags, moving messages, saving drafts and creating or renaming folders. Sending has its own setting. Permanent deletion and global expunge are unavailable.</p>
        {allowManage && <FormGrid><TextField label="Drafts folder" value={draftsFolder} onChange={setDraftsFolder} /><TextField label="Trash folder" value={trashFolder} onChange={setTrashFolder} /></FormGrid>}
      </FormGroup>
      <FormGroup title="Bot access"><SwitchList label="Bot access" options={options} on={pets} onToggle={name => setPets(values => values.includes(name) ? values.filter(v => v !== name) : [...values, name])} />
        <p className="hint">No bots selected keeps this account private. Sideworkers inherit their parent's access; scouts do not. Mail a bot reads goes to its AI provider and may appear in its chat.</p>
      </FormGroup>
      <p className="hint">Saving tests authentication, sends no email and changes no messages. {existing && "Saving new settings closes pending approvals; bots must request them again."}</p>
    </>}
  </> }} />;
}

export function MailSends({ house, sends, refresh, notify }: { house: string; sends: MailSendView[]; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const [opened, setOpened] = useState<string>();
  const [busy, setBusy] = useState(false);
  const send = sends.find(s => s.id === opened);
  const decide = async (decision: "approved" | "denied" | "cancelled") => {
    if (!send) return;
    setBusy(true);
    try { await api.decideMail(house, send.id, decision); await refresh(); setOpened(undefined); }
    catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };
  if (!sends.length) return null;
  return <Section title="Outgoing mail" hint="Pending requests wait here and in the bot's chat. Unknown delivery is never automatically retried.">
    <List columns="minmax(0, 1fr) auto">{sends.slice(0, 30).map(s => <ListRow key={s.id} actions={<button className="text-btn plain" onClick={() => setOpened(s.id)}>{s.state === "pending" ? "Review" : "Details"}</button>}><Cell lines><span className="strong">{s.subject || "(no subject)"}</span><span className="hint">{s.pet} · {s.state} · {s.to.length + s.cc.length + s.bcc.length} recipients</span></Cell></ListRow>)}</List>
    {send && <Dialog onClose={() => setOpened(undefined)} spec={{ title: send.state === "pending" ? "Review outgoing email" : "Outgoing email", wide: true, cancelLabel: "Close", confirmLabel: send.state === "pending" ? "Approve and send" : "Close", busyLabel: "Submitting decision…", onConfirm: async () => { if (send.state === "pending") await decide("approved"); }, children: <>
      <p className="hint">{send.state} · Request {send.id}</p>
      <dl><dt>From</dt><dd>{send.from}</dd><dt>To</dt><dd>{send.to.join(", ") || "—"}</dd>{send.cc.length > 0 && <><dt>Cc</dt><dd>{send.cc.join(", ")}</dd></>}{send.bcc.length > 0 && <><dt>Bcc (hidden from recipients)</dt><dd>{send.bcc.join(", ")}</dd></>}<dt>Subject</dt><dd>{send.subject}</dd></dl>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{send.text}</pre>
      {send.attachments.length > 0 && <FormGroup title="Attachments">{send.attachments.map((a, i) => <p key={i} className="hint" style={{ overflowWrap: "anywhere" }}>{a.filename} · {a.size} bytes</p>)}</FormGroup>}
      {send.detail && <p className="hint">{send.detail}</p>}
      {send.state === "pending" && <><p className="hint">Approval sends exactly this message. Expires at {new Date(send.expiresAt).toLocaleTimeString()}.</p><button type="button" className="btn" disabled={busy} onClick={() => void decide("denied")}>Deny</button></>}
    </> }} />}
  </Section>;
}
