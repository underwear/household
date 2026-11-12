import { MicrosoftSetup, microsoftAccessWords, useMicrosoftConnections } from "./microsoft-connectors";
import type { MicrosoftConnectionView } from "../api";
import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, Files, Mail } from "lucide-react";
import { api, type GoogleConnectionView, type GoogleConnectorsView, type GoogleService, type SlackConnectionView, type WorkspaceView } from "../api";
import { SlackSetup, slackAccessWords, useSlackConnections } from "./slack-connectors";
import { workspacePath, redirect } from "../router";
import { Dialog, useDialog } from "./dialog";
import { ChoiceList, FormGroup, SwitchList } from "./fields";
import { Cell, List, ListRow, Page, Section } from "./layout";
import { relative } from "./bot-crons";

/** What can be connected: the first step of Add connector, and an account's mark and name in the list. */
export const CONNECTOR_TYPES = [{ id: "google", label: "Google", description: "Gmail, Drive and Calendar.", mark: "G" }, { id: "slack", label: "Slack", description: "Search and read conversations, as you.", mark: "S" }, { id: "microsoft", label: "Microsoft To Do", description: "Lists, tasks and checklists.", mark: "M" }] as const;
type ConnectorType = (typeof CONNECTOR_TYPES)[number]["id"];
/** A Google account's services: what the owner picks to share (and what bots may do with each), and their names. */
const SERVICES = [
  { id: "gmail", label: "Gmail", read: "Search and read email", write: "Search, read, send, draft, label and trash email", icon: Mail },
  { id: "drive", label: "Drive", read: "Find files and read documents", write: "Find, read, create, edit and trash files", icon: Files },
  { id: "calendar", label: "Calendar", read: "Read calendars and events", write: "Read, create, change and delete events", icon: CalendarDays },
] as const;
/** How far bots may go with an account: read it, or act as its owner too. */
const ACCESS = [
  { value: "write", label: "Read and write", description: "Bots can also send mail, edit files and change events, as you." },
  { value: "read", label: "Read only", description: "Bots search and read; nothing in the account changes." },
] as const;
/** «read and write», «read only», or which services can change when Google granted only some. */
export const accessWords = ({ services, writable }: Pick<GoogleConnectionView, "services" | "writable">) =>
  !writable.length ? "read only" : services.every((s) => writable.includes(s)) ? "read and write" : `${servicesWords(writable)} writable`;
const PRIVACY = "https://agents-household.dev/privacy/";
const toggle = <T extends string>(values: T[], value: T) => (values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
/** «Gmail, Drive and Calendar». */
export const servicesWords = (services: readonly GoogleService[]) => {
  const labels = SERVICES.filter((s) => services.includes(s.id)).map((s) => s.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? "No services");
};

/** A provider's mark, in the square the lists use for things that are not bots. */
function ConnectorMark({ type }: { type: ConnectorType }) {
  return (
    <span className="avatar task connector-mark" aria-hidden>
      {CONNECTOR_TYPES.find((t) => t.id === type)?.mark}
    </span>
  );
}

/**
 * A workspace's Connectors page: the outside accounts its bots may read (Google accounts, Slack users), one list, each
 * with its own bot access. Adding one is a dialog: the type, then the provider's own steps.
 */
export function WorkspaceConnectors({ house, notify }: { house: WorkspaceView; notify: (text: string, warning?: boolean) => void }) {
  const [view, setView] = useState<GoogleConnectorsView>();
  const [error, setError] = useState("");
  const slack = useSlackConnections(house.name);
  const microsoft = useMicrosoftConnections(house.name);
  const [setup, setSetup] = useState<{ type?: ConnectorType; existing?: GoogleConnectionView; slack?: SlackConnectionView; microsoft?: MicrosoftConnectionView }>();
  const [access, setAccess] = useState<{ google: GoogleConnectionView } | { slack: SlackConnectionView } | { microsoft: MicrosoftConnectionView }>();
  const dialog = useDialog();
  const refresh = async () => {
    try {
      setView(await api.googleConnections(house.name));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    // Back from Google's sign-in: say so once, and drop the marker from the address.
    if (new URLSearchParams(location.search).get("google") === "connected") {
      notify("Google account connected");
      redirect(workspacePath(house.name, "connectors"));
    }
  }, [house.name]);
  const connections = view?.connections ?? [];
  const loaded = view !== undefined && slack.connections !== undefined && microsoft.connections !== undefined;
  const disconnect = (c: GoogleConnectionView) =>
    dialog.open({
      title: `Disconnect ${c.email}?`,
      body: "Its bots lose access on their next request. Other accounts stay connected; what bots already read stays in their history and backups.",
      children: (
        <p className="hint">
          To revoke Household's access everywhere, use{" "}
          <a className="text-link" href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">
            Google Account connections ↗
          </a>
        </p>
      ),
      confirmLabel: "Disconnect",
      danger: true,
      onConfirm: async () => {
        await api.disconnectGoogle(house.name, c.id);
        await refresh();
        notify(`${c.email} disconnected`);
      },
    });
  const disconnectSlack = (c: SlackConnectionView) =>
    dialog.open({
      title: `Disconnect ${c.team}?`,
      body: "Its bots lose access right away, reads in progress included. What they already read stays in their history and backups.",
      children: <p className="hint">The token is removed from this host and revoked at Slack.</p>,
      confirmLabel: "Disconnect",
      danger: true,
      onConfirm: async () => {
        await api.disconnectSlack(house.name, c.id);
        await slack.refresh();
        notify(`Slack ${c.team} disconnected`);
      },
    });
  const disconnectMicrosoft = (c: MicrosoftConnectionView) => dialog.open({
    title: `Disconnect ${c.account}?`,
    body: "Its bots lose access right away. The credentials are removed from this host. What bots already read stays in their history and backups. This does not revoke Microsoft's account-wide app consent.",
    confirmLabel: "Disconnect", danger: true,
    onConfirm: async () => { await api.disconnectMicrosoft(house.name, c.id); await microsoft.refresh(); notify(`${c.account} disconnected`); },
  });
  const failed = [microsoft.error && { what: "Microsoft", message: microsoft.error, retry: microsoft.refresh }, error && { what: "Google", message: error, retry: refresh }, slack.error && { what: "Slack", message: slack.error, retry: slack.refresh }].filter(Boolean) as { what: string; message: string; retry: () => Promise<void> }[];
  return (
    <Page
      title="Connectors"
      actions={
        <button className="btn primary" onClick={() => setSetup({})}>
          + Add connector
        </button>
      }
    >
      <Section
        hint={
          <>
            Connect accounts for this workspace's bots. Each account has its own bot access and read-only or read-and-write permissions. Tokens stay on this host; what a bot reads goes to its AI provider and chat.
          </>
        }
      >
        {failed.map(({ what, message, retry }) => (
          <p key={what} className="error" role="alert">
            {what}: {message}{" "}
            <button className="text-btn plain" onClick={() => void retry()}>
              Retry
            </button>
          </p>
        ))}
        <List columns="minmax(0, 1fr) minmax(0, 180px) auto" empty={loaded ? "Nothing connected yet. Add a Google, Slack or Microsoft To Do account and choose which bots may use it." : failed.length ? undefined : "Loading…"}>
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              house={house}
              type="google"
              title={<span className="strong connector-email">{c.email}</span>}
              sub={`Google · ${servicesWords(c.services)} · ${accessWords(c)}`}
              connection={c}
              onAccess={() => setAccess({ google: c })}
              onReconnect={() => setSetup({ type: "google", existing: c })}
              onDisconnect={() => disconnect(c)}
            />
          ))}
          {(microsoft.connections ?? []).map(c => (
            <ConnectionRow key={c.id} house={house} type="microsoft" title={<span className="strong connector-email">{c.account}</span>}
              sub={`Microsoft To Do · ${microsoftAccessWords(c)}`} connection={c}
              onAccess={() => setAccess({ microsoft: c })} onReconnect={() => setSetup({ type: "microsoft", microsoft: c })} onDisconnect={() => disconnectMicrosoft(c)} />
          ))}
          {(slack.connections ?? []).map((c) => (
            <ConnectionRow
              key={c.id}
              house={house}
              type="slack"
              title={<span className="strong ellipsis">{c.team} <span className="muted">· {c.user}</span></span>}
              sub={`Slack · ${slackAccessWords(c)}`}
              connection={c}
              onAccess={() => setAccess({ slack: c })}
              onReconnect={() => setSetup({ type: "slack", slack: c })}
              onDisconnect={() => disconnectSlack(c)}
            />
          ))}
        </List>
      </Section>
      {setup && setup.type !== "slack" && setup.type !== "microsoft" && <ConnectorSetup onMicrosoft={() => setSetup({ type: "microsoft" })} onSlack={() => setSetup({ type: "slack" })} house={house} ready={!!view?.ready} existing={setup.existing} onClose={() => setSetup(undefined)} />}
      {setup?.type === "microsoft" && <MicrosoftSetup key={setup.microsoft?.id ?? "new"} house={house.name} ready={!!microsoft.ready} existing={setup.microsoft}
        options={sharable(house)} back={setup.microsoft ? undefined : () => setSetup({})} onClose={() => setSetup(undefined)}
        saved={async () => { await microsoft.refresh(); notify("Microsoft To Do connected"); }} />}
      {setup?.type === "slack" && (
        <SlackSetup
          key={setup.slack?.id ?? "new"}
          house={house.name}
          existing={setup.slack}
          options={sharable(house)}
          back={setup.slack ? undefined : () => setSetup({})}
          onClose={() => setSetup(undefined)}
          saved={async () => {
            await slack.refresh();
            notify(setup.slack ? `Slack ${setup.slack.team} reconnected` : "Slack connected");
          }}
        />
      )}
      {access && "microsoft" in access && <BotAccess house={house} title={access.microsoft.account} pets={access.microsoft.pets}
        body={`Microsoft To Do, ${microsoftAccessWords(access.microsoft)}. Changes apply right away.`} onClose={() => setAccess(undefined)}
        save={async pets => { await api.shareMicrosoft(house.name, access.microsoft.id, pets); await microsoft.refresh(); notify("Bot access saved"); }} />}
      {access && "google" in access && (
        <BotAccess
          key={access.google.id}
          house={house}
          title={access.google.email}
          body={`${servicesWords(access.google.services)}, ${accessWords(access.google)}. Changes apply on a bot's next request, no restart.`}
          pets={access.google.pets}
          onClose={() => setAccess(undefined)}
          save={async (names) => {
            await api.shareGoogle(house.name, access.google.id, names);
            await refresh();
            notify("Bot access saved");
          }}
        />
      )}
      {access && "slack" in access && (
        <BotAccess
          key={access.slack.id}
          house={house}
          title={`Slack ${access.slack.team}`}
          body={`${access.slack.user}, ${slackAccessWords(access.slack)}. Changes apply right away; a bot losing access stops reading at once.`}
          pets={access.slack.pets}
          onClose={() => setAccess(undefined)}
          save={async (names) => {
            await api.shareSlack(house.name, access.slack.id, names);
            await slack.refresh();
            notify("Bot access saved");
          }}
        />
      )}
      {dialog.element}
    </Page>
  );
}

/** One connected account: its mark, name, what it gives and which bots have it; its state; Bot access, Reconnect, Disconnect. */
function ConnectionRow({ house, type, title, sub, connection: c, onAccess, onReconnect, onDisconnect }: {
  house: WorkspaceView; type: ConnectorType; title: ReactNode; sub: string;
  connection: { pets: string[]; needsReconnect: boolean; connectedAt: string };
  onAccess: () => void; onReconnect: () => void; onDisconnect: () => void;
}) {
  const pets = new Map(house.pets.map((pet) => [pet.name, pet]));
  return (
    <ListRow
      actions={
        <>
          <button className="text-btn plain" onClick={onAccess}>Bot access</button>
          <button className={c.needsReconnect ? "btn small" : "text-btn plain"} onClick={onReconnect}>Reconnect</button>
          <button className="text-btn" onClick={onDisconnect}>Disconnect</button>
        </>
      }
    >
      <Cell>
        <ConnectorMark type={type} />
        <span className="cell-lines">
          {title}
          <span className="faint">{sub}</span>
          <span className="channel-company">
            {c.pets.length === 0 ? (
              <span className="faint">No bots yet: private until you grant access</span>
            ) : (
              c.pets.map((name) => (
                <span key={name} className="chip small">
                  <span aria-hidden>{pets.get(name)?.emoji ?? "🤖"}</span>
                  <span className="ellipsis">{pets.get(name)?.title ?? name}</span>
                </span>
              ))
            )}
          </span>
        </span>
      </Cell>
      <Cell lines>
        <span className="bot-state">
          <span className={`dot ${c.needsReconnect ? "danger" : "idle"}`} />
          {c.needsReconnect ? "Reconnect required" : "Connected"}
        </span>
        <span className="faint" title={new Date(c.connectedAt).toLocaleString()}>
          connected {relative(c.connectedAt) === "now" ? "just now" : relative(c.connectedAt)}
        </span>
      </Cell>
    </ListRow>
  );
}

/** The bots an account can be shared with: sideworkers follow their parent, so they are not listed. */
const sharable = (house: WorkspaceView) => house.pets.filter((p) => !p.sideworker).map((p) => ({ value: p.name, label: `${p.emoji ?? "🤖"} ${p.title}` }));

/**
 * Add connector, in two steps: what to connect, then the provider's form (services and bots), which leaves for its
 * sign-in page. Reconnecting an account starts at the form, with that account's choices.
 */
function ConnectorSetup({ house, ready, existing, onClose, onSlack, onMicrosoft }: { onMicrosoft: () => void; /** Slack chosen: its own steps take over. */ onSlack: () => void; house: WorkspaceView; ready: boolean; existing?: GoogleConnectionView; onClose: () => void }) {
  const [step, setStep] = useState(existing ? 1 : 0);
  const [type, setType] = useState<ConnectorType>("google");
  const [services, setServices] = useState<GoogleService[]>(existing?.services ?? ["gmail", "drive", "calendar"]);
  const [pets, setBots] = useState<string[]>(existing?.pets ?? []);
  const [access, setAccess] = useState<"read" | "write">(existing && !existing.writable.length ? "read" : "write");
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: existing ? `Reconnect ${existing.email}` : step === 0 ? "Add connector" : "Connect Google",
        step: `connector-${step}`,
        confirmLabel: step === 0 ? "Next" : "Continue to Google",
        busyLabel: "Opening Google…",
        back: step === 1 && !existing ? () => setStep(0) : undefined,
        onConfirm: async () => {
          if (step === 0) {
            if (type === "slack") { onSlack(); return "stay"; }
            if (type === "microsoft") { onMicrosoft(); return "stay"; }
            setStep(1);
            return "stay";
          }
          if (!ready) throw new Error("Google isn't set up on this host: use an official release, or give a source build its own OAuth client.");
          if (!services.length) throw new Error("Choose at least one service.");
          const { url } = await api.connectGoogle(house.name, services, pets, access === "write");
          window.location.assign(url);
          return "stay";
        },
        children:
          step === 0 ? (
            <ChoiceList
              label="What to connect"
              value={type}
              onChange={(value) => setType(value as ConnectorType)}
              options={CONNECTOR_TYPES.map((t) => ({ value: t.id, label: t.label, description: t.description, icon: <ConnectorMark type={t.id} /> }))}
            />
          ) : (
            <>
              <p className="dialog-text">
                {existing
                  ? "Sign in to this account again. Your choices here replace its services and bot access."
                  : "Choose what to share, then pick the account on Google's page. Add more accounts the same way; each keeps its own access."}
              </p>
              {!ready && (
                <p className="error" role="alert">
                  Google isn't set up on this host.
                </p>
              )}
              <ChoiceList label="Access" value={access} onChange={(value) => setAccess(value as "read" | "write")} options={[...ACCESS]} />
              <FormGroup title="Services">
                <SwitchList label="Google services" options={SERVICES.map((s) => ({ value: s.id, label: s.label, description: s[access] }))} on={services} onToggle={(id) => setServices(toggle(services, id as GoogleService))} />
              </FormGroup>
              <FormGroup title="Bot access">
                <SwitchList label="Bot access" options={sharable(house)} on={pets} onToggle={(id) => setBots(toggle(pets, id))} />
                <p className="hint">Optional: with none, the account stays private until you grant access.</p>
              </FormGroup>
              <p className="hint">
                Tokens stay on this host; what a bot reads goes to its AI provider and chat.{" "}
                <a className="text-link" href={PRIVACY} target="_blank" rel="noreferrer">
                  Privacy Policy ↗
                </a>
              </p>
            </>
          ),
      }}
    />
  );
}

/** Which bots may use one account; Google's take effect on a bot's next request, Slack's at once. */
function BotAccess({ house, title, body, pets: initial, onClose, save }: { house: WorkspaceView; title: string; body: string; pets: string[]; onClose: () => void; save: (pets: string[]) => Promise<void> }) {
  const [pets, setBots] = useState(initial);
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: `Bot access: ${title}`,
        body,
        confirmLabel: "Save access",
        busyLabel: "Saving…",
        onConfirm: () => save(pets),
        children: (
          <>
            <SwitchList label="Bot access" options={sharable(house)} on={pets} onToggle={(id) => setBots(toggle(pets, id))} />
            <p className="hint">Sideworkers get their parent's access. Scouts never have any.</p>
          </>
        ),
      }}
    />
  );
}
