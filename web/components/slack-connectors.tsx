import { useEffect, useState } from "react";
import { api, type SlackConnectionView, type WorkspaceView } from "../api";
import { SLACK_READ_SCOPES } from "../../src/core/slack-connectors";
import { Dialog, useDialog } from "./dialog";
import { FormGroup, SwitchList, TextField } from "./fields";
import { Cell, List, ListRow, Section } from "./layout";

export function SlackConnections({ house, adding, onClose, notify }: { house: WorkspaceView; adding: boolean; onClose: () => void; notify: (text: string, warning?: boolean) => void }) {
  const [connections, setConnections] = useState<SlackConnectionView[]>();
  const [error, setError] = useState("");
  const [access, setAccess] = useState<SlackConnectionView>();
  const [reconnect, setReconnect] = useState<SlackConnectionView>();
  const dialog = useDialog();
  const refresh = async () => {
    try { setConnections((await api.slackConnections(house.name)).connections); setError(""); }
    catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { setConnections(undefined); void refresh(); }, [house.name]);
  const options = house.pets.filter(p => !p.sideworker).map(p => ({ value: p.name, label: `${p.emoji ?? "🤖"} ${p.title}` }));
  return <>
    <Section title="Slack" hint="Read Slack on demand. Each connection belongs to this Household workspace and only its selected bots.">
      {error && <p className="error" role="alert">{error} <button className="text-btn plain" onClick={() => void refresh()}>Retry</button></p>}
      <List columns="minmax(0, 1fr) auto" empty={connections ? "No Slack accounts connected." : error ? undefined : "Loading…"}>
        {connections?.map(c => <ListRow key={c.id} actions={<>
          <button className="text-btn plain" onClick={() => setAccess(c)}>Bot access</button>
          <button className={c.needsReconnect ? "btn small" : "text-btn plain"} onClick={() => setReconnect(c)}>Reconnect</button>
          <button className="text-btn" onClick={() => dialog.open({ title: `Disconnect ${c.team}?`, body: "Selected bots lose access immediately. This removes the local token; revoke the app in Slack to remove its authorization there. Previously read messages stay in bot history.", confirmLabel: "Disconnect", danger: true, onConfirm: async () => { await api.disconnectSlack(house.name, c.id); await refresh(); notify("Slack disconnected"); } })}>Disconnect</button>
        </>}>
          <Cell><span className="avatar task connector-mark" aria-hidden>S</span><span className="cell-lines">
            <span className="strong">{c.team} · {c.user}</span>
            <span className="faint">Slack · {c.allowWrite ? "read and send" : "read only"} · {c.needsReconnect ? "Reconnect required" : "Connected"}</span>
            <span className="channel-company">{c.pets.length ? c.pets.map(name => <span className="chip small" key={name}>{house.pets.find(p => p.name === name)?.title ?? name}</span>) : <span className="faint">No bots yet: private until you grant access</span>}</span>
          </span></Cell>
        </ListRow>)}
      </List>
    </Section>
    {(adding || reconnect) && <SlackSetup key={reconnect?.id ?? house.name} house={house.name} existing={reconnect} options={options} onClose={() => { setReconnect(undefined); onClose(); }} saved={async () => { await refresh(); notify("Slack connected"); }} />}
    {access && <SlackAccess key={access.id} connection={access} options={options} onClose={() => setAccess(undefined)} save={async pets => { await api.shareSlack(house.name, access.id, pets); await refresh(); notify("Bot access saved"); }} />}
    {dialog.element}
  </>;
}
type Options = { value: string; label: string }[];
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];
function SlackSetup({ house, existing, options, onClose, saved }: { house: string; existing?: SlackConnectionView; options: Options; onClose: () => void; saved: () => Promise<void> }) {
  const [allowWrite, setAllowWrite] = useState(existing?.allowWrite ?? false);
  const [token, setToken] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [callback, setCallback] = useState("");
  const [manual, setManual] = useState(false);
  const [pets, setPets] = useState(existing?.pets ?? []);
  return <Dialog onClose={onClose} spec={{ title: existing ? `Reconnect ${existing.team}` : "Connect Slack", confirmLabel: manual || authorizeUrl ? "Connect Slack" : "Prepare Slack sign-in", busyLabel: "Connecting…", onConfirm: async () => { if (!manual) { if (!authorizeUrl) { const { url } = await api.authorizeSlack(house, pets, allowWrite); setAuthorizeUrl(url); return "stay"; } await api.completeSlack(house, callback); setCallback(""); await saved(); return; } await api.connectSlack(house, token, pets, allowWrite); setToken(""); await saved(); }, children: <>
    <p className="dialog-text">Share the conversations this Slack user can read. Read access is enabled by default. Optionally allow selected bots to send messages as this Slack user. This is separate from a Slack bot chat channel.</p>
    <button type="button" className="text-btn plain" onClick={() => { setManual(!manual); setAuthorizeUrl(""); setCallback(""); }}>{manual ? "Use Slack sign-in instead" : "Use an existing user token instead"}</button>
    {manual && <><TextField label="User OAuth Token" type="password" value={token} onChange={setToken} placeholder="xoxp-…" hint="Stored on this host, never sent to your bots. Use a dedicated Slack app with the scopes below." />
    <details className="field-help"><summary>Get a dedicated user token</summary><ol>
      <li>Open <a className="text-link" href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Slack apps ↗</a> and select your connector app in the workspace you want to read.</li>
      <li>Under OAuth &amp; Permissions → User Token Scopes, add the permissions below. Leave Bot Token Scopes empty. Add chat:write only if enabling message sending.</li>
      <li>Install or reinstall the app, approve access as your Slack user, and copy User OAuth Token. Keep token rotation off for this token-based connection.</li>
    </ol><p className="hint">{SLACK_READ_SCOPES.join(", ")}</p></details></>}
    {!manual && <p className="hint">Slack returns a one-time code through agents-household.dev. Its hosting provider receives that URL. Your private PKCE verifier and Slack tokens stay on your Household host.</p>}
    {!manual && authorizeUrl && <>
      <p className="dialog-text"><a className="text-link" href={authorizeUrl} target="_blank" rel="noreferrer">Open Slack sign-in ↗</a>. After approving access, copy the connection result from the Household website and paste it below. Keep this dashboard open.</p>
      <TextField label="Connection result" type="password" value={callback} onChange={setCallback} placeholder="Paste the connection result here" hint="Your Household server exchanges the code directly with Slack. Works on a VPS too. Complete within ten minutes." />
      <button type="button" className="text-btn plain" onClick={() => { setAuthorizeUrl(""); setCallback(""); }}>Start again / change bot access</button>
    </>}
    {!authorizeUrl && <SwitchList label="Message sending" options={[{ value: "send", label: "Allow sending messages" }]} on={allowWrite ? ["send"] : []} onToggle={() => setAllowWrite(!allowWrite)} />}
    {!authorizeUrl && <FormGroup title="Bot access"><SwitchList label="Slack bot access" options={options} on={pets} onToggle={p => setPets(toggle(pets, p))} /><p className="hint">Optional. Sideworkers inherit their parent's current access; scouts have none. What a bot reads goes to its AI provider and chat.</p></FormGroup>}
  </> }} />;
}
function SlackAccess({ connection, options, onClose, save }: { connection: SlackConnectionView; options: Options; onClose: () => void; save: (pets: string[]) => Promise<void> }) {
  const [pets, setPets] = useState(connection.pets);
  return <Dialog onClose={onClose} spec={{ title: `Bot access: ${connection.team}`, body: "Changes apply immediately, including sideworkers. Scouts have no access.", confirmLabel: "Save access", onConfirm: () => save(pets), children: <SwitchList label="Slack bot access" options={options} on={pets} onToggle={p => setPets(toggle(pets, p))} /> }} />;
}
