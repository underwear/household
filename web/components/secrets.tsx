import { useCallback, useEffect, useState } from "react";
import { capabilityApi } from "../scout-api";
import { api, type SecretFields, type SecretView } from "../api";
import { DEFAULT_SECRET_HEADER, SECRET_PRESETS, envProblem, secretPlaceholder } from "../../src/core/secrets";
import { Dialog, useDialog } from "./dialog";
import { CheckList, SelectField, TextField } from "./fields";
import { HousesField, masked } from "./keys";
import { Cell, List, ListRow, Section } from "./layout";
import { RowActions, written } from "./section";

/**
 * Household settings · Secrets: the owner's own tokens (GitHub, npm, …). Pets hold a placeholder in a variable;
 * the gateway puts the value in its place, in one header, only on requests to the secret's hosts.
 */
export function SecretsSection({ houses, noteMax, notify }: { houses: string[]; noteMax?: number; notify: (text: string, warning?: boolean) => void }) {
  const [secrets, setSecrets] = useState<SecretView[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SecretView | "new">();
  const dialog = useDialog();
  const load = useCallback(() => api.secrets().then(setSecrets, (e: Error) => setError(e.message)), []);
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
      body: "Pets stop getting it right away. They keep running.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => save(api.removeSecret(secret.name), `Secret ${secret.name} removed`),
    });
  const reveal = (secret: SecretView) =>
    dialog.open({ title: `Secret ${secret.name}`, body: <span className="id key-value">{secret.value}</span>, confirmLabel: "Done", onConfirm: async () => {} });
  return (
    <Section
      title="Secrets"
      hint="Your own tokens. Pets get a placeholder; the gateway swaps in the value only for the hosts you name."
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
                {masked(secret.value)} · {secret.houses ? secret.houses.join(", ") : "every house"}
                {secret.header !== DEFAULT_SECRET_HEADER && ` · ${secret.header}`}
              </span>
            </Cell>
          </ListRow>
        ))}
      </List>
      {editing && (
        <SecretDialog
          houses={houses}
          noteMax={noteMax}
          secret={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          save={(name, fields) => (editing === "new" ? save(api.addSecret(name, fields), `Secret ${name} added`) : save(api.updateSecret(name, fields), `Secret ${name} saved`))}
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
 * houses and note. Gateway rules update immediately; placeholder variables refresh at the next VM start.
 */
export function SecretDialog({ houses, noteMax, secret, onClose, save }: { houses: string[]; noteMax?: number; secret?: SecretView; onClose: () => void; save: (name: string, fields: SecretFields) => Promise<void> }) {
  const [scouts, setScouts] = useState<{ house: string; name: string; title: string }[]>([]); // the houses' capabilities
  const [onlyForScouts, setOnlyForScouts] = useState<string[]>(secret?.onlyForCapabilities ?? []);
  const [scoutError, setScoutError] = useState<string>();
  useEffect(() => { let active = true; Promise.all(houses.map(async house => ({ house, view: await capabilityApi.list(house).catch(() => ({ capabilities: [] })) }))).then(found => { if (active) setScouts(found.flatMap(({ house, view }) => view.capabilities.map(c => ({ house, name: c.name, title: c.name })))); }, e => active && setScoutError(e.message)); return () => { active = false; }; }, [houses.join("\n")]);
  const [preset, setPreset] = useState("");
  const [name, setName] = useState(secret?.name ?? "");
  const [value, setValue] = useState(secret?.value ?? "");
  const [hosts, setHosts] = useState(secret?.hosts.join(", ") ?? "");
  const [env, setEnv] = useState(secret?.env ?? "");
  const [header, setHeader] = useState(secret?.header ?? DEFAULT_SECRET_HEADER);
  const [only, setOnly] = useState<string[]>(secret?.houses ?? []);
  const [note, setNote] = useState(secret?.note ?? "");
  const envError = env && envProblem(env.trim());
  const variableChanges = !secret || secret.env !== env.trim() || JSON.stringify(secret.houses ?? []) !== JSON.stringify(only);
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: secret ? `Edit secret ${secret.name}` : "Add secret",
        wide: true,
        confirmLabel: secret ? "Save" : "Add secret",
        onConfirm: async () => {
          if (envError) throw new Error(`Variable: ${envError}`);
          if (onlyForScouts.length && !only.length) throw new Error("Choose the house of these capabilities.");
          await save(name.trim(), { onlyForCapabilities: onlyForScouts.length ? onlyForScouts : (secret?.onlyForCapabilities ? [] : null), value: value.trim(), hosts: hostsOf(hosts), env: env.trim(), header: header.trim() || null, houses: only.length ? only : null, note: note.trim() || null });
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
                hint={name.trim() ? `Pets get ${secretPlaceholder(name.trim())} here.` : undefined} />
              <TextField label="Header" mono value={header} onChange={setHeader} hint="Where the placeholder is swapped, Basic credentials included." />
            </div>
            {houses.length > 0 && <HousesField houses={houses} checked={only} onChange={setOnly} />}
            <CheckList label="Only for capabilities" checked={onlyForScouts} options={[...new Set(scouts.filter(s => !only.length || only.includes(s.house)).map(s => s.name))].map(name => ({ value: name, label: scouts.filter(s => s.name === name && (!only.length || only.includes(s.house))).map(s => houses.length > 1 ? `${s.title} (${s.house})` : s.title).join(", ") }))} onToggle={name => setOnlyForScouts(previous => previous.includes(name) ? previous.filter(s => s !== name) : [...previous, name])} empty="No capabilities in the selected houses." />

            {scoutError && <p className="error">Could not load capabilities: {scoutError}</p>}
            <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} maxLength={noteMax} />
            <p className="hint">
              {onlyForScouts.length > 0
                ? "Only scouts with the ticked capabilities get it; pets and sideworkers never do, not even as a placeholder. Easier: add keys on the capability's own page."
                : <>Works right away, no restart.{variableChanges && <> Pets get {env.trim() ? <span className="mono">{env.trim()}</span> : "the variable"} at their next VM start.</>}</>}
            </p>
          </>
        ),
      }}
    />
  );
}
