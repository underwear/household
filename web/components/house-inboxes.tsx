import { useEffect, useState, type ReactNode } from "react";
import { Activity, BellOff, Braces, Check, Dog, HeartPulse, Mail, Rss, Send, Webhook, X, type LucideIcon } from "lucide-react";
import { api, type HouseInbox, type InboxView, type HouseView, type PetView } from "../api";
import { Dialog, useDialog } from "./dialog";
import { ChoiceList, Field, SelectField, Switch, TextField } from "./fields";
import { Cell, FormGrid, List, ListRow, Page, Section } from "./layout";
import { Link } from "./link";
import { relative } from "./pet-crons";
import { written } from "./section";
import { housePath, petPath } from "../router";

type Kind = HouseInbox["source"]["kind"];

/** What an inbox can watch: the first step of its form, and its mark and name in the lists. */
export const SOURCES: { value: Kind; label: string; description: string; icon: LucideIcon }[] = [
  { value: "imap", label: "IMAP", description: "New emails in a folder. Leaves messages unread.", icon: Mail },
  { value: "pop3", label: "POP3", description: "New emails by stable message ID. Never deletes mail.", icon: Mail },
  { value: "rss", label: "RSS / Atom", description: "New entries from a feed: articles, releases, changelogs.", icon: Rss },
  { value: "health", label: "Health check", description: "Endpoint failures and recovery, without repeated alerts.", icon: HeartPulse },
  { value: "json-watch", label: "JSON watcher", description: "Changes to selected fields or the whole JSON response.", icon: Braces },
  { value: "grafana", label: "Grafana", description: "Alertmanager alerts and changes in their state.", icon: Activity },
  { value: "datadog", label: "Datadog", description: "State changes of one monitor.", icon: Dog },
  { value: "telegram-bot", label: "Telegram Bot Updates", description: "Updates a dedicated bot receives. Never sends or edits messages.", icon: Send },
  { value: "http", label: "Custom HTTP", description: "Your endpoint, your headers, a small JSON contract.", icon: Webhook },
];
const sourceOf = (kind: Kind) => SOURCES.find((source) => source.value === kind) ?? SOURCES.at(-1)!;
const DOCS = "https://agents-household.dev/docs/inboxes/";

/** «every minute», «every 5 min», «every 2 h», «daily». */
export function everyWords(seconds: number): string {
  const minutes = seconds / 60;
  if (minutes === 1) return "every minute";
  if (minutes === 1440) return "daily";
  if (minutes >= 60 && minutes % 60 === 0) return `every ${minutes / 60} h`;
  return `every ${Math.round(minutes * 10) / 10} min`;
}

/** An inbox's state in a word, and its tone (the design's state colours). */
export function inboxState({ inbox, status }: InboxView): { tone: string; label: string } {
  if (!inbox.enabled) return { tone: "off", label: "Paused" };
  if (status.running) return { tone: "busy", label: "Checking…" };
  if (status.error) return status.failures >= 3 ? { tone: "danger", label: "Needs attention" } : { tone: "busy", label: "Retrying" };
  if (!status.initialized) return { tone: "busy", label: "First check soon" };
  return { tone: "idle", label: "Watching" };
}

/** A source's mark, in the square the lists use for things that are not pets. */
function SourceMark({ kind }: { kind: Kind }) {
  const Icon = sourceOf(kind).icon;
  return (
    <span className="avatar task" aria-hidden>
      <Icon size={15} strokeWidth={1.75} />
    </span>
  );
}

/** A house's inboxes, polled every 5 s while a page shows them (the house's Inboxes page, a pet's Inboxes tab). */
export function useHouseInboxes(house: string, enabled = true) {
  const [items, setItems] = useState<InboxView[]>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const refresh = async () => {
    setItems(await api.inboxes(house));
    setError("");
    setNow(Date.now());
  };
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      api
        .inboxes(house)
        .then((result) => {
          if (!alive) return;
          setItems(result);
          setError("");
          setNow(Date.now());
        })
        .catch((e) => {
          if (alive) setError((e as Error).message);
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [house, enabled]);
  return { items, error, now, refresh };
}

/** Where an inbox's events go, in a line: its channel post, or pets only (replying in that channel). */
function deliveryWords(inbox: HouseInbox, house: HouseView): string {
  const channel = house.channels.find((c) => c.chat === inbox.channel)?.name ?? "a removed channel";
  return inbox.delivery === "silent" ? `pets only, replies in ${channel}` : `posts to ${channel}`;
}

/**
 * A house's inboxes: each source with its state, where its events go and who gets them; then the events they
 * received lately. Adding and editing is a dialog of three steps (source, connection, delivery).
 */
export function HouseInboxesPage({ house, notify }: { house: HouseView; notify: (message: string, warning?: boolean) => void }) {
  const { items, error, now, refresh } = useHouseInboxes(house.name);
  const [editing, setEditing] = useState<HouseInbox | "new">();
  const [busy, setBusy] = useState<string>();
  const [allEvents, setAllEvents] = useState(false);
  const dialog = useDialog();
  const action = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await work();
      await refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(undefined);
    }
  };
  const pets = new Map(house.pets.map((pet) => [pet.name, pet]));
  const events = (items ?? [])
    .flatMap(({ inbox, status }) => status.recent.map((event) => ({ ...event, inbox })))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const shown = allEvents ? events : events.slice(0, 8);
  return (
    <Page
      title="Inboxes"
      actions={
        <button className="btn primary" onClick={() => setEditing("new")}>
          + Add inbox
        </button>
      }
    >
      <Section
        hint={
          <>
            Mail, feeds, health checks and alerts, checked from this host. Subscribed pets get each event; credentials never enter a VM.{" "}
            <a href={DOCS} target="_blank" rel="noreferrer" className="text-link">
              How inboxes work ↗
            </a>
          </>
        }
      >
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <List columns="minmax(0, 1fr) minmax(0, 200px) auto" empty={items ? "Nothing connected yet. Add mail, a feed, a health check, alerts or your own endpoint." : "Loading…"}>
          {(items ?? []).map((view) => {
            const { inbox, status } = view;
            const state = inboxState(view);
            const working = busy === inbox.name;
            return (
              <ListRow
                key={inbox.name}
                actions={
                  <>
                    {inbox.enabled && <button
                      className="text-btn plain"
                      disabled={working || status.running}
                      onClick={() =>
                        void action(inbox.name, async () => {
                          const result = await api.pollInbox(house.name, inbox.name);
                          notify(result.status.error ?? `${inbox.title} checked`, !!result.status.error);
                        })
                      }
                    >
                      Check now
                    </button>}
                    <button className="text-btn plain" disabled={working} onClick={() => setEditing(inbox)}>
                      Edit
                    </button>
                    <button className="text-btn plain" disabled={working} onClick={() => void action(inbox.name, () => written(api.updateInbox(house.name, { ...inbox, enabled: !inbox.enabled })))}>
                      {inbox.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      className="text-btn"
                      disabled={working}
                      onClick={() =>
                        dialog.open({
                          title: `Remove “${inbox.title}”?`,
                          body: "Polling stops and pending events are discarded. What it already posted stays in the channel.",
                          confirmLabel: "Remove inbox",
                          danger: true,
                          onConfirm: async () => {
                            await written(api.removeInbox(house.name, inbox.name));
                            await refresh();
                          },
                        })
                      }
                    >
                      Remove
                    </button>
                  </>
                }
              >
                <Cell>
                  <SourceMark kind={inbox.source.kind} />
                  <span className="cell-lines">
                    <span className="strong ellipsis">{inbox.title}</span>
                    <span className="faint">
                      {sourceOf(inbox.source.kind).label} · {everyWords(inbox.intervalSeconds)} · {deliveryWords(inbox, house)}
                    </span>
                    <span className="channel-company">
                      {inbox.pets.length === 0 ? (
                        <span className="faint">No pets: a channel feed</span>
                      ) : (
                        inbox.pets.map((name) => {
                          const pet = pets.get(name);
                          const quiet = inbox.quiet.includes(name);
                          return (
                            <span key={name} className="chip small" title={quiet ? "Silent: in its inbox history, not woken" : undefined}>
                              <span aria-hidden>{pet?.emoji ?? "🐾"}</span>
                              <span className="ellipsis">{pet?.title ?? name}</span>
                              {quiet && <BellOff size={11} strokeWidth={2} className="faint" aria-label="silent" />}
                            </span>
                          );
                        })
                      )}
                    </span>
                    {status.error && inbox.enabled && (
                      <span className="inbox-problem">
                        <span className="error">{status.error}</span>
                        <span className="faint">
                          {status.failures} failed {status.failures === 1 ? "check" : "checks"} in a row
                          {status.problemSince && `, since ${relative(status.problemSince, now)}`}. Retries continue;{" "}
                          {status.failures >= 3 ? "subscribers were told and hear again on recovery." : "subscribers are told after 3."}
                        </span>
                      </span>
                    )}
                  </span>
                </Cell>
                <Cell lines>
                  <span className="pet-state">
                    <span className={`dot ${state.tone}`} />
                    {state.label}
                    {status.pendingCount > 0 && <span className="tag busy">{status.pendingCount} waiting</span>}
                  </span>
                  <span className="faint inbox-times">
                    {status.lastCheck ? `checked ${relative(status.lastCheck, now)}` : "not checked yet"}
                    {inbox.enabled && status.nextCheck > 0 && (status.nextCheck - now >= 30_000 ? ` · next ${relative(new Date(status.nextCheck).toISOString(), now)}` : " · due now")}
                  </span>
                </Cell>
              </ListRow>
            );
          })}
        </List>
      </Section>
      {events.length > 0 && (
        <Section title="Recent events" hint="The latest each inbox received. Subscribed pets search all of it with inbox_history.">
          <List columns="minmax(0, 1fr) auto">
            {shown.map((event) => (
              <ListRow key={`${event.inbox.name}/${event.id}`}>
                <Cell>
                  <span className={`dot ${event.status === "delivered" ? "idle" : "busy"}`} title={event.status === "delivered" ? "Delivered" : "Waiting for delivery"} />
                  <span className="cell-lines">
                    <span className="ellipsis">{event.title}</span>
                    <span className="faint ellipsis">{event.inbox.title}</span>
                  </span>
                </Cell>
                <Cell>
                  {event.status === "queued" && <span className="tag busy">waiting</span>}
                  <span className="faint inbox-times" title={new Date(event.at).toLocaleString()}>
                    {relative(event.at, now)}
                  </span>
                </Cell>
              </ListRow>
            ))}
          </List>
          {events.length > shown.length && (
            <button type="button" className="text-btn plain inbox-more" onClick={() => setAllEvents(true)}>
              Show all {events.length}
            </button>
          )}
        </Section>
      )}
      {editing && (
        <InboxEditor
          key={editing === "new" ? "new" : editing.name}
          house={house}
          inbox={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          save={async (inbox) => {
            const warning = await written(editing === "new" ? api.addInbox(house.name, inbox) : api.updateInbox(house.name, inbox));
            await refresh();
            notify(warning ?? `${inbox.title} saved`, warning !== undefined);
          }}
        />
      )}
      {dialog.element}
    </Page>
  );
}

/** A pet's switches for one inbox: whether it gets the events, and whether they wake it (off: history only). */
function SubscriberSwitches({ name, subscribed, quiet, disabled, onChange }: { name: string; subscribed: boolean; quiet: boolean; disabled?: boolean; onChange: (subscribed: boolean, quiet: boolean) => void }) {
  return (
    <>
      <Switch label="Receives" title={`${name} gets its events`} on={subscribed} disabled={disabled} onChange={(on) => onChange(on, on && quiet)} />
      <Switch label="Silent" title="Kept in its inbox history; it is not woken for them" on={subscribed && quiet} disabled={disabled || !subscribed} onChange={(on) => onChange(true, on)} />
    </>
  );
}

/**
 * A pet's inboxes: every inbox of its house, whether the pet gets its events and whether they wake it. The inbox's
 * own settings (source, channel, how often) stay on the house's Inboxes page.
 */
export function PetInboxes({ house, pet, inboxes: { items, error, refresh }, notify }: { house: HouseView; pet: PetView; inboxes: ReturnType<typeof useHouseInboxes>; notify: (text: string, warning?: boolean) => void }) {
  const [busy, setBusy] = useState<string>();
  const set = async (inbox: HouseInbox, subscribed: boolean, quiet: boolean) => {
    setBusy(inbox.name);
    try {
      const warning = await written(api.subscribeInbox(house.name, inbox.name, pet.name, { subscribed, quiet }));
      const done = !subscribed ? `${pet.title} unsubscribed from ${inbox.title}` : quiet ? `${inbox.title} is silent for ${pet.title}` : `${pet.title} gets ${inbox.title}`;
      notify(warning ?? done, warning !== undefined);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      await refresh().catch(() => {});
      setBusy(undefined);
    }
  };
  const inboxesPage = (
    <Link href={housePath(house.name, "inboxes")} className="text-link">
      Inboxes
    </Link>
  );
  return (
    <Section
      hint={
        <>
          What {pet.title} gets from the house's inboxes. Silent ones go to its inbox history only and never wake it. Sources and schedules: the house's {inboxesPage} page.
        </>
      }
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="inbox-subscriptions">
        <List columns="minmax(0, 1fr) auto" empty={items ? <>No inboxes in {house.name} yet: add one on the house's {inboxesPage} page.</> : "Loading…"}>
          {(items ?? []).map((view) => {
            const { inbox } = view;
            const state = inboxState(view);
            const subscribed = inbox.pets.includes(pet.name);
            const channel = house.channels.find((c) => c.chat === inbox.channel);
            const placed = channel?.pets.includes(pet.name) ?? false;
            // Silent delivery needs a subscriber: the last one cannot leave (the house page can switch it to a post).
            const last = subscribed && inbox.delivery === "silent" && inbox.pets.length === 1;
            let note: ReactNode = null;
            if (!placed && !subscribed)
              note = (
                <>
                  Not in {channel?.name ?? "its channel"}:{" "}
                  <Link href={petPath(house.name, pet.name, "channels")} className="text-link">
                    join it
                  </Link>{" "}
                  to subscribe.
                </>
              );
            else if (last) note = "The only subscriber of a pets-only inbox.";
            return (
              <ListRow key={inbox.name} actions={<SubscriberSwitches name={pet.title} subscribed={subscribed} quiet={inbox.quiet.includes(pet.name)} disabled={busy !== undefined || (!placed && !subscribed)} onChange={(on, quiet) => (on || !last ? void set(inbox, on, quiet) : notify("Switch the inbox to post in its channel, or subscribe another pet first.", true))} />}>
                <Cell>
                  <SourceMark kind={inbox.source.kind} />
                  <span className="cell-lines">
                    <span className="pet-state strong">
                      <span className="ellipsis">{inbox.title}</span>
                      <span className={`dot ${state.tone}`} title={state.label} />
                    </span>
                    <span className="faint">
                      {sourceOf(inbox.source.kind).label} · {everyWords(inbox.intervalSeconds)} · {deliveryWords(inbox, house)}
                    </span>
                    {note && <span className="hint">{note}</span>}
                  </span>
                </Cell>
              </ListRow>
            );
          })}
        </List>
      </div>
    </Section>
  );
}

/** How many inboxes a pet gets events from (its tab's count). */
export const subscribedCount = (items: InboxView[] | undefined, pet: string) => items?.filter(({ inbox }) => inbox.pets.includes(pet)).length ?? 0;

const STEPS = ["Source", "Connection", "Delivery"] as const;

/**
 * An inbox's form, in three steps: what it watches, how to reach it (tested before going on), and where its events
 * go and who gets them. Editing starts at the last step; Back reaches the connection.
 */
function InboxEditor({ house, inbox, onClose, save }: { house: HouseView; inbox?: HouseInbox; onClose: () => void; save: (inbox: HouseInbox) => Promise<void> }) {
  const [step, setStep] = useState(inbox ? 2 : 0);
  const [kind, setKind] = useState<Kind>(inbox?.source.kind ?? "imap");
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
  const [quiet, setQuiet] = useState(inbox?.quiet ?? []);
  const minutes = (inbox?.intervalSeconds ?? 300) / 60;
  const [frequency, setFrequency] = useState([1, 5, 15].includes(minutes) ? String(minutes) : "custom");
  const [custom, setCustom] = useState(String(minutes));
  const [initial, setInitial] = useState<HouseInbox["initial"]>(inbox?.initial ?? "new");
  const [tested, setTested] = useState("");
  const [suffix] = useState(() => crypto.randomUUID().slice(0, 6));
  const selected = house.channels.find((c) => c.chat === channel);
  const mail = kind === "imap" || kind === "pop3";
  const requestHeaders = () => Object.fromEntries(headers.filter(([key]) => key.trim()).map(([key, value]) => [key.trim(), value]));
  const fields = (): HouseInbox => ({
    name: inbox?.name ?? (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35).replace(/^[^a-z]+/, "") || "inbox") + "-" + suffix,
    title: title.trim() || sourceOf(kind).label,
    enabled: inbox?.enabled ?? true,
    intervalSeconds: Number(frequency === "custom" ? custom : frequency) * 60,
    channel: channel || "preview",
    pets,
    quiet: quiet.filter((pet) => pets.includes(pet)),
    initial,
    delivery,
    source:
      kind === "telegram-bot" ? { kind, token: botToken.trim() }
      : kind === "imap" ? { kind, host: host.trim(), port: Number(port || 993), username, password, mailbox }
      : kind === "pop3" ? { kind, host: host.trim(), port: Number(port || 995), username, password }
      : kind === "health" ? { kind, url: url.trim(), headers: requestHeaders(), timeoutMs: Number(timeout) * 1000, failures: Number(failures), expectedStatus: Number(expectedStatus) }
      : kind === "json-watch" ? { kind, url: url.trim(), headers: requestHeaders(), pointers: watchMode === "fields" ? pointers.split("\n").map((p) => p.trim()).filter(Boolean) : [] }
      : kind === "datadog" ? { kind, url: url.trim(), headers: requestHeaders(), monitor }
      : { kind, url: url.trim(), headers: requestHeaders() },
  });
  const subscribers = house.pets.filter((p) => !p.sideworker && selected?.pets.includes(p.name));
  const urlLabel = kind === "grafana" ? "Grafana base URL" : kind === "datadog" ? "Datadog API base URL" : kind === "rss" ? "Feed URL" : "Endpoint URL";
  const urlHint =
    kind === "http" ? "GET with cursor and limit=50; answers version: 1, items and an optional nextCursor."
    : kind === "datadog" ? "Your Datadog region's API. Keys go in the headers below."
    : kind === "grafana" ? "A service account token goes in the Authorization header below."
    : kind === "rss" ? "RSS 2.0, RSS 1.0 or Atom. Only new entries are delivered."
    : "A plain GET; no response contract needed.";
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: inbox ? `Edit “${inbox.title}”` : "Add inbox",
        wide: true,
        step: `inbox-${step}`,
        confirmLabel: step === 0 ? "Next" : step === 1 ? "Test and continue" : inbox ? "Save" : "Add inbox",
        busyLabel: step === 1 ? "Testing connection…" : "Saving…",
        back: step > (inbox ? 1 : 0) ? () => setStep(step - 1) : undefined,
        onConfirm: async () => {
          if (step === 0) {
            setStep(1);
            return "stay";
          }
          if (step === 1) {
            if (kind === "json-watch" && watchMode === "fields" && !pointers.trim()) throw new Error("Add at least one field path.");
            const check = await api.testInbox(house.name, { ...fields(), pets: [], quiet: [], delivery: "announce" });
            setTested(check.message);
            setStep(2);
            return "stay";
          }
          if (delivery === "silent" && !pets.length) throw new Error("Subscribe at least one pet, or post events in the channel.");
          if (!channel) throw new Error("Add a channel to this house first.");
          const interval = fields().intervalSeconds;
          if (!Number.isInteger(interval) || interval < 60 || interval > 86400) throw new Error("Choose an interval from 1 to 1,440 minutes (whole seconds).");
          await save(fields());
        },
        children: (
          <>
            <ol className="steps" aria-label="Steps">
              {STEPS.map((label, index) => (
                <li key={label} className={index === step ? "current" : index < step ? "done" : undefined} aria-current={index === step ? "step" : undefined}>
                  {label}
                </li>
              ))}
            </ol>
            {step === 0 && (
              <ChoiceList
                label="What should it watch?"
                value={kind}
                onChange={(value) => {
                  setKind(value as Kind);
                  setPort("");
                  setHeaders(value === "datadog" ? [["DD-API-KEY", ""], ["DD-APPLICATION-KEY", ""]] : value === "grafana" ? [["Authorization", "Bearer "]] : []);
                }}
                options={SOURCES.map((s) => ({ value: s.value, label: s.label, description: s.description, icon: <SourceMark kind={s.value} /> }))}
              />
            )}
            {step === 1 && (
              <>
                <p className="dialog-text">
                  {kind === "telegram-bot"
                    ? "Incoming updates only. The token stays on this host."
                    : mail
                      ? "Read-only, over verified TLS. Use an app password if your provider asks for one; OAuth-only mailboxes are not supported yet."
                      : "Requests run on this host; redirects are refused. Credentials go in the headers."}
                </p>
                {kind === "telegram-bot" ? (
                  <TextField
                    label="Bot token"
                    mono
                    type="password"
                    value={botToken}
                    onChange={setBotToken}
                    placeholder="123456789:…"
                    hint="A dedicated bot from BotFather, not a channel's bot: polling takes its updates, so nothing else may read them. A bot with a webhook is refused. Testing reads nothing."
                  />
                ) : mail ? (
                  <>
                    <FormGrid>
                      <TextField label="Mail server" mono value={host} onChange={setHost} placeholder={kind === "imap" ? "imap.example.com" : "pop.example.com"} />
                      <TextField label="TLS port" mono value={port} onChange={setPort} inputMode="numeric" placeholder={kind === "imap" ? "993" : "995"} />
                    </FormGrid>
                    <FormGrid>
                      <TextField label="Username" mono value={username} onChange={setUsername} placeholder="you@example.com" />
                      <TextField label="Password or app password" type="password" value={password} onChange={setPassword} />
                    </FormGrid>
                    {kind === "imap" && <TextField label="Folder" mono value={mailbox} onChange={setMailbox} placeholder="INBOX" />}
                  </>
                ) : (
                  <>
                    <TextField label={urlLabel} mono type="url" value={url} onChange={setUrl} placeholder={kind === "grafana" ? "https://grafana.example.com" : kind === "datadog" ? "https://api.datadoghq.eu" : "https://example.com/inbox"} hint={urlHint} />
                    {kind === "datadog" && <TextField label="Monitor ID" mono value={monitor} onChange={setMonitor} inputMode="numeric" placeholder="123456" />}
                    {kind === "health" && (
                      <div className="form-grid inbox-health">
                        <TextField label="Expected status" mono inputMode="numeric" value={expectedStatus} onChange={setExpectedStatus} />
                        <TextField label="Timeout, s" inputMode="text" value={timeout} onChange={setTimeout} hint="0.1–60; a timeout fails." />
                        <TextField label="Failures to alert" inputMode="numeric" value={failures} onChange={setFailures} hint="1–10 in a row." />
                      </div>
                    )}
                    {kind === "json-watch" && (
                      <>
                        <div className="field">
                          <span className="field-label">Watch</span>
                          <div className="segmented wide" role="group" aria-label="Watch">
                            <button type="button" aria-pressed={watchMode === "whole"} onClick={() => setWatchMode("whole")}>
                              Whole response
                            </button>
                            <button type="button" aria-pressed={watchMode === "fields"} onClick={() => setWatchMode("fields")}>
                              Selected fields
                            </button>
                          </div>
                          <p className="hint">Key order and whitespace are ignored; array order matters.</p>
                        </div>
                        {watchMode === "fields" && (
                          <Field id="inbox-pointers" label="Field paths, one per line" hint="JSON Pointers, e.g. /items/0/price. Write / as ~1 and ~ as ~0.">
                            <textarea id="inbox-pointers" aria-describedby="inbox-pointers-hint" className="control mono inbox-pointers" value={pointers} onChange={(e) => setPointers(e.target.value)} placeholder={"/price\n/status"} rows={3} />
                          </Field>
                        )}
                      </>
                    )}
                    <fieldset className="field">
                      <legend className="field-label">Request headers</legend>
                      {headers.map(([key, value], i) => (
                        <div className="inbox-header-row" key={i}>
                          <TextField label={`Header ${i + 1} name`} hideLabel mono value={key} onChange={(v) => setHeaders(headers.map((h, n) => (n === i ? [v, h[1]] : h)))} placeholder="Authorization" />
                          <TextField label={`Header ${i + 1} value`} hideLabel mono type="password" value={value} onChange={(v) => setHeaders(headers.map((h, n) => (n === i ? [h[0], v] : h)))} placeholder="Bearer …" />
                          <button className="icon-btn small" type="button" aria-label={`Remove header ${i + 1}`} onClick={() => setHeaders(headers.filter((_, n) => n !== i))}>
                            <X size={14} strokeWidth={1.75} aria-hidden />
                          </button>
                        </div>
                      ))}
                      <button className="text-btn plain inbox-add-header" type="button" onClick={() => setHeaders([...headers, ["", ""]])} disabled={headers.length >= 20}>
                        + Add header
                      </button>
                    </fieldset>
                  </>
                )}
                <p className="hint">Testing posts nothing, tells no pet and leaves the polling position as it is.</p>
              </>
            )}
            {step === 2 && (
              <>
                {tested && (
                  <p className="check-note" role="status">
                    <Check size={14} strokeWidth={2} aria-hidden />
                    <span>{tested}</span>
                  </p>
                )}
                <FormGrid>
                  <TextField label="Name" value={title} onChange={setTitle} placeholder={sourceOf(kind).label} />
                  <SelectField
                    label="Check"
                    value={frequency}
                    onChange={setFrequency}
                    options={[
                      { value: "1", label: "Every minute" },
                      { value: "5", label: "Every 5 minutes" },
                      { value: "15", label: "Every 15 minutes" },
                      { value: "custom", label: "Custom interval…" },
                    ]}
                  />
                </FormGrid>
                {frequency === "custom" && <TextField label="Interval in minutes" inputMode="numeric" value={custom} onChange={setCustom} hint="From 1 minute to 24 hours." />}
                <SelectField
                  label="Channel"
                  hint={delivery === "silent" ? "Where pets reply about its events." : "Where events are posted and pets reply."}
                  value={channel}
                  onChange={(v) => {
                    setChannel(v);
                    setPets([]);
                    setQuiet([]);
                  }}
                  options={[{ value: "", label: "Choose a channel…", disabled: true }, ...house.channels.map((c) => ({ value: c.chat, label: c.name }))]}
                />
                <div className="switch-list">
                  <div className="switch-row">
                    <span className="stack gap-1">
                      <span className="strong">Post events in the channel</span>
                      <span className="hint">{delivery === "silent" ? "Off: only subscribed pets get them, privately." : "One House message per event, for everyone in the channel."}</span>
                    </span>
                    <Switch label="Post events in the channel" hideLabel on={delivery === "announce"} onChange={(on) => setDelivery(on ? "announce" : "silent")} />
                  </div>
                </div>
                <div className="field">
                  <span className="field-label">Pets</span>
                  {subscribers.length === 0 ? (
                    <p className="hint">No pets in {selected?.name ?? "this channel"} yet. Place pets there first, or keep this a channel feed.</p>
                  ) : (
                    <List columns="minmax(0, 1fr) auto">
                      {subscribers.map((pet) => (
                        <ListRow
                          key={pet.name}
                          actions={
                            <SubscriberSwitches
                              name={pet.title}
                              subscribed={pets.includes(pet.name)}
                              quiet={quiet.includes(pet.name)}
                              onChange={(on, silent) => {
                                setPets(on ? (pets.includes(pet.name) ? pets : [...pets, pet.name]) : pets.filter((p) => p !== pet.name));
                                setQuiet(on && silent ? (quiet.includes(pet.name) ? quiet : [...quiet, pet.name]) : quiet.filter((p) => p !== pet.name));
                              }}
                            />
                          }
                        >
                          <Cell>
                            <span aria-hidden>{pet.emoji}</span>
                            <span className="ellipsis">{pet.title}</span>
                          </Cell>
                        </ListRow>
                      ))}
                    </List>
                  )}
                  <p className="hint">
                    {delivery === "silent" ? "At least one pet must receive. " : ""}Each gets its own copy when idle; silent ones only find it in their inbox history. Event contents are never treated as your instructions.
                  </p>
                </div>
                {!inbox && (
                  <SelectField
                    label="On the first check"
                    value={initial}
                    onChange={(v) => setInitial(v as HouseInbox["initial"])}
                    options={[
                      { value: "new", label: "Start from now, skip what is there" },
                      { value: "latest", label: "Deliver what is there now (up to 50)" },
                    ]}
                  />
                )}
              </>
            )}
          </>
        ),
      }}
    />
  );
}
