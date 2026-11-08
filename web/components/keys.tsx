import { useState } from "react";
import { api, type KeyFields, type KeyView, type MeView } from "../api";
import { describeAllowance, resetTime, spentWindow, type Allowance } from "../../src/core/allowance";
import { Dialog, useDialog } from "./dialog";
import { CheckList, SelectField, TextField } from "./fields";
import { Cell, List, ListRow, Section } from "./layout";
import { RowActions, written } from "./section";

/** A key as the list shows it: its first five characters, then two dots; the whole value only on Reveal. */
export const masked = (value: string) => `${value.slice(0, 5)}••`;

export interface KeysSectionProps {
  keys: KeyView[];
  /** The houses a key may be limited to. */
  houses: string[];
  /** The providers a key may be of. */
  providers: MeView["providers"];
  noteMax?: number;
  /** Refetches after a write. */
  refresh: () => Promise<void>;
  notify: (text: string, warning?: boolean) => void;
}

/**
 * Household settings · Keys: the agent-provider keys the pets run on, each with its provider, what kind it is, its value
 * (shown: the owner's own screen), its note and the pets on it; add, edit, remove (not while a pet runs on it).
 */
export function KeysSection({ keys, houses, providers, noteMax, refresh, notify }: KeysSectionProps) {
  const dialog = useDialog();
  /** The key being edited, or "new". */
  const [editing, setEditing] = useState<KeyView | "new">();
  const save = async (write: Promise<unknown>, done: string) => {
    try {
      const warning = await written(write);
      notify(warning ?? done, warning !== undefined);
    } finally {
      await refresh();
    }
  };
  const remove = (key: KeyView) =>
    dialog.open({
      title: `Remove key ${key.name}?`,
      body: key.pets.length > 0 ? `${key.pets.join(", ")} run${key.pets.length > 1 ? "" : "s"} on it: give ${key.pets.length > 1 ? "them" : "it"} another key first.` : "No pet runs on it.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => save(api.removeKey(key.name), `Key ${key.name} removed`),
    });
  const reveal = (key: KeyView) =>
    dialog.open({
      title: `Key ${key.name}`,
      body: <span className="id key-value">{key.value}</span>,
      confirmLabel: "Done",
      onConfirm: async () => {},
    });
  return (
    <Section
      title="Keys"
      hint="Model provider keys your pets run on. Pets never see them."
      actions={
        <button className="btn primary" onClick={() => setEditing("new")}>
          + Add key
        </button>
      }
    >
      <List columns="minmax(0, 1fr) minmax(0, 1.4fr) auto" empty="No keys.">
        {keys.map((key) => (
          <ListRow
            key={key.name}
            actions={
              <>
                <button className="text-btn plain" onClick={() => reveal(key)}>
                  Reveal
                </button>
                <RowActions onEdit={() => setEditing(key)} onRemove={() => remove(key)} />
              </>
            }
          >
            <Cell lines>
              <span className="strong ellipsis">{key.name}</span>
              <span className="muted">
                {key.provider} · {key.kind ?? "unknown kind"}
                {key.houses && ` · ${key.houses.join(", ")} only`}
              </span>
              {key.note && <span className="hint">{key.note}</span>}
            </Cell>
            <Cell lines>
              <span className="id">{masked(key.value)}</span>
              <UsedIn pets={key.pets} />
              <AllowanceLine allowance={key.allowance} allowOverage={key.allowOverage} />
            </Cell>
          </ListRow>
        ))}
      </List>
      {editing && (
        <KeyDialog
          houses={houses}
          providers={providers}
          noteMax={noteMax}
          keyView={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          save={(name, fields) => (editing === "new" ? save(api.addKey(name, fields), `Key ${name} added`) : save(api.updateKey(name, fields), `Key ${name} saved`))}
        />
      )}
      {dialog.element}
    </Section>
  );
}

/**
 * What the provider last said is left of a subscription key («5h 1% · 7d 99% · resets Sun 10:00»), and what happens
 * past it: refused on the gateway, or billed apart when the owner allowed overage. Nothing for a key never read.
 */
function AllowanceLine({ allowance, allowOverage }: { allowance: Allowance | null; allowOverage: boolean }) {
  if (!allowance) return allowOverage ? <span className="hint">Overage allowed: past its allowance, billed apart.</span> : null;
  const spent = spentWindow(allowance, Date.now());
  const next = allowance.windows.filter((window) => window.resetsAt > Date.now()).sort((a, b) => b.utilization - a.utilization)[0];
  return (
    <span className={spent && !allowOverage ? "error" : "hint"} title={`Read ${new Date(allowance.at).toLocaleString()}`}>
      {describeAllowance(allowance)}
      {next && ` · ${spent ? `${spent.name} resets` : "resets"} ${resetTime((spent ?? next).resetsAt)}`}
      {spent ? (allowOverage ? " · used up, going on in overage (billed apart)" : " · used up: requests refused until then") : allowOverage ? " · overage allowed" : ""}
    </span>
  );
}

/** The houses a key is used in, each with its pets on it (`pets`: `house/pet`). */
function UsedIn({ pets }: { pets: string[] }) {
  if (pets.length === 0) return <span className="hint">Not used by any pet.</span>;
  const byHouse = new Map<string, string[]>();
  for (const entry of pets) {
    const [house = "", pet = ""] = entry.split("/");
    byHouse.set(house, [...(byHouse.get(house) ?? []), pet]);
  }
  return (
    <span className="used-in">
      <span className="label">Used in</span>
      {[...byHouse].map(([house, names]) => (
        <span key={house}>
          <span className="strong">{house}</span> · {names.join(", ")}
        </span>
      ))}
    </span>
  );
}

interface KeyDialogProps {
  houses?: string[];
  providers: MeView["providers"];
  noteMax?: number;
  /** The key to edit; none: a new one. */
  keyView?: KeyView;
  onClose: () => void;
  save: (name: string, fields: KeyFields) => Promise<void>;
}

/** A key's form: its name (new keys only), provider, value (in full) and note; the config's errors show in it. */
export function KeyDialog({ houses = [], providers, noteMax, keyView, onClose, save }: KeyDialogProps) {
  const [name, setName] = useState(keyView?.name ?? "");
  const [provider, setProvider] = useState<string>(keyView?.provider ?? providers[0] ?? "");
  const [value, setValue] = useState(keyView?.value ?? "");
  const [note, setNote] = useState(keyView?.note ?? "");
  const [only, setOnly] = useState<string[]>(keyView?.houses ?? []);
  const [allowOverage, setAllowOverage] = useState(keyView?.allowOverage ?? false);
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: keyView ? `Edit key ${keyView.name}` : "Add key",
        confirmLabel: keyView ? "Save" : "Add key",
        onConfirm: () => save(name.trim(), { provider, value: value.trim(), note: note.trim() || null, houses: only.length ? only : null, allowOverage }),
        children: (
          <>
            {!keyView && <TextField label="Name" mono value={name} onChange={setName} placeholder="claude" />}
            <SelectField label="Provider" value={provider} onChange={setProvider} options={providers.map((each) => ({ value: each, label: each }))} />
            <TextField label="Value" mono value={value} onChange={setValue}
              placeholder={provider === "anthropic" ? "sk-ant-oat01-… or sk-ant-api03-…" : provider === "openai" ? "sk-…" : "Key or token"}
              hint={<KeyHelp provider={provider} />}
            />
            <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} placeholder="Max subscription" maxLength={noteMax} />
            {houses.length > 0 && <HousesField houses={houses} checked={only} onChange={setOnly} />}
            <CheckList label="Past its allowance" options={[{ value: "overage", label: "Go on in overage (billed apart from the subscription)" }]}
              checked={allowOverage ? ["overage"] : []} onToggle={() => setAllowOverage((current) => !current)} />
            <p className="hint">{allowOverage ? "Pets keep sending once a subscription window is used up; the provider bills that to credits." : "Off: once a subscription window is used up, the gateway refuses its pets' requests until it resets."}</p>
          </>
        ),
      }}
    />
  );
}


/** Acquisition instructions for the credential formats Household currently accepts. */
function KeyHelp({ provider }: { provider: string }) {
  if (provider === "anthropic")
    return (
      <span className="key-help">
        <span>
          <strong>Claude subscription:</strong> run <code>claude setup-token</code> and paste the token it prints.{" "}
          <a className="text-link" href="https://code.claude.com/docs/en/authentication#generate-a-long-lived-token" target="_blank" rel="noreferrer">
            How
          </a>
        </span>
        <span>
          <strong>API key:</strong> create one in the{" "}
          <a className="text-link" href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">
            Claude Console
          </a>
          .
        </span>
      </span>
    );
  if (provider === "openai")
    return (
      <span className="key-help">
        <span>
          <strong>API key:</strong> create one on the{" "}
          <a className="text-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
            OpenAI Platform
          </a>
          .
        </span>
        <span>
          <strong>ChatGPT subscription:</strong> run <code>house key codex my-chatgpt</code> on the Household machine and sign in; the key shows up here.{" "}
          <a className="text-link" href="https://learn.chatgpt.com/docs/auth?surface=cli#login-on-headless-devices" target="_blank" rel="noreferrer">
            Sign-in help
          </a>
        </span>
      </span>
    );
  return <>Use a key issued by your provider.</>;
}

/** Which houses a key or secret is for; none ticked: every house. */
export function HousesField({ houses, checked, onChange }: { houses: string[]; checked: string[]; onChange: (houses: string[]) => void }) {
  return (
    <>
      <CheckList
        label="Houses"
        options={houses.map((house) => ({ value: house, label: house }))}
        checked={checked}
        onToggle={(house) => onChange(checked.includes(house) ? checked.filter((each) => each !== house) : [...checked, house])}
      />
      <p className="hint">{checked.length === 0 ? "None ticked: every house." : `Only pets in ${checked.join(", ")}.`}</p>
    </>
  );
}
