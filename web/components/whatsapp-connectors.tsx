import { CONNECTOR_ACCESS_OPTIONS, connectorAccessWords, type ConnectorWritePolicy } from "../../src/core/connector-write-policy";
import { useEffect, useRef, useState } from "react";
import { api, type WhatsAppConnectionView, type WhatsAppConnectorsView, type WhatsAppPollView } from "../api";
import { Dialog } from "./dialog";
import { ChoiceList, FormGroup, SwitchList, TextField } from "./fields";

export const whatsappAccessWords = (c: Pick<WhatsAppConnectionView, "writePolicy">) => connectorAccessWords(c.writePolicy);
/** «Connected», «Connecting…»: how the linked device is doing right now. */
export const whatsappLinkWords = (c: WhatsAppConnectionView) => c.needsReconnect ? "Pair again" : c.link === "online" ? "Connected" : c.link === "connecting" ? "Connecting…" : "Offline, retrying";
export function useWhatsAppConnections(house: string) {
  const [view, setView] = useState<WhatsAppConnectorsView>();
  const [error, setError] = useState("");
  const refresh = async () => { try { setView(await api.whatsappConnections(house)); setError(""); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { setView(undefined); void refresh(); }, [house]);
  // A device connecting, or history still syncing after a pairing, changes the list on its own.
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => clearInterval(timer);
  }, [house]);
  return { ...view, error, refresh };
}

const METHODS = [
  { value: "qr", label: "QR code", description: "Scan it with the phone: WhatsApp → Settings → Linked devices → Link a device." },
  { value: "code", label: "Phone number", description: "Get an 8-character code to type on the phone instead, when scanning is awkward." },
];
/** The name, access and bots of one account; used when adding it and in its settings. */
function Choices({ name, setName, access, setAccess, pets, setPets, options, placeholder }: {
  name: string; setName: (v: string) => void; access: ConnectorWritePolicy; setAccess: (v: ConnectorWritePolicy) => void;
  pets: string[]; setPets: (f: (v: string[]) => string[]) => void; options: { value: string; label: string }[]; placeholder: string;
}) {
  return <>
    <TextField label="Name" hint="Optional: how you and your bots tell this account apart, like Personal or Work." value={name} onChange={setName} placeholder={placeholder} maxLength={64} />
    <ChoiceList label="Access" value={access} onChange={v => setAccess(v as ConnectorWritePolicy)} options={[...CONNECTOR_ACCESS_OPTIONS]} />
    <FormGroup title="Bot access"><SwitchList label="Bot access" options={options} on={pets} onToggle={id => setPets(values => values.includes(id) ? values.filter(v => v !== id) : [...values, id])} />
      <p className="hint">Optional: with none, the account stays private until you grant access. Sideworkers get their parent's access; scouts never have any.</p>
    </FormGroup>
  </>;
}

/**
 * Pairing Household as a linked device: the owner's choices, then a QR code (or a pairing code) that the host keeps
 * fresh; the dialog asks for it every two seconds and closes once the phone approves.
 */
export function WhatsAppSetup({ house, existing, options, onClose, saved, back }: {
  house: string; existing?: WhatsAppConnectionView; options: { value: string; label: string }[];
  onClose: () => void; saved: () => Promise<void>; back?: () => void;
}) {
  const [name, setName] = useState(existing && existing.name !== existing.account && existing.name !== existing.phone ? existing.name : "");
  const [access, setAccess] = useState<ConnectorWritePolicy>(existing?.writePolicy ?? "disabled");
  const [pets, setPets] = useState(existing?.pets ?? []);
  const [method, setMethod] = useState<"qr" | "code">("qr");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [pairing, setPairing] = useState<string>();
  const [state, setState] = useState<WhatsAppPollView>();
  const [error, setError] = useState("");
  const current = useRef<string | undefined>(undefined);
  const callbacks = useRef({ saved, onClose }); callbacks.current = { saved, onClose };
  useEffect(() => () => { const id = current.current; current.current = undefined; if (id) void api.cancelWhatsApp(house, id).catch(() => {}); }, [house]);
  useEffect(() => {
    if (!pairing) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      let result: WhatsAppPollView;
      try { result = await api.pollWhatsApp(house, pairing); }
      catch (e) { if (!stopped) { current.current = undefined; setError((e as Error).message); } return; }
      if (stopped) return;
      setState(result);
      if (result.status === "connected") {
        current.current = undefined;
        try { await callbacks.current.saved(); } finally { if (!stopped) callbacks.current.onClose(); }
      } else if (result.status === "failed") { current.current = undefined; setError(result.error); }
      else timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [pairing, house]);
  const reset = () => {
    const id = current.current; current.current = undefined;
    setPairing(undefined); setState(undefined); setError("");
    if (id) void api.cancelWhatsApp(house, id).catch(() => {});
  };
  const pending = state?.status === "pending" ? state : undefined;
  return <Dialog onClose={onClose} spec={{
    title: existing ? `Pair ${existing.name} again` : "Connect WhatsApp",
    step: pairing ? "whatsapp-pair" : "whatsapp-choices",
    confirmLabel: pairing ? "Start again" : method === "code" ? "Get pairing code" : "Show QR code",
    busyLabel: "Starting…", back: pairing ? reset : back,
    onConfirm: async () => {
      if (pairing) { reset(); return "stay"; }
      if (method === "code" && !/^\+?[\d\s()-]{6,24}$/.test(phone.trim())) throw new Error("Enter the phone number with its country code, like +34600111222.");
      const result = await api.pairWhatsApp(house, { pets, writePolicy: access, ...(name.trim() ? { name: name.trim() } : {}), ...(method === "code" ? { phone: phone.trim() } : {}), ...(existing ? { connection: existing.id } : {}) });
      current.current = result.id; setError(""); setState(undefined); setPairing(result.id);
      return "stay";
    },
    children: pairing ? <>
      {pending?.code ? <>
        <p className="dialog-text">On the phone: WhatsApp → Settings → Linked devices → Link a device → <b>Link with phone number instead</b>, and type this code.</p>
        <FormGroup title="Pairing code"><p className="microsoft-signin-code">{pending.code.length === 8 ? `${pending.code.slice(0, 4)}-${pending.code.slice(4)}` : pending.code}</p></FormGroup>
      </> : pending?.qr ? <>
        <p className="dialog-text">On the phone: WhatsApp → Settings → Linked devices → Link a device, and scan this code. It renews itself; keep this dialog open.</p>
        <img className="whatsapp-qr" src={pending.qr} alt="WhatsApp pairing QR code" width={264} height={264} />
      </> : !error && <p className="hint" role="status">Connecting to WhatsApp…</p>}
      {error ? <p className="error" role="alert">{error}</p>
        : pending && (pending.qr || pending.code) && <p className="hint" role="status">Waiting for the phone… Expires at {new Date(pending.expiresAt).toLocaleTimeString()}.</p>}
      {state?.status === "connected" && <p className="hint" role="status">Connected. Loading recent chats…</p>}
    </> : <>
      <p className="dialog-text">{existing ? "Link this account again: it keeps its history. These choices replace its name, access and bots." : "Household joins your WhatsApp as a linked device, like WhatsApp Web, and keeps what it sees from then on (plus the recent history WhatsApp shares when linking). Add more numbers the same way."}</p>
      <Choices name={name} setName={setName} access={access} setAccess={setAccess} pets={pets} setPets={setPets} options={options} placeholder={existing?.account ?? "Personal"} />
      <ChoiceList label="Pair with" value={method} onChange={v => setMethod(v as "qr" | "code")} options={METHODS} />
      {method === "code" && <TextField label="Phone number" hint="With its country code." value={phone} onChange={setPhone} placeholder="+34600111222" />}
      <p className="hint">Keys and history stay on this computer; what a bot reads goes to its AI provider and chat. This is not an official WhatsApp app: keep sending to what people asked for, as WhatsApp may block numbers that send like robots.</p>
    </>,
  }} />;
}

/** An account's name, access and bots; changes apply at once and cancel sends waiting for approval. */
export function WhatsAppSettings({ house, connection: c, options, onClose, saved }: { house: string; connection: WhatsAppConnectionView; options: { value: string; label: string }[]; onClose: () => void; saved: () => Promise<void> }) {
  const [name, setName] = useState(c.name !== c.account && c.name !== c.phone ? c.name : "");
  const [access, setAccess] = useState<ConnectorWritePolicy>(c.writePolicy);
  const [pets, setPets] = useState(c.pets);
  return <Dialog onClose={onClose} spec={{
    title: `Settings: ${c.name}`,
    body: `${c.phone}${c.account && c.account !== c.name ? ` (${c.account})` : ""}. ${c.chats} chats and ${c.messages} messages kept. Changes apply right away and cancel messages waiting for your approval.`,
    confirmLabel: "Save", busyLabel: "Saving…",
    onConfirm: async () => { await api.saveWhatsApp(house, c.id, { name: name.trim() || (c.account ?? c.phone), pets, writePolicy: access }); await saved(); },
    children: <Choices name={name} setName={setName} access={access} setAccess={setAccess} pets={pets} setPets={setPets} options={options} placeholder={c.account ?? c.phone} />,
  }} />;
}
