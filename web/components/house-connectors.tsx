import { useEffect, useState } from "react";
import { ArrowRight, Plus, Plug, Mail, Files, CalendarDays, Settings2 } from "lucide-react";
import { api, type GoogleConnectionView, type GoogleConnectorsView, type GoogleService, type HouseView } from "../api";
import { SwitchList } from "./fields";
import { Dialog } from "./dialog";
import { Page, Stack, Cluster } from "./layout";

/** Provider catalog: the house page and type picker are independent of a provider's setup form. */
export const CONNECTOR_TYPES = [{ id: "google", label: "Google", description: "Gmail, Drive and Calendar", detail: "Connect a Google account and choose what your pets can read.", mark: "G" }] as const;
type ConnectorType = typeof CONNECTOR_TYPES[number]["id"];
const SERVICES = [{ id: "gmail", label: "Gmail", description: "Search and read email", icon: Mail }, { id: "drive", label: "Drive", description: "Find files and read documents", icon: Files }, { id: "calendar", label: "Calendar", description: "Read calendars and events", icon: CalendarDays }] as const;
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];

export function HouseConnectors({ house, notify }: { house: HouseView; notify: (text: string, warning?: boolean) => void }) {
  const [view, setView] = useState<GoogleConnectorsView>();
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<ConnectorType>();
  const [editing, setEditing] = useState<GoogleConnectionView>();
  const refresh = async () => setView(await api.googleConnections(house.name));
  useEffect(() => { let live = true; api.googleConnections(house.name).then(v => { if (live) setView(v); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [house.name]);
  const add = () => { setType(undefined); setAdding(true); };
  const connections = view?.connections ?? [];
  return <Page title="Connectors" actions={<button className="btn primary" onClick={add}><Plus size={16} /> Add connector</button>}>
    <div className="connectors-page stack gap-5">
      <p className="hint">Accounts and services shared with this house. Add as many accounts as you need, with separate access for each.</p>
      {error && <p role="alert" className="error">{error} <button className="btn small" onClick={() => { setError(""); void refresh().catch(e => setError(e.message)); }}>Retry</button></p>}
      {!view && !error && <p className="hint">Loading connectors…</p>}
      {view && !connections.length && <div className="connectors-empty"><span className="connector-empty-icon"><Plug size={28} /></span><h2 className="h2">Bring your tools into the house</h2><p className="hint">Connect work and personal accounts separately.<br />Choose which pets can use each one.</p><button className="btn" onClick={add}><Plus size={16} /> Add your first connector</button><span className="hint">Available now: Google</span></div>}
      {!!connections.length && <div className="connector-grid">{connections.map(c => <ConnectorCard key={c.id} connection={c} house={house} onManage={() => setEditing(c)} />)}</div>}
      <details className="connector-help"><summary>How access works</summary><p className="hint">Each connector has its own pet access. Sideworkers inherit their parent's current access; scouts have none. Tokens stay on your host. Content a pet reads may go to its AI provider and chat history. Use providers and settings compatible with Google's Limited Use rules.</p><p className="hint"><a href="https://agents-household.dev/privacy/" target="_blank" rel="noreferrer">Privacy Policy</a> · <a href="https://agents-household.dev/terms/" target="_blank" rel="noreferrer">Terms of Service</a></p></details>
    </div>
    {adding && !type && <Dialog onClose={() => setAdding(false)} spec={{ title: "Add connector", body: "Choose a type. You can connect multiple accounts of the same type.", hideConfirm: true, confirmLabel: "Cancel", onConfirm: async () => setAdding(false), children: <div className="connector-types">{CONNECTOR_TYPES.map(provider => <button type="button" className="connector-type" key={provider.id} onClick={() => setType(provider.id)}><span className="connector-mark">{provider.mark}</span><span className="stack gap-1"><strong>{provider.label}</strong><span className="hint">{provider.description}</span></span><ArrowRight size={18} /></button>)}</div> }} />}
    {adding && type === "google" && <GoogleSetup house={house} ready={!!view?.ready} close={() => setAdding(false)} back={() => setType(undefined)} />}
    {editing && <GoogleManage key={editing.id} house={house} connection={connections.find(c => c.id === editing.id) ?? editing} close={() => setEditing(undefined)} refresh={refresh} notify={notify} />}
  </Page>;
}

export function ConnectorCard({ connection: c, house, onManage }: { connection: GoogleConnectionView; house: HouseView; onManage: () => void }) {
  const pets = house.pets.filter(p => c.pets.includes(p.name));
  return <section className="connector-card" aria-label={`Google: ${c.email}`}>
    <div className="connector-card-head"><span className="connector-mark">G</span><div className="connector-identity"><span className="hint">Google</span><h2 className="h3">{c.email}</h2></div><span className={`connector-status${c.needsReconnect ? " attention" : ""}`}>{c.needsReconnect ? "Reconnect" : "Connected"}</span></div>
    <Cluster gap={2}>{SERVICES.filter(s => c.services.includes(s.id)).map(s => <span className="connector-service" key={s.id}><s.icon size={14} />{s.label}</span>)}<span className="hint">Read only</span></Cluster>
    <div className="connector-card-foot"><div className="stack gap-1"><span className="hint">Pet access</span><span>{pets.length ? pets.map(p => p.title).join(", ") : "No pets have access"}</span></div><button className="btn small" onClick={onManage} aria-label={`Manage ${c.email}`}><Settings2 size={14} /> Manage</button></div>
  </section>;
}

function GoogleSetup({ house, ready, close, back, existing }: { house: HouseView; ready: boolean; close: () => void; back: () => void; existing?: GoogleConnectionView }) {
  const [services, setServices] = useState<GoogleService[]>(existing?.services ?? ["gmail", "drive", "calendar"]);
  const [pets, setPets] = useState<string[]>(existing?.pets ?? []);
  return <Dialog onClose={close} spec={{ title: existing ? `Reconnect ${existing.email}` : "Set up Google", back, confirmLabel: "Continue to Google", busyLabel: "Opening Google…", body: existing ? "Sign in to this account to update its connection." : "Choose services and access, then select your Google account. Other accounts in this house stay connected.", onConfirm: async () => {
    if (!ready) throw Error("Google is unavailable in this build. Configure the host's OAuth client or use an official release.");
    if (!services.length) throw Error("Select at least one service.");
    const result = await api.connectGoogle(house.name, services, pets);
    window.location.assign(result.url); return "stay";
  }, children: <Stack gap={4}>
    <div className="stack gap-2"><h3 className="h3">Services</h3><SwitchList label="Google services" options={SERVICES.map(s => ({ value: s.id, label: s.label, description: s.description }))} on={services} onToggle={id => setServices(toggle(services, id) as GoogleService[])} /></div>
    <div className="stack gap-2"><h3 className="h3">Pet access</h3><SwitchList label="Pet access" options={house.pets.filter(p => !p.sideworker).map(p => ({ value: p.name, label: p.title }))} on={pets} onToggle={id => setPets(toggle(pets, id))} /><p className="hint">Optional. You can grant access after connecting.</p></div>
    <p className="hint">Read only. Tokens stay on this host; content read by pets may be sent to their AI provider and chat. <a href="https://agents-household.dev/privacy/" target="_blank" rel="noreferrer">Privacy Policy</a></p>
    {!ready && <p className="error">Google is not configured on this host.</p>}
  </Stack> }} />;
}

function GoogleManage({ connection: c, house, close, refresh, notify }: { connection: GoogleConnectionView; house: HouseView; close: () => void; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const [pets, setPets] = useState(c.pets);
  const [mode, setMode] = useState<"access" | "reconnect" | "disconnect">("access");
  if (mode === "reconnect") return <GoogleSetup house={house} ready close={close} back={() => setMode("access")} existing={c} />;
  if (mode === "disconnect") return <Dialog onClose={close} spec={{ title: `Disconnect ${c.email}?`, body: "Removes this account's connection from this house. Other accounts stay connected. Existing history and backups remain.", confirmLabel: "Disconnect", danger: true, back: () => setMode("access"), onConfirm: async () => { await api.disconnectGoogle(house.name, c.id); await refresh(); notify("Account disconnected"); }, children: <p className="hint">To revoke access for all Household installations, use <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">Google Account connections</a>.</p> }} />;
  return <Dialog onClose={close} spec={{ title: c.email, body: `Google · ${c.services.map(s => SERVICES.find(v => v.id === s)?.label).join(", ")} · Read only`, confirmLabel: "Save access", onConfirm: async () => { await api.shareGoogle(house.name, c.id, pets); await refresh(); notify("Pet access saved"); }, children: <Stack gap={4}>
    {c.needsReconnect && <p className="error">This account needs to be reconnected.</p>}
    <SwitchList label="Pet access" options={house.pets.filter(p => !p.sideworker).map(p => ({ value: p.name, label: p.title }))} on={pets} onToggle={id => setPets(toggle(pets, id))} />
    <p className="hint">Sideworkers inherit access from their parent. Scouts have no access.</p>
    <Cluster><button type="button" className="btn small" onClick={() => setMode("reconnect")}>Change services / reconnect</button><button type="button" className="btn small danger" onClick={() => setMode("disconnect")}>Disconnect account</button></Cluster>
  </Stack> }} />;
}
