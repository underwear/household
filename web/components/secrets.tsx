import { useCallback, useEffect, useState } from "react";
import { capabilityApi } from "../scout-api";
import { api, type SecretFields, type SecretView } from "../api";
import { DEFAULT_SECRET_HEADER, SECRET_PRESETS, envProblem, secretPlaceholder } from "../../src/core/secrets";
import { Dialog, useDialog } from "./dialog";
import { CheckList, SelectField, TextField } from "./fields";
import { masked } from "./keys";
import { Cell, List, ListRow, Section } from "./layout";
import { RowActions, written } from "./section";

/**
 * Workspace · Secrets: the owner's own tokens (GitHub, npm, …). Bots hold a placeholder in a variable;
 * the gateway puts the value in its place, in one header, only on requests to the secret's hosts.
 */
export function SecretsSection({ house, noteMax, notify }: { house: string; noteMax?: number; notify: (text: string, warning?: boolean) => void }) {
  const [secrets, setSecrets] = useState<SecretView[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SecretView | "new">();
  const dialog = useDialog();
  const load = useCallback(() => api.secrets(house).then(setSecrets, (e: Error) => setError(e.message)), [house]);
  useEffect(() => void load(), [load]);
  const save = async (write: Promise<unknown>, done: string) => {
    try {
      const warning = await written(write);
      notify(warning ?? done, warning !== undefined);
    } finally {
      await load();
    }
  };
  const remove = (secret: SecretView) =>
    dialog.open({
      title: `Remove secret ${secret.name}?`,
      body: "Bots stop getting it right away. They keep running.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => save(api.removeSecret(house, secret.name), `Secret ${secret.name} removed`),
    });
  const reveal = (secret: SecretView) =>
    dialog.open({ title: `Secret ${secret.name}`, body: <span className="id key-value">{secret.value}</span>, confirmLabel: "Done", onConfirm: async () => {} });
  return (
    <Section
      title="Secrets"
      hint="Tokens for this workspace only. Bots get a placeholder; the gateway swaps in the value only for the hosts you name."
      actions={
        <button className="btn" onClick={() => setEditing("new")}>
          + Add secret
        </button>
      }
    >
      {error && <p className="error" role="alert">{error}</p>}
      <List columns="minmax(0, 1fr) minmax(0, 1.4fr) auto" empty={secrets ? "No secrets." : "Loading…"}>
        {(secrets ?? []).map((secret) => (
          <ListRow
            key={secret.name}
            actions={
              <>
                <button className="text-btn plain" onClick={() => reveal(secret)}>
                  Reveal
                </button>
                <RowActions onEdit={() => setEditing(secret)} onRemove={() => remove(secret)} />
              </>
            }
          >
            <Cell lines>
              <span className="strong ellipsis">{secret.name}</span>{secret.onlyForCapabilities !== undefined ? <span className="tag">{secret.onlyForCapabilities.length ? `Only ${secret.onlyForCapabilities.join(", ")}` : "Kept for no one"}</span> : null}
              <span className="id">{secret.env}</span>
              {secret.note && <span className="hint">{secret.note}</span>}
            </Cell>
            <Cell lines>
              <span className="id ellipsis" title={secret.hosts.join(", ")}>{secret.hosts.join(", ")}</span>
              <span className="muted">
                {masked(secret.value)}
                {secret.header !== DEFAULT_SECRET_HEADER && ` · ${secret.header}`}
              </span>
            </Cell>
          </ListRow>
        ))}
      </List>
      {editing && (
        <SecretDialog
          house={house}
          noteMax={noteMax}
          secret={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          save={(name, fields) => (editing === "new" ? save(api.addSecret(house, name, fields), `Secret ${name} added`) : save(api.updateSecret(house, name, fields), `Secret ${name} saved`))}
        />
      )}
      {dialog.element}
    </Section>
  );
}

/** «github.com, api.github.com» as the hosts a form sends. */
const hostsOf = (text: string) => text.split(/[\s,]+/).map((host) => host.trim()).filter(Boolean);

/**
 * A secret's form: a preset (new ones) fills its hosts and variable; then its name, value, hosts, variable, header,
 * capabilities and note. Gateway rules update immediately; placeholder variables refresh at the next VM start.
 */
export function SecretDialog({ house, noteMax, secret, onClose, save }: { house: string; noteMax?: number; secret?: SecretView; onClose: () => void; save: (name: string, fields: SecretFields) => Promise<void> }) {
  const [capabilities, setCapabilities] = useState<{ name: string }[]>([]);
  const [onlyForScouts, setOnlyForScouts] = useState<string[]>(secret?.onlyForCapabilities ?? []);
  const [scoutError, setScoutError] = useState<string>();
  useEffect(() => { let active = true; capabilityApi.list(house).then(view => { if (active) setCapabilities(view.capabilities); }, e => { if (active) setScoutError(e.message); }); return () => { active = false; }; }, [house]);
  const [preset, setPreset] = useState("");
  const [name, setName] = useState(secret?.name ?? "");
  const [value, setValue] = useState(secret?.value ?? "");
  const [hosts, setHosts] = useState(secret?.hosts.join(", ") ?? "");
  const [env, setEnv] = useState(secret?.env ?? "");
  const [header, setHeader] = useState(secret?.header ?? DEFAULT_SECRET_HEADER);
  const [note, setNote] = useState(secret?.note ?? "");
  const envError = env && envProblem(env.trim());
  const variableChanges = !secret || secret.env !== env.trim();
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: secret ? `Edit secret ${secret.name}` : "Add secret",
        wide: true,
        confirmLabel: secret ? "Save" : "Add secret",
        onConfirm: async () => {
          if (envError) throw new Error(`Variable: ${envError}`);
          await save(name.trim(), { onlyForCapabilities: onlyForScouts.length ? onlyForScouts : (secret?.onlyForCapabilities ? [] : null), value: value.trim(), hosts: hostsOf(hosts), env: env.trim(), header: header.trim() || null, note: note.trim() || null });
        },
        children: (
          <>
            {!secret && (
              <SelectField
                label="Preset"
                value={preset}
                onChange={(chosen) => {
                  setPreset(chosen);
                  const found = SECRET_PRESETS.find(({ id }) => id === chosen);
                  if (!found) return;
                  setHosts(found.hosts.join(", "));
                  setEnv(found.env);
                  if (!name) setName(found.id);
                }}
                options={[{ value: "", label: "Custom" }, ...SECRET_PRESETS.map(({ id, label }) => ({ value: id, label }))]}
              />
            )}
            {!secret && <TextField label="Name" mono value={name} onChange={setName} placeholder="github" />}
            <TextField label="Value" mono value={value} onChange={setValue} placeholder="ghp_…" />
            <TextField label="Hosts" mono value={hosts} onChange={setHosts} placeholder="github.com, api.github.com" hint="Exact hosts, comma-separated. Network access must be allowed separately." />
            <div className="form-grid">
              <TextField label="Variable" mono value={env} onChange={setEnv} placeholder="GITHUB_TOKEN" error={envError || undefined}
                hint={name.trim() ? `Bots get ${secretPlaceholder(name.trim())} here.` : undefined} />
              <TextField label="Header" mono value={header} onChange={setHeader} hint="Where the placeholder is swapped, Basic credentials included." />
            </div>
            <CheckList label="Only for capabilities" checked={onlyForScouts} options={capabilities.map(({ name }) => ({ value: name, label: name }))} onToggle={name => setOnlyForScouts(previous => previous.includes(name) ? previous.filter(s => s !== name) : [...previous, name])} empty="No capabilities in this workspace." />

            {scoutError && <p className="error">Could not load capabilities: {scoutError}</p>}
            <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} maxLength={noteMax} />
            <p className="hint">
              {onlyForScouts.length > 0
                ? "Only scouts with the ticked capabilities get it; bots and sideworkers never do, not even as a placeholder. Easier: add keys on the capability's own page."
                : <>Works right away, no restart.{variableChanges && <> Bots get {env.trim() ? <span className="mono">{env.trim()}</span> : "the variable"} at their next VM start.</>}</>}
            </p>
          </>
        ),
      }}
    />
  );
}
