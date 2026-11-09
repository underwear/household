import { useEffect, useState } from "react";
import { api, type GoogleConnectionView, type GoogleConnectorsView, type GoogleService, type HouseView } from "../api";
import { SwitchList } from "./fields";
import { Page, Section, Stack, Cluster } from "./layout";

const SERVICES: { id: GoogleService; label: string }[] = [{ id: "gmail", label: "Gmail — search and read mail" }, { id: "drive", label: "Drive — find files and read document text" }, { id: "calendar", label: "Calendar — read calendars and events" }];
const toggle = (values: string[], value: string, enabled: boolean) => enabled ? [...new Set([...values, value])] : values.filter(v => v !== value);

export function HouseConnectors({ house, notify }: { house: HouseView; notify: (text: string, warning?: boolean) => void }) {
  const [view, setView] = useState<GoogleConnectorsView>();
  const [error, setError] = useState("");
  const [services, setServices] = useState<GoogleService[]>(["gmail", "drive", "calendar"]);
  const [pets, setPets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const refresh = async () => { const next = await api.googleConnections(house.name); setView(next); };
  useEffect(() => { let live = true; api.googleConnections(house.name).then(v => { if (live) setView(v); }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, [house.name]);
  const connect = async (selectedServices: GoogleService[], selectedPets: string[]) => {
    setBusy(true); setError("");
    try {
      const result = await api.connectGoogle(house.name, selectedServices, selectedPets);
      // Same tab keeps the authenticated dashboard session for the loopback callback.
      window.location.assign(result.url);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <Page title="Connectors">
    <Section title="Google" width="narrow">
      <Stack gap={4}>
        <p className="hint">Connect an account to this house, then choose which pets may read it. Sideworkers inherit their parent's current access. Scouts have no access.</p>
        <p className="hint">Tokens stay on your Household host. Data read by a pet is sent to its configured AI provider and may appear in its chat and history. For Google data, use a provider and settings that do not train general-purpose models on it.</p>
        <p className="hint"><a href="https://agents-household.dev/privacy/" target="_blank" rel="noreferrer">Privacy Policy</a> · <a href="https://agents-household.dev/terms/" target="_blank" rel="noreferrer">Terms of Service</a></p>
        {error && <p role="alert" className="field-error">{error}</p>}
        {!view && !error && <p className="hint">Loading connections…</p>}
        {view && !view.ready && <p role="status">This build has no Google OAuth client configured. Use an official build with Google support, or configure HOUSEHOLD_GOOGLE_CLIENT_ID and HOUSEHOLD_GOOGLE_CLIENT_SECRET on the host.</p>}
        {view?.connections.map(c => <Connection key={c.id} connection={c} house={house} busy={busy} reconnect={() => connect(c.services, c.pets)} refresh={refresh} notify={notify} />)}
        {!!view?.connections.length && !adding && <Cluster><button className="btn" disabled={!view.ready} onClick={() => setAdding(true)}>Connect another account</button></Cluster>}
        {(!view?.connections.length || adding) && <Stack gap={4}>
          <h3 className="h3">Connect an account</h3>
          <SwitchList label="Services to connect" disabled={busy || !view?.ready} options={SERVICES.map(s => ({ value: s.id, label: s.label }))} on={services} onToggle={id => setServices(toggle(services, id, !services.includes(id as GoogleService)) as GoogleService[])} />
          <h3 className="h3">Pets with access</h3>
          <SwitchList label="Pets with access" disabled={busy || !view?.ready} options={house.pets.filter(p => !p.sideworker).map(p => ({ value: p.name, label: p.title }))} on={pets} onToggle={id => setPets(toggle(pets, id, !pets.includes(id)))} />
          <p className="hint">No pets selected means the account stays private until you grant access here.</p>
          <Cluster><button className="btn primary" disabled={busy || !view?.ready || !services.length} onClick={() => void connect(services, pets)}>{busy ? "Opening Google…" : "Connect Google"}</button>{adding && <button className="btn" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>}</Cluster>
        </Stack>}
        <p className="hint">Google opens in your browser and asks for the selected permissions. To change an existing account's services, connect it again. On a remote host, forward the dashboard port to the same local port before connecting.</p>
      </Stack>
    </Section>
  </Page>;
}

function Connection({ connection: c, house, busy, reconnect, refresh, notify }: { connection: GoogleConnectionView; house: HouseView; busy: boolean; reconnect: () => Promise<void>; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = async (action: () => Promise<unknown>, message: string) => {
    setSaving(true);
    try { await action(); await refresh(); notify(message); } catch (e) { notify((e as Error).message, true); } finally { setSaving(false); }
  };
  return <section className="panel stack gap-3" aria-label={c.email}>
    <h3 className="h3">{c.email}</h3><p className="hint">{c.services.join(" · ")} · Read only{c.needsReconnect ? " · Reconnect required" : ""}</p>
    <SwitchList label="Pets allowed to use this account" disabled={saving || busy} options={house.pets.filter(p => !p.sideworker).map(p => ({ value: p.name, label: p.title }))} on={c.pets} onToggle={id => void run(() => api.shareGoogle(house.name, c.id, toggle(c.pets, id, !c.pets.includes(id))), "Google access updated")} />
    <Cluster><button className="btn small" disabled={saving || busy} onClick={() => void reconnect()}>Reconnect</button><button className="btn small" disabled={saving || busy} onClick={() => setConfirm(!confirm)}>Disconnect</button></Cluster>
    {confirm && <Stack gap={2}><p className="hint">Remove this connection and its tokens from this house? Existing chat history and backups remain. To revoke all Household installations' access, use <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">Google Account connections</a>.</p><Cluster><button className="btn danger" disabled={saving || busy} onClick={() => void run(() => api.disconnectGoogle(house.name, c.id), "Google account disconnected")}>Disconnect from this house</button><button className="btn" onClick={() => setConfirm(false)}>Cancel</button></Cluster></Stack>}
  </section>;
}
