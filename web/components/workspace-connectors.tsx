import { SlackConnections } from "./slack-connectors";
import { useEffect, useState } from "react";
import { CalendarDays, Files, Mail } from "lucide-react";
import { api, type GoogleConnectionView, type GoogleConnectorsView, type GoogleService, type WorkspaceView } from "../api";
import { workspacePath, redirect } from "../router";
import { Dialog, useDialog } from "./dialog";
import { ChoiceList, FormGroup, SwitchList } from "./fields";
import { Cell, List, ListRow, Page, Section } from "./layout";
import { relative } from "./bot-crons";

/** What can be connected: the first step of Add connector, and an account's mark and name in the list. */
export const CONNECTOR_TYPES = [{ id: "google", label: "Google", description: "Gmail, Drive and Calendar.", mark: "G" }, { id: "slack", label: "Slack", description: "Search and read conversations on demand.", mark: "S" }] as const;
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
 * A workspace's Connectors page: the outside accounts its bots may read (Google for now), each with its own bot access.
 * Adding one is a dialog of two steps (type, then the provider's form) that ends on the provider's sign-in page.
 */
export function WorkspaceConnectors({ house, notify }: { house: WorkspaceView; notify: (text: string, warning?: boolean) => void }) {
  const [slackAdding, setSlackAdding] = useState(false);
  const [view, setView] = useState<GoogleConnectorsView>();
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<{ existing?: GoogleConnectionView }>();
  const [access, setAccess] = useState<GoogleConnectionView>();
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
  const pets = new Map(house.pets.map((pet) => [pet.name, pet]));
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
        {error && (
          <p className="error" role="alert">
            {error}{" "}
            <button className="text-btn plain" onClick={() => void refresh()}>
              Retry
            </button>
          </p>
        )}
        <List columns="minmax(0, 1fr) minmax(0, 180px) auto" empty={view ? "No Google accounts connected. Add a connector and choose its bot access." : error ? undefined : "Loading…"}>
          {connections.map((c) => (
            <ListRow
              key={c.id}
              actions={
                <>
                  <button className="text-btn plain" onClick={() => setAccess(c)}>
                    Bot access
                  </button>
                  <button className={c.needsReconnect ? "btn small" : "text-btn plain"} onClick={() => setSetup({ existing: c })}>
                    Reconnect
                  </button>
                  <button className="text-btn" onClick={() => disconnect(c)}>
                    Disconnect
                  </button>
                </>
              }
            >
              <Cell>
                <ConnectorMark type="google" />
                <span className="cell-lines">
                  <span className="strong connector-email">{c.email}</span>
                  <span className="faint">Google · {servicesWords(c.services)} · {accessWords(c)}</span>
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
          ))}
        </List>
      </Section>
      <SlackConnections key={house.name} house={house} adding={slackAdding} onClose={() => setSlackAdding(false)} notify={notify} />
      {setup && <ConnectorSetup onSlack={() => { setSetup(undefined); setSlackAdding(true); }} house={house} ready={!!view?.ready} existing={setup.existing} onClose={() => setSetup(undefined)} />}
      {access && (
        <BotAccess
          key={access.id}
          house={house}
          connection={access}
          onClose={() => setAccess(undefined)}
          save={async (names) => {
            await api.shareGoogle(house.name, access.id, names);
            await refresh();
            notify("Bot access saved");
          }}
        />
      )}
      {dialog.element}
    </Page>
  );
}

/** The bots an account can be shared with: sideworkers follow their parent, so they are not listed. */
const sharable = (house: WorkspaceView) => house.pets.filter((p) => !p.sideworker).map((p) => ({ value: p.name, label: `${p.emoji ?? "🤖"} ${p.title}` }));

/**
 * Add connector, in two steps: what to connect, then the provider's form (services and bots), which leaves for its
 * sign-in page. Reconnecting an account starts at the form, with that account's choices.
 */
function ConnectorSetup({ house, ready, existing, onClose, onSlack }: { onSlack: () => void; house: WorkspaceView; ready: boolean; existing?: GoogleConnectionView; onClose: () => void }) {
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
            if (type === "slack") { onSlack(); return; }
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

/** Which bots may use one account; takes effect on their next request, no restart. */
function BotAccess({ house, connection: c, onClose, save }: { house: WorkspaceView; connection: GoogleConnectionView; onClose: () => void; save: (pets: string[]) => Promise<void> }) {
  const [pets, setBots] = useState(c.pets);
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: `Bot access: ${c.email}`,
        body: `${servicesWords(c.services)}, ${accessWords(c)}. Changes apply on a bot's next request, no restart.`,
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
