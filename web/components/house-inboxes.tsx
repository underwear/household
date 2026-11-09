import { useEffect, useState } from "react";
import { api, type HouseInbox, type InboxView, type HouseView } from "../api";
import { Dialog, useDialog } from "./dialog";
import { CheckList, ChoiceList, Field, SelectField, TextField } from "./fields";
import { Page, Panel, Stack } from "./layout";
import { written } from "./section";

const sources = [
  { value: "telegram-bot", label: "Telegram Bot Updates", description: "Receive updates from a dedicated bot. Never sends or edits messages." },
  { value: "rss", label: "RSS / Atom", description: "New entries from a feed. Articles, releases and changelogs." },
  { value: "health", label: "Health check", description: "Endpoint failures and recovery, without repeated alerts." },
  { value: "json-watch", label: "JSON watcher", description: "Changes to selected fields or the entire JSON response." },
  { value: "imap", label: "IMAP", description: "New emails in a folder. Leaves messages unread." },
  { value: "pop3", label: "POP3", description: "New emails by stable message ID. Never deletes mail." },
  { value: "grafana", label: "Grafana", description: "Alertmanager alerts and changes in their state." },
  { value: "datadog", label: "Datadog", description: "State changes for a selected monitor." },
  { value: "http", label: "Custom HTTP", description: "Your endpoint, your headers. A small JSON contract." },
];
const stamp = (value?: string) => value ? new Date(value).toLocaleString() : "Not checked yet";
export function HouseInboxesPage({ house, notify }: { house: HouseView; notify: (message: string, warning?: boolean) => void }) {
  const [items, setItems] = useState<InboxView[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<HouseInbox | "new">();
  const [busy, setBusy] = useState<string>();
  const dialog = useDialog();
  const refresh = async () => { const result = await api.inboxes(house.name); setItems(result); setLoaded(true); setError(""); };
  useEffect(() => {
    let alive = true;
    const load = () => api.inboxes(house.name).then(result => { if (alive) { setItems(result); setLoaded(true); setError(""); } }).catch(e => { if (alive) setError(e.message); });
    void load(); const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [house.name]);
  const action = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    try { await work(); await refresh(); } catch (e) { notify((e as Error).message, true); } finally { setBusy(undefined); }
  };
  return <Page title="Inboxes" actions={<button className="btn primary" onClick={() => setEditing("new")}>+ Add inbox</button>}>
    <p className="hint">Feeds, changes and alerts, delivered to subscribed pets with an optional channel announcement. Pollers run on this host; credentials never enter a VM.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!loaded && !error && <p className="hint">Loading inboxes…</p>}
    {loaded && !items.length && <Panel><Stack gap={4}>
      <strong>A home for incoming work</strong>
      <p className="hint">Connect a mailbox, an alert source or your own endpoint. New events appear in a channel and wake subscribed pets when they are idle.</p>
      <p className="hint">Choose every minute, 5 minutes, 15 minutes, or your own interval. Existing mail is skipped by default.</p>
    </Stack></Panel>}
    {items.map(({ inbox, status }) => <Panel key={inbox.name}>
      <div className="inbox-card-head">
        <div><strong>{inbox.title}</strong><p className="hint">{sources.find(s => s.value === inbox.source.kind)?.label} · Every {inbox.intervalSeconds / 60} min · {house.channels.find(c => c.chat === inbox.channel)?.name ?? "Channel removed"}</p></div>
        <span className={status.error && inbox.enabled ? "error" : "hint"}>{!inbox.enabled ? "Paused" : status.running ? "Checking…" : status.error ? "Needs attention" : status.initialized ? "Watching" : "Waiting for first check"}</span>
      </div>
      <p className="hint">Delivery: {inbox.delivery === "silent" ? "Silent — pets only" : "House announcement"}</p>
      <p className="hint">Subscribers: {inbox.pets.map(name => house.pets.find(p => p.name === name)?.display ?? name).join(", ") || "None — post to channel only"}</p>
      <p className="hint">Last checked: {stamp(status.lastCheck)} · {status.pendingCount} pending</p>
      {inbox.enabled && <p className="hint">Next check: {status.nextCheck ? stamp(new Date(status.nextCheck).toISOString()) : "Soon"}</p>}
      {status.error && <div className="error" role="status">
        <strong>{status.failures >= 3 ? "Poller needs attention" : "Check failed"} · {status.failures} consecutive {status.failures === 1 ? "failure" : "failures"}</strong>
        <p>{status.error}</p>
        <p className="hint">Since {stamp(status.problemSince)} · Last successful poll: {stamp(status.lastSuccess)}. Automatic retries continue.{status.failures >= 3 ? " Subscribed pets are notified once per outage and again on recovery." : " Pets are notified after 3 consecutive failures."}</p>
      </div>}
      <div className="inbox-actions">
        <button className="btn small" disabled={busy === inbox.name || status.running || !inbox.enabled} onClick={() => void action(inbox.name, async () => { const result = await api.pollInbox(house.name, inbox.name); notify(result.status.error ?? "Inbox checked", !!result.status.error); })}>Check now</button>
        <button className="btn small" disabled={busy === inbox.name} onClick={() => setEditing(inbox)}>Edit</button>
        <button className="btn small" disabled={busy === inbox.name} onClick={() => void action(inbox.name, () => written(api.updateInbox(house.name, { ...inbox, enabled: !inbox.enabled })))}>{inbox.enabled ? "Pause" : "Resume"}</button>
        <button className="btn small" disabled={busy === inbox.name} onClick={() => dialog.open({
          title: `Remove ${inbox.title}?`, body: "Stops polling and discards pending events. Messages already posted in your channel stay there.", confirmLabel: "Remove", danger: true,
          onConfirm: async () => { await written(api.removeInbox(house.name, inbox.name)); await refresh(); },
        })}>Remove</button>
      </div>
      {!!status.recent.length && <details className="inbox-recent"><summary>Recent events · {status.recent.length}</summary>
        <ul>{status.recent.map(event => <li key={event.id}><span>{event.title}</span><small className="hint">{stamp(event.at)} · {event.status === "delivered" ? "Delivered" : "Pending delivery"}</small></li>)}</ul>
      </details>}
    </Panel>)}
    <p className="hint"><a href="https://agents-household.dev/docs/inboxes/" target="_blank" rel="noreferrer">Poller setup and HTTP contract ↗</a></p>
    {editing && <InboxEditor key={editing === "new" ? "new" : editing.name} house={house} inbox={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} save={async inbox => { await written(editing === "new" ? api.addInbox(house.name, inbox) : api.updateInbox(house.name, inbox)); await refresh(); notify("Inbox saved"); }} />}
    {dialog.element}
  </Page>;
}

function InboxEditor({ house, inbox, onClose, save }: { house: HouseView; inbox?: HouseInbox; onClose: () => void; save: (inbox: HouseInbox) => Promise<void> }) {
  const [step, setStep] = useState(inbox ? 2 : 0);
  const [kind, setKind] = useState<HouseInbox["source"]["kind"]>(inbox?.source.kind ?? "imap");
  const source = inbox?.source;
  const [botToken, setBotToken] = useState(source?.kind === "telegram-bot" ? source.token : "");
  const [title, setTitle] = useState(inbox?.title ?? "");
  const [url, setUrl] = useState(source && "url" in source ? source.url : "");
  const [host, setHost] = useState(source && "host" in source ? source.host : "");
  const [port, setPort] = useState(source && "port" in source ? String(source.port) : "");
  const [username, setUsername] = useState(source && "username" in source ? source.username : "");
  const [password, setPassword] = useState(source && "password" in source ? source.password : "");
  const [mailbox, setMailbox] = useState(source?.kind === "imap" ? source.mailbox : "INBOX");
  const [monitor, setMonitor] = useState(source?.kind === "datadog" ? source.monitor : "");
  const [delivery, setDelivery] = useState<HouseInbox["delivery"]>(inbox?.delivery ?? "announce");
  const [watchMode, setWatchMode] = useState(source?.kind === "json-watch" && source.pointers.length ? "fields" : "whole");
  const [pointers, setPointers] = useState(source?.kind === "json-watch" ? source.pointers.join("\n") : "");
  const [timeout, setTimeout] = useState(String(source?.kind === "health" ? source.timeoutMs / 1000 : 10));
  const [failures, setFailures] = useState(String(source?.kind === "health" ? source.failures : 3));
  const [expectedStatus, setExpectedStatus] = useState(String(source?.kind === "health" ? source.expectedStatus : 200));
  const [headers, setHeaders] = useState<[string, string][]>(source && "headers" in source ? Object.entries(source.headers) : []);
  const [channel, setChannel] = useState(inbox?.channel ?? house.channels[0]?.chat ?? "");
  const [pets, setPets] = useState(inbox?.pets ?? []);
  const minutes = (inbox?.intervalSeconds ?? 300) / 60;
  const [frequency, setFrequency] = useState([1, 5, 15].includes(minutes) ? String(minutes) : "custom");
  const [custom, setCustom] = useState(String(minutes));
  const [initial, setInitial] = useState<HouseInbox["initial"]>(inbox?.initial ?? "new");
  const [tested, setTested] = useState("");
  const selected = house.channels.find(c => c.chat === channel);
  const mail = kind === "imap" || kind === "pop3";
  const requestHeaders = () => Object.fromEntries(headers.filter(([key]) => key.trim()).map(([key, value]) => [key.trim(), value]));
  const fields = (): HouseInbox => ({
    name: inbox?.name ?? (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35).replace(/^[^a-z]+/, "") || "inbox") + "-" + suffix,
    title: title.trim() || sources.find(s => s.value === kind)!.label,
    enabled: inbox?.enabled ?? true, intervalSeconds: Number(frequency === "custom" ? custom : frequency) * 60,
    channel: channel || "preview", pets, initial, delivery,
    source: kind === "telegram-bot" ? { kind, token: botToken.trim() } : kind === "imap" ? { kind, host: host.trim(), port: Number(port || 993), username, password, mailbox } :
      kind === "pop3" ? { kind, host: host.trim(), port: Number(port || 995), username, password } :
      kind === "health" ? { kind, url: url.trim(), headers: requestHeaders(), timeoutMs: Number(timeout) * 1000, failures: Number(failures), expectedStatus: Number(expectedStatus) } :
      kind === "json-watch" ? { kind, url: url.trim(), headers: requestHeaders(), pointers: watchMode === "fields" ? pointers.split("\n").map(p => p.trim()).filter(Boolean) : [] } :
      kind === "datadog" ? { kind, url: url.trim(), headers: Object.fromEntries(headers.filter(([key]) => key.trim()).map(([key, value]) => [key.trim(), value])), monitor } :
      { kind, url: url.trim(), headers: Object.fromEntries(headers.filter(([key]) => key.trim()).map(([key, value]) => [key.trim(), value])) },
  });
  const [suffix] = useState(() => crypto.randomUUID().slice(0, 6));
  return <Dialog onClose={onClose} spec={{
    title: inbox ? "Edit inbox" : "Add inbox", wide: true, step: `inbox-${step}`,
    confirmLabel: step === 0 ? "Continue" : step === 1 ? "Test connection & continue" : "Save inbox",
    busyLabel: step === 1 ? "Testing connection…" : "Saving…",
    back: step > (inbox ? 1 : 0) ? () => setStep(step - 1) : undefined,
    onConfirm: async () => {
      if (step === 0) { setStep(1); return "stay"; }
      if (step === 1) { if (kind === "json-watch" && watchMode === "fields" && !pointers.trim()) throw new Error("Add at least one field path."); const check = await api.testInbox(house.name, { ...fields(), pets: [], delivery: "announce" }); setTested(check.message); setStep(2); return "stay"; }
      if (delivery === "silent" && !pets.length) throw new Error("Subscribe at least one pet for silent delivery.");
      if (!channel) throw new Error("Add a channel to this house first.");
      if (!Number.isFinite(fields().intervalSeconds) || fields().intervalSeconds < 60 || fields().intervalSeconds > 86400 || !Number.isInteger(fields().intervalSeconds)) throw new Error("Choose an interval from 1 to 1,440 minutes (whole seconds).");
      await save(fields());
    },
    children: <>
      <ol className="slack-steps" aria-label="Inbox setup steps">{["Source", "Connection", "Delivery"].map((label, i) => <li key={label} aria-current={step === i ? "step" : undefined}><span>{i < step ? "✓" : i + 1}</span>{label}</li>)}</ol>
      {step === 0 && <ChoiceList label="What should this inbox watch?" value={kind} onChange={value => { setKind(value as typeof kind); setPort(""); setHeaders(value === "datadog" ? [["DD-API-KEY", ""], ["DD-APPLICATION-KEY", ""]] : value === "grafana" ? [["Authorization", "Bearer "]] : []); }} options={sources} />}
      {step === 1 && <>
        <p className="hint">{kind === "telegram-bot" ? "Incoming updates only. The bot token stays on the host and never enters a pet VM." : mail ? "Read-only access over verified TLS. Use an app password if your provider requires one. OAuth-only mailboxes are not supported yet." : "Requests run on the host. Put credentials in headers; redirects are refused."}</p>
        {kind === "telegram-bot" ? <>
          <TextField label="Bot token" type="password" value={botToken} onChange={setBotToken} placeholder="123456789:…" hint="Use a dedicated bot token from BotFather, not your Household channel bot." />
          <p className="hint">Telegram has one update queue per bot. Polling acknowledges received updates; do not run another consumer on this token. Existing webhooks are refused and never removed.</p>
          <p className="hint">Connection testing only checks bot identity and webhook status. It does not read or acknowledge updates. Telegram retains pending updates for up to 24 hours.</p>
        </> : mail ? <>
          <TextField label="Mail server" value={host} onChange={setHost} placeholder="imap.example.com" />
          <TextField label="TLS port" value={port} onChange={setPort} inputMode="numeric" placeholder={kind === "imap" ? "993" : "995"} />
          <TextField label="Username" value={username} onChange={setUsername} placeholder="you@example.com" />
          <TextField label="Password / app password" type="password" value={password} onChange={setPassword} />
          {kind === "imap" && <TextField label="Folder" value={mailbox} onChange={setMailbox} placeholder="INBOX" />}
        </> : <>
          <TextField label={kind === "grafana" ? "Grafana base URL" : kind === "datadog" ? "Datadog API base URL" : kind === "rss" ? "Feed URL" : "Endpoint URL"} value={url} onChange={setUrl} placeholder={kind === "grafana" ? "https://grafana.example.com" : kind === "datadog" ? "https://api.datadoghq.eu" : "https://example.com/inbox"}
            hint={kind === "http" ? "GET with cursor and limit=50. Returns version: 1, items and optional nextCursor." : kind === "datadog" ? "Use your Datadog region. Supply DD-API-KEY and DD-APPLICATION-KEY below." : kind === "grafana" ? "Supply Authorization: Bearer <service-account-token> below." : kind === "rss" ? "RSS 2.0, RSS 1.0 or Atom. Only new entries are delivered." : "GET request. No custom response contract required."} />
          {kind === "datadog" && <TextField label="Monitor ID" value={monitor} onChange={setMonitor} inputMode="numeric" placeholder="123456" />}
          {kind === "health" && <>
            <TextField label="Expected HTTP status" inputMode="numeric" value={expectedStatus} onChange={setExpectedStatus} />
            <TextField label="Timeout in seconds" inputMode="text" value={timeout} onChange={setTimeout} hint="0.1–60 seconds. A timeout counts as a failed check." />
            <TextField label="Consecutive failures before alert" inputMode="numeric" value={failures} onChange={setFailures} hint="1–10 checks. Recovery is delivered after the first successful check." />
          </>}
          {kind === "json-watch" && <>
            <SelectField label="Watch for changes in" value={watchMode} onChange={setWatchMode} options={[{value: "whole", label: "Entire JSON response"}, {value: "fields", label: "Selected fields"}]} />
            {watchMode === "fields" && <Field id="inbox-pointers" label="Field paths — one per line" hint="JSON Pointer paths, e.g. /items/0/price. Escape / as ~1 and ~ as ~0."><textarea id="inbox-pointers" aria-describedby="inbox-pointers-hint" className="control mono inbox-pointers" value={pointers} onChange={e => setPointers(e.target.value)} placeholder={"/price\n/status"} rows={3} /></Field>}
            <p className="hint">Object key order and whitespace are ignored. Array order matters. Events contain changed fields or a preview of the whole response.</p>
          </>}
          <div className="inbox-headers"><span className="field-label">Request headers</span>
            {headers.map(([key, value], i) => <div className="inbox-header-row" key={i}>
              <TextField label={`Header ${i + 1} name`} value={key} onChange={v => setHeaders(headers.map((h, n) => n === i ? [v, h[1]] : h))} placeholder="Authorization" />
              <TextField label={`Header ${i + 1} value`} type="password" value={value} onChange={v => setHeaders(headers.map((h, n) => n === i ? [h[0], v] : h))} placeholder="Bearer …" />
              <button className="btn small" type="button" aria-label={`Remove header ${i + 1}`} onClick={() => setHeaders(headers.filter((_, n) => n !== i))}>×</button>
            </div>)}
            <button className="btn small" type="button" onClick={() => setHeaders([...headers, ["", ""]])} disabled={headers.length >= 20}>+ Add header</button>
          </div>
        </>}
        <p className="hint">Testing does not post messages, notify pets or change the polling cursor.</p>
      </>}
      {step === 2 && <>
        {tested && <p className="hint" role="status">✓ {tested}</p>}
        <TextField label="Inbox name" value={title} onChange={setTitle} placeholder={sources.find(s => s.value === kind)?.label} />
        <SelectField label="Check for new events" value={frequency} onChange={setFrequency} options={[{ value: "1", label: "Every minute" }, { value: "5", label: "Every 5 minutes" }, { value: "15", label: "Every 15 minutes" }, { value: "custom", label: "Custom interval…" }]} />
        {frequency === "custom" && <TextField label="Interval in minutes" inputMode="numeric" value={custom} onChange={setCustom} hint="From 1 minute to 24 hours." />}
        <ChoiceList label="Delivery" value={delivery} onChange={v => setDelivery(v as typeof delivery)} options={[
          { value: "announce", label: "Announce in channel", description: "House posts the event and delivers it to subscribed pets." },
          { value: "silent", label: "Silent — pets only", description: "No House post. Pets receive the event privately and may still reply in the selected channel." },
        ]} />
        <SelectField label={delivery === "silent" ? "Channel for pet replies" : "Post events to"} value={channel} onChange={v => { setChannel(v); setPets([]); }} options={[{ value: "", label: "Choose a channel…", disabled: true }, ...house.channels.map(c => ({ value: c.chat, label: c.name }))]} />
        <CheckList label="Subscribe pets" checked={pets} onToggle={name => setPets(pets.includes(name) ? pets.filter(p => p !== name) : [...pets, name])}
          options={house.pets.filter(p => !p.sideworker && selected?.pets.includes(p.name)).map(p => ({ value: p.name, label: p.display }))}
          empty="Place pets in the selected channel first, or leave this as a channel-only feed." />
        <p className="hint">{delivery === "silent" ? "At least one subscriber is required. No House notification." : "One House post per event."} Each subscriber receives a separate copy when idle and replies in this channel. External content is never treated as an owner instruction.</p>
        {!inbox && <SelectField label="On first connection" value={initial} onChange={v => setInitial(v as typeof initial)} options={[{ value: "new", label: "Start from now — skip existing events" }, { value: "latest", label: "Deliver current items / snapshot (up to 50 per check)" }]} />}
        <button className="btn small" type="button" onClick={() => setStep(1)}>Change source connection</button>
      </>}
    </>,
  }} />;
}
