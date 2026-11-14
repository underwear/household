import { CONNECTOR_ACCESS_OPTIONS, connectorAccessWords } from "../../src/core/connector-write-policy";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { MAIL_NO_CHAT, mailWritePolicy } from "../../src/core/mail-connectors";
import { api, type MailConnectionInput, type MailConnectionView, type MailConnectorsView, type MailEndpoint, type MailSendPolicy, type MailSendView } from "../api";
import { Dialog } from "./dialog";
import { ChoiceList, Field, Fold, FormGroup, SwitchList, TextField } from "./fields";
import { Cluster, FormGrid } from "./layout";

type Security = MailEndpoint["security"];
type Server = { host: string; port: number; security: Security };

/** A server's usual port for its security: what a port follows until the owner types another. */
const usualPort = (kind: "imap" | "smtp", security: Security) => (kind === "imap" ? (security === "tls" ? 993 : 143) : security === "tls" ? 465 : 587);
/** Just the server of an endpoint, or an empty one. */
const server = (s: Server | undefined, kind: "imap" | "smtp"): Server => (s ? { host: s.host, port: s.port, security: s.security } : { host: "", port: usualPort(kind, "tls"), security: "tls" });

/** «reads», «reads and sends with your OK», «reads, sends and organizes». */
export const mailAccessWords = (c: Pick<MailConnectionView, "sendPolicy" | "allowManage" | "writePolicy">) => connectorAccessWords(mailWritePolicy(c));

/** Keep legacy SMTP/IMAP restrictions on unrelated edits; a different access mode applies to both. */
export function mailPermissions(existing: MailConnectionView | undefined, policy: MailSendPolicy, outgoing: boolean): Pick<MailConnectionInput, "writePolicy" | "sendPolicy" | "allowManage"> {
  const preserve = existing && policy === mailWritePolicy(existing);
  return {
    writePolicy: policy,
    allowManage: policy !== "disabled" && (preserve ? existing.allowManage : true),
    sendPolicy: !outgoing || policy === "disabled" ? "disabled" : preserve && existing.smtp ? existing.sendPolicy : policy,
  };
}

/** A workspace's mail connections and what their bots asked to send, reloaded every 5 s (approvals come and go). */
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

/** A saved connection as the input that saves it again: no passwords (the host keeps them for the same server and username). */
export const mailInput = (c: MailConnectionView, pets = c.pets): MailConnectionInput => ({
  title: c.title, email: c.email, displayName: c.displayName, imap: { ...c.imap, password: "" }, ...(c.smtp ? { smtp: { ...c.smtp, password: "" } } : {}),
  writePolicy: c.writePolicy, sendPolicy: c.sendPolicy, allowManage: c.allowManage, ...(c.sentFolder ? { sentFolder: c.sentFolder } : {}), draftsFolder: c.draftsFolder, trashFolder: c.trashFolder, pets,
});

/** What the owner should know about a connection's outgoing mail: waiting in a chat, or recently gone wrong. */
export interface MailNotice { key: string; tone: "busy" | "danger" | "wait"; text: string; detail?: string }
const RECENT = 7 * 86400_000;
export function mailNotices(sends: MailSendView[], connection: string, botTitle: (name: string) => string, now = Date.now()): MailNotice[] {
  const own = sends.filter((s) => s.connection === connection);
  const subject = (s: MailSendView) => `«${s.subject || "No subject"}»`;
  const waiting = new Map<string, MailSendView[]>();
  for (const s of own) if (s.state === "pending") waiting.set(s.pet, [...(waiting.get(s.pet) ?? []), s]);
  const notices: MailNotice[] = [...waiting].map(([pet, items]) => ({ key: `waiting-${pet}`, tone: "busy", text: `${items.length === 1 ? `${subject(items[0]!)} is` : `${items.length} emails are`} waiting for your OK in ${botTitle(pet)}'s chat` }));
  for (const s of own) {
    if (now - Date.parse(s.createdAt) > RECENT) continue;
    if (s.state === "unknown") notices.push({ key: s.id, tone: "danger", text: `${subject(s)} may not have gone out: check Sent before asking ${botTitle(s.pet)} to send it again` });
    else if (s.state === "failed") notices.push({ key: s.id, tone: "danger", text: `${subject(s)} wasn't sent`, detail: s.detail });
    else if (s.state === "cancelled" && s.detail === MAIL_NO_CHAT) notices.push({ key: s.id, tone: "danger", text: `${subject(s)} wasn't sent: ${botTitle(s.pet)} is in no chat where you could approve it. Add it to a channel.` });
    else if (s.state === "sent-copy-failed") notices.push({ key: s.id, tone: "wait", text: `${subject(s)} was sent, but its copy wasn't saved to your Sent folder` });
  }
  return notices.slice(0, 3);
}

/** A server's address, port and security; the port follows the security while it is the usual one. */
function ServerFields({ kind, server, onChange, errors }: { kind: "imap" | "smtp"; server: Server; onChange: (s: Server) => void; errors: Record<string, string | undefined> }) {
  const secure = (security: Security) => onChange({ ...server, security, ...(server.port === usualPort(kind, server.security) || !server.port ? { port: usualPort(kind, security) } : {}) });
  return <>
    <FormGrid>
      <TextField label="Server" mono value={server.host} onChange={(host) => onChange({ ...server, host: host.trim() })} placeholder={kind === "imap" ? "imap.example.com" : "smtp.example.com"} error={errors.host} />
      <TextField label="Port" mono inputMode="numeric" value={server.port ? String(server.port) : ""} onChange={(port) => onChange({ ...server, port: Number(port.replace(/\D/g, "")) })} placeholder={String(usualPort(kind, server.security))} error={errors.port} />
    </FormGrid>
    <Field id={`mail-${kind}-security`} label="Security" hint={server.security === "tls" ? "Encrypted from the first byte." : "Upgrades to encryption before signing in; never falls back to plain text."}>
      <span className="segmented wide" id={`mail-${kind}-security`} role="group">
        {(["tls", "starttls"] as const).map((s) => <button key={s} type="button" aria-pressed={server.security === s} onClick={() => secure(s)}>{s === "tls" ? "SSL/TLS" : "STARTTLS"}</button>)}
      </span>
    </Field>
  </>;
}

/**
 * The certificates in a PEM file's text, without anything else in it (a private key saved in the same file stays out),
 * and whether the file holds a private key.
 */
export function certificatesIn(text: string): { certificates: string; privateKey: boolean } {
  const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return { certificates: certificates.join("\n"), privateKey: /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) };
}

const PEM = /^(?:-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+\s+-----END CERTIFICATE-----\s*)+$/;
const STEPS = ["Account", "Sending", "Permissions", "Bots"] as const;
/** Where sending most likely is, from where reading is: imap.example.com → smtp.example.com, else the same host. */
const outgoingHost = (incoming: string) => (incoming.startsWith("imap.") ? `smtp.${incoming.slice(5)}` : incoming);
const toggle = (values: string[], value: string) => (values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);

/**
 * Connecting a mailbox, in steps: the account and its incoming (IMAP) server, Next checking the sign-in; sending, its
 * outgoing (SMTP) server, checked the same way, or skipped for now (bots then only read); what bots may do with it;
 * which bots. Editing one shows the same parts as tabs, saved at once; sending can be set up or removed there.
 */
export function MailSetup({ house, existing, options, waiting = 0, onClose, saved, back }: {
  house: string; existing?: MailConnectionView; options: { value: string; label: string }[];
  /** Emails waiting for approval on this connection: saving cancels them. */ waiting?: number;
  onClose: () => void; saved: () => Promise<void>; back?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState(existing?.title ?? "Mail");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(existing?.imap.username ?? "");
  const [imap, setImap] = useState<Server>(server(existing?.imap, "imap"));
  const [smtp, setSmtp] = useState<Server>(server(existing?.smtp, "smtp"));
  const [sameLogin, setSameLogin] = useState(!existing?.smtp || existing.smtp.username === existing.imap.username);
  const [smtpUsername, setSmtpUsername] = useState(existing?.smtp?.username ?? "");
  const [smtpPassword, setSmtpPassword] = useState("");
  const savedCertificate = existing?.imap.tlsCertificate ?? existing?.smtp?.tlsCertificate ?? "";
  const [certificate, setCertificate] = useState(savedCertificate);
  /** What choosing a certificate file came to: a note, or why it was not taken. */
  const [certificateFile, setCertificateFile] = useState<{ note?: string; error?: string }>({});
  const certificatePicker = useRef<HTMLInputElement>(null);
  /** A chosen file's text goes into the field: its certificates only, never a key. */
  const chooseCertificate = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) return setCertificateFile({ error: `${file.name} is too big for a certificate.` });
    const { certificates, privateKey } = certificatesIn(await file.text());
    if (certificates) {
      setCertificate(certificates);
      setCertificateFile({ note: privateKey ? `From ${file.name}: its certificate only, without the private key.` : `From ${file.name}.` });
    } else setCertificateFile({ error: privateKey ? `${file.name} is a private key. Choose the certificate (often cert.pem), not the key.` : `No PEM certificate in ${file.name}: it should be text starting with -----BEGIN CERTIFICATE-----.` });
  };
  /** Sending is set up (an outgoing server); off: skipped, bots only read. */
  const [outgoing, setOutgoing] = useState(existing ? !!existing.smtp : true);
  const [sendPolicy, setSendPolicy] = useState<MailSendPolicy>(existing ? mailWritePolicy(existing) : "approval");
  const permissions = mailPermissions(existing, sendPolicy, outgoing);
  const allowManage = permissions.allowManage;
  const [sentFolder, setSentFolder] = useState(existing?.sentFolder ?? "");
  const [draftsFolder, setDraftsFolder] = useState(existing?.draftsFolder ?? "Drafts");
  const [trashFolder, setTrashFolder] = useState(existing?.trashFolder ?? "Trash");
  const [pets, setPets] = useState(existing?.pets ?? []);
  const [tried, setTried] = useState(-1);
  const [checked, setChecked] = useState<string>();

  /** The sign-in name follows the address until the owner sets another. */
  const changeEmail = (value: string) => {
    if (username && username === email.trim()) setUsername(value.trim());
    if (smtpUsername && smtpUsername === email.trim()) setSmtpUsername(value.trim());
    setEmail(value);
  };
  const login = username || email.trim();
  const cert = certificate.trim() || undefined;
  // One certificate for both servers; an older connection's own for sending stays until the field is changed.
  const smtpCert = certificate === savedCertificate && existing?.smtp?.tlsCertificate && existing.smtp.tlsCertificate !== existing.imap.tlsCertificate ? existing.smtp.tlsCertificate : cert;
  const smtpEndpoint = (): MailEndpoint => ({ ...smtp, ...(sameLogin ? { username: login, password } : { username: smtpUsername || login, password: smtpPassword }), ...(smtpCert ? { tlsCertificate: smtpCert } : {}) });
  // With sending set up its server stays saved even while bots may not send («Don't send»), ready to turn on.
  const config = (): MailConnectionInput => ({
    title: title.trim() || "Mail", email: email.trim(), displayName: displayName.trim(),
    imap: { ...imap, username: login, password, ...(cert ? { tlsCertificate: cert } : {}) },
    ...(outgoing ? { smtp: smtpEndpoint() } : {}),
    ...permissions, ...(sentFolder.trim() ? { sentFolder: sentFolder.trim() } : {}), draftsFolder: draftsFolder.trim() || "Drafts", trashFolder: trashFolder.trim() || "Trash", pets,
  });

  // What is wrong with each part, shown once its Next (or Save) was pressed.
  const keeps = (endpoint?: Omit<MailEndpoint, "password">, server?: Server, user?: string) => !!endpoint && !!server && endpoint.host === server.host && endpoint.port === server.port && endpoint.username === user;
  const account = {
    email: !z.email().max(320).safeParse(email.trim()).success ? "Enter the mailbox's email address." : undefined,
    password: !password && !keeps(existing?.imap, imap, login) ? "Enter the password." : undefined,
    host: !imap.host ? "Enter the incoming mail server." : !/^[a-zA-Z0-9.:-]+$/.test(imap.host) ? "Use a host name or IP address." : undefined,
    port: !(imap.port >= 1 && imap.port <= 65535) ? "Enter a port from 1 to 65535." : undefined,
    certificate: cert && !PEM.test(cert) ? "Paste a PEM certificate (BEGIN CERTIFICATE … END CERTIFICATE), never a private key." : undefined,
  };
  const smtpLogin = sameLogin ? login : smtpUsername || login;
  const sendingProblems = {
    host: !smtp.host ? "Enter the outgoing mail server." : !/^[a-zA-Z0-9.:-]+$/.test(smtp.host) ? "Use a host name or IP address." : undefined,
    port: !(smtp.port >= 1 && smtp.port <= 65535) ? "Enter a port from 1 to 65535." : undefined,
    password: (sameLogin ? !password : !smtpPassword) && !keeps(existing?.smtp, smtp, smtpLogin)
      ? (sameLogin ? "Enter the password on Account again: sending signs in to another server." : "Enter the password for sending.") : undefined,
  };
  const problems = [account, sendingProblems, {}, {}];
  const shown = (part: number) => (tried >= part ? problems[part]! : {}) as Record<string, string | undefined>;
  const firstProblem = (part: number) => Object.values(problems[part]!).find(Boolean);

  const save = async (): Promise<void | "stay"> => {
    const wrong = (outgoing ? [0, 1] : [0]).find((part) => firstProblem(part));
    if (wrong !== undefined) { setTried(3); setStep(wrong); return "stay" as const; }
    await api.saveMail(house, config(), existing?.id);
    await saved();
  };
  const next = async () => {
    setTried(Math.max(tried, step));
    if (firstProblem(step)) return "stay" as const;
    // Check each sign-in on its own step, by the fields it is about; not again for the same servers.
    if (step === 0) {
      const reading = { ...config(), sendPolicy: "disabled" as const, smtp: undefined, pets: [] };
      const key = JSON.stringify(reading.imap);
      if (checked !== key) { await api.testMail(house, reading, existing?.id); setChecked(key); }
      if (!smtp.host) setSmtp({ ...smtp, host: outgoingHost(imap.host) });
    }
    if (step === 1) {
      const both = { ...config(), smtp: smtpEndpoint(), sendPolicy: "approval" as const, pets: [] };
      const key = JSON.stringify([both.imap, both.smtp]);
      if (checked !== key) { await api.testMail(house, both, existing?.id); setChecked(key); }
      setOutgoing(true);
    }
    setStep(step + 1);
    return "stay" as const;
  };
  /** Sending set up again (after a skip, or on a saved mailbox): asking first, until the owner chooses otherwise. */
  const setUpSending = () => {
    if (!smtp.host) setSmtp({ ...smtp, host: outgoingHost(imap.host) });
    if (sendPolicy === "disabled") setSendPolicy("approval");
    setOutgoing(true);
  };

  const steps = existing
    ? <span className="segmented wide" role="group" aria-label="Settings">{STEPS.map((label, i) => <button key={label} type="button" aria-pressed={i === step} onClick={() => setStep(i)}>{label}</button>)}</span>
    : <ol className="steps" aria-label="Steps">{STEPS.map((label, i) => <li key={label} className={i === step ? "current" : i < step ? "done" : undefined} aria-current={i === step ? "step" : undefined}>{label}</li>)}</ol>;

  return <Dialog onClose={onClose} spec={{
    title: existing ? `Mail settings: ${existing.email}` : "Connect mail",
    wide: true,
    // A new step takes the focus; switching the parts of a saved one does not.
    step: existing ? "mail-settings" : `mail-${step}`,
    confirmLabel: existing ? "Save" : step < 3 ? "Next" : "Connect",
    busyLabel: existing || step === 3 ? "Checking the connection…" : step === 0 ? "Checking sign-in…" : step === 1 ? "Checking sending…" : "Working…",
    back: existing ? undefined : step ? () => setStep(step - 1) : back,
    skip: !existing && step === 1 ? { label: "Skip for now", onSkip: () => { setOutgoing(false); setStep(2); } } : undefined,
    onConfirm: existing || step === 3 ? save : next,
    children: <>
      {steps}
      {step === 0 && <>
        <FormGrid>
          <TextField label="Email address" value={email} onChange={changeEmail} placeholder="you@example.com" error={shown(0).email} />
          <TextField label="Name" value={title} onChange={setTitle} hint="What bots and this page call it." />
        </FormGrid>
        <FormGroup title="Incoming mail (IMAP)">
          <ServerFields kind="imap" server={imap} onChange={setImap} errors={shown(0)} />
          <FormGrid>
            <TextField label="Username" mono value={username} onChange={(v) => setUsername(v.trim())} placeholder={email.trim() || "you@example.com"} hint="Empty: the email address." />
            <TextField label="Password" type="password" value={password} onChange={setPassword} error={shown(0).password}
              hint={existing ? "Leave empty to keep the saved one." : "Many providers want an app password here."} />
          </FormGrid>
          <Fold summary="Trusted certificate" open={!!certificate.trim() || !!shown(0).certificate}>
            <Field id="mail-certificate" label="Certificate" hideLabel error={certificateFile.error ?? shown(0).certificate}
              hint={certificateFile.note ?? "Only for a server with its own certificate, such as a mail bridge on this computer. Paste the PEM certificate or choose its file, never the private key."}>
              <textarea id="mail-certificate" className="control mono" rows={3} spellCheck={false} value={certificate} onChange={(e) => { setCertificate(e.target.value); setCertificateFile({}); }} placeholder="-----BEGIN CERTIFICATE-----" />
            </Field>
            <Cluster gap={3}>
              <button type="button" className="btn small" onClick={() => certificatePicker.current?.click()}>Choose file…</button>
              {certificate.trim() && <button type="button" className="text-btn" onClick={() => { setCertificate(""); setCertificateFile({}); }}>Clear</button>}
              <input ref={certificatePicker} type="file" accept=".pem,.crt,.cer,application/x-pem-file" className="visually-hidden" tabIndex={-1} aria-hidden
                onChange={(e) => { void chooseCertificate(e.target.files?.[0]); e.target.value = ""; }} />
            </Cluster>
          </Fold>
        </FormGroup>
      </>}
      {step === 1 && <>
        {existing && !outgoing ? <>
          <p className="dialog-text">Sending isn't set up for {email.trim() || "this mailbox"}. Add its outgoing server to let them send.</p>
          <Cluster><button type="button" className="btn small" onClick={setUpSending}>Set up sending</button></Cluster>
        </> : <>
          {!existing && <p className="dialog-text">Add the outgoing server so bots can send from {email.trim() || "this address"}. Skip it, and bots can't send; you can set up sending later.</p>}
          <FormGroup title="Outgoing mail (SMTP)">
            <ServerFields kind="smtp" server={smtp} onChange={setSmtp} errors={shown(1)} />
            <SwitchList label="Sign-in" options={[{ value: "same", label: "Same sign-in as incoming mail", description: "Off: a username and password for sending only." }]} on={sameLogin ? ["same"] : []} onToggle={() => setSameLogin(!sameLogin)} />
            {!sameLogin && <FormGrid>
              <TextField label="Username" mono value={smtpUsername} onChange={(v) => setSmtpUsername(v.trim())} placeholder={login || "you@example.com"} />
              <TextField label="Password" type="password" value={smtpPassword} onChange={setSmtpPassword} hint={existing?.smtp ? "Leave empty to keep the saved one." : undefined} />
            </FormGrid>}
            {shown(1).password && <p className="error">{shown(1).password}</p>}
            <TextField label="Sender name" value={displayName} onChange={setDisplayName} placeholder="Your name"
              hint={`Recipients see: ${displayName.trim() ? `${displayName.trim()} <${email.trim()}>` : email.trim() || "the address alone"}.`} />
            <TextField label="Also save a copy to folder" value={sentFolder} onChange={setSentFolder} placeholder="Sent"
              hint="Leave empty if your server keeps sent mail itself, as most do. A failed copy never sends the email twice." />
          </FormGroup>
          {existing && <Cluster><button type="button" className="text-btn" onClick={() => setOutgoing(false)}>Remove sending</button></Cluster>}
        </>}
      </>}
      {step === 2 && <>
        <p className="dialog-text">Bots can always search and read {email.trim() || "this mailbox"}. Choose what else they may do.</p>
        <ChoiceList label="Access" value={sendPolicy} onChange={v => setSendPolicy(v as MailSendPolicy)} options={[...CONNECTOR_ACCESS_OPTIONS]} />
        <p className="hint">This applies to sending and mailbox changes: flags, moves, Trash, drafts and folders. Nothing is ever deleted for good.</p>
        {!outgoing && <p className="list-empty">Sending isn't set up. <button type="button" className="text-btn plain text-link" onClick={() => { setUpSending(); setStep(1); }}>Set up sending</button></p>}
        {allowManage && <FormGrid>
          <TextField label="Drafts folder" value={draftsFolder} onChange={setDraftsFolder} />
          <TextField label="Trash folder" value={trashFolder} onChange={setTrashFolder} />
        </FormGrid>}
      </>}
      {step === 3 && <>
        <p className="dialog-text">Which bots may use {email.trim() || "this mailbox"}?</p>
        <SwitchList label="Bot access" options={options} on={pets} onToggle={(name) => setPets(toggle(pets, name))} />
        <p className="hint">None: the mailbox stays private until you grant access. Sideworkers get their parent's; scouts never have any.</p>
        <p className="hint">Passwords stay on this computer and never reach your bots. What a bot reads goes to its AI provider and may show in its chat.</p>
      </>}
      {existing && waiting > 0 && <p className="hint danger">Saving cancels {waiting === 1 ? "the email" : `the ${waiting} emails`} waiting for your approval; bots will have to ask again.</p>}
    </>,
  }} />;
}
