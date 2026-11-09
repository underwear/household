import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { capabilityApi } from "../scout-api";
import { api, type AllowView, type SecretFields, type SecretView } from "../api";
import { DEFAULT_SECRET_HEADER, SECRET_PRESETS, envProblem, secretHost, secretPlaceholder } from "../../src/core/secrets";
import { covers, parseAllowEntry } from "../../src/core/network-policy";
import { workspacePath } from "../router";
import { Dialog, useDialog } from "./dialog";
import { CheckList, ChoiceList, TextField } from "./fields";
import { masked } from "./keys";
import { Cell, FormGrid, List, ListRow, Page, Section } from "./layout";
import { Link } from "./link";
import { RowActions, written } from "./section";

type Notify = (text: string, warning?: boolean) => void;

/** «github.com, api.github.com» as the hosts a form sends. */
const hostsOf = (text: string) => text.split(/[\s,]+/).map((host) => host.trim()).filter(Boolean);

/** A secret's hosts the workspace's network does not let its bots reach (the gateway never sees those requests). */
export function blockedHosts(hosts: readonly string[], allow: readonly AllowView[]): string[] {
  const entries = allow.flatMap(({ host }) => parseAllowEntry(host) ?? []);
  return hosts.filter((host) => {
    const target = secretHost(host);
    return !("problem" in target) && !entries.some((entry) => covers(entry, target));
  });
}

/** «github.com +3»: the first host, and how many more (all of them on hover). */
function HostsLine({ hosts }: { hosts: string[] }) {
  return (
    <span className="ellipsis" title={hosts.join("\n")}>
      <span className="mono">{hosts[0]}</span>
      {hosts.length > 1 && <span className="faint"> +{hosts.length - 1}</span>}
    </span>
  );
}

/**
 * Workspace · Secrets: the owner's own tokens (GitHub, npm, …). Bots hold a placeholder in a variable;
 * the gateway puts the value in its place, in one header, only on requests to the secret's hosts.
 */
export function SecretsPage({ house, allow, noteMax, refresh, notify }: { house: string; /** The workspace's network, to flag hosts bots cannot reach. */ allow: AllowView[]; noteMax?: number; refresh: () => Promise<void>; notify: Notify }) {
  const [secrets, setSecrets] = useState<SecretView[]>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<{ secret?: SecretView; preset?: string }>();
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
  const allowHosts = (secret: SecretView, hosts: string[]) =>
    dialog.open({
      title: hosts.length === 1 ? `Allow ${hosts[0]}?` : `Allow ${hosts.length} hosts?`,
      body: (
        <>
          Bots in {house} cannot reach {hosts.length === 1 ? "this host" : "these hosts"} yet, so {secret.name} is never used there.
          {hosts.length > 1 && <span className="id key-value"> {hosts.join(", ")}</span>}
        </>
      ),
      confirmLabel: "Allow",
      safe: true,
      onConfirm: async () => {
        const warning = await written(api.allowHosts(house, hosts));
        await refresh();
        notify(warning ?? (hosts.length === 1 ? `${hosts[0]} allowed` : `${hosts.length} hosts allowed`), warning !== undefined);
      },
    });
  const empty = secrets ? (
    <span>
      No secrets yet. Start from{" "}
      {SECRET_PRESETS.map(({ id, label }, index) => (
        <span key={id}>
          {index > 0 && (index === SECRET_PRESETS.length - 1 ? " or " : ", ")}
          <button type="button" className="text-btn plain text-link" onClick={() => setEditing({ preset: id })}>{label}</button>
        </span>
      ))}
      .
    </span>
  ) : "Loading…";
  return (
    <Page title="Secrets" actions={<button type="button" className="btn primary" onClick={() => setEditing({})}>+ Add secret</button>}>
      <Section hint="Your own tokens for this workspace. Bots hold a placeholder; the gateway swaps in the value only on requests to the hosts you name, so the token never enters a VM.">
        {error && <p className="error" role="alert">{error}</p>}
        <List columns="minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) auto" empty={empty}>
          {(secrets ?? []).map((secret) => {
            const scoped = secret.onlyForCapabilities;
            const blocked = scoped === undefined ? blockedHosts(secret.hosts, allow) : [];
            return (
              <ListRow
                key={secret.name}
                actions={
                  <>
                    <button type="button" className="text-btn plain" onClick={() => reveal(secret)}>Reveal</button>
                    <RowActions onEdit={() => setEditing({ secret })} onRemove={() => remove(secret)} />
                  </>
                }
              >
                <Cell lines>
                  <span className="strong ellipsis">{secret.name}</span>
                  {secret.note ? <span className="muted ellipsis" title={secret.note}>{secret.note}</span> : <span className="id">{masked(secret.value)}</span>}
                </Cell>
                <Cell label="Who gets it" lines>
                  {scoped === undefined ? (
                    <>
                      <span className="mono ellipsis">{secret.env}</span>
                      <span className="faint">every bot</span>
                    </>
                  ) : (
                    <>
                      <span className="ellipsis" title={scoped.join(", ")}>{scoped.length ? `Scouts with ${scoped.join(", ")}` : "No one"}</span>
                      <span className="faint">{scoped.length ? "capability only" : "kept, not given out"}</span>
                    </>
                  )}
                </Cell>
                <Cell label="Sent to" lines>
                  <HostsLine hosts={secret.hosts} />
                  {blocked.length > 0 ? (
                    <span className="hint danger secret-blocked">
                      <TriangleAlert size={13} strokeWidth={2} aria-hidden />
                      {blocked.length === secret.hosts.length ? "Not allowed in " : `${blocked.length} not allowed in `}
                      <Link href={workspacePath(house, "network")} className="text-link">Network</Link>
                      <span aria-hidden>·</span>
                      <button type="button" className="text-btn plain text-link" onClick={() => allowHosts(secret, blocked)}>Allow</button>
                    </span>
                  ) : (
                    <span className="faint">in {secret.header === DEFAULT_SECRET_HEADER ? "Authorization" : <span className="mono">{secret.header}</span>}</span>
                  )}
                </Cell>
              </ListRow>
            );
          })}
        </List>
      </Section>
      {editing && (
        <SecretDialog
          house={house}
          allow={allow}
          taken={(secrets ?? []).map(({ name }) => name)}
          noteMax={noteMax}
          secret={editing.secret}
          preset={editing.preset}
          onClose={() => setEditing(undefined)}
          save={(name, fields) => (editing.secret ? save(api.updateSecret(house, name, fields), `Secret ${name} saved`) : save(api.addSecret(house, name, fields), `Secret ${name} added`))}
        />
      )}
      {dialog.element}
    </Page>
  );
}

/** No preset: the form starts empty. */
const CUSTOM = "";
/** What a preset's tokens start with, as the value's placeholder. */
const VALUE_HINTS: Record<string, string> = { github: "ghp_…", npm: "npm_…", huggingface: "hf_…" };

/**
 * A secret's form: a preset (new ones) fills its hosts and variable; then its name, variable, value and hosts;
 * who gets it (every bot, or only scouts with some capabilities); a note, and the header under «Advanced».
 * Gateway rules update immediately; placeholder variables refresh at the next VM start.
 */
export function SecretDialog({ house, allow, taken = [], noteMax, secret, preset: initialPreset, onClose, save }: { house: string; /** The workspace's network, to flag hosts bots cannot reach. */ allow?: AllowView[]; /** The names already in use. */ taken?: string[]; noteMax?: number; secret?: SecretView; /** A new one's preset, chosen from the empty list. */ preset?: string; onClose: () => void; save: (name: string, fields: SecretFields) => Promise<void> }) {
  const start = SECRET_PRESETS.find(({ id }) => id === initialPreset);
  const [capabilities, setCapabilities] = useState<{ name: string }[]>();
  const [capabilityError, setCapabilityError] = useState<string>();
  useEffect(() => { let active = true; capabilityApi.list(house).then(view => { if (active) setCapabilities(view.capabilities); }, e => { if (active) setCapabilityError(e.message); }); return () => { active = false; }; }, [house]);
  const [preset, setPreset] = useState(start?.id ?? CUSTOM);
  const [name, setName] = useState(secret?.name ?? start?.id ?? "");
  const [value, setValue] = useState(secret?.value ?? "");
  const [hosts, setHosts] = useState(secret?.hosts.join(", ") ?? start?.hosts.join(", ") ?? "");
  const [env, setEnv] = useState(secret?.env ?? start?.env ?? "");
  const [header, setHeader] = useState(secret?.header ?? DEFAULT_SECRET_HEADER);
  const [note, setNote] = useState(secret?.note ?? "");
  const [audience, setAudience] = useState<"bots" | "capabilities">(secret?.onlyForCapabilities ? "capabilities" : "bots");
  const [onlyFor, setOnlyFor] = useState<string[]>(secret?.onlyForCapabilities ?? []);
  const choose = (chosen: string) => {
    setPreset(chosen);
    const found = SECRET_PRESETS.find(({ id }) => id === chosen);
    if (!found) return;
    setHosts(found.hosts.join(", "));
    setEnv(found.env);
    if (!name || SECRET_PRESETS.some(({ id }) => id === name)) setName(found.id);
  };
  const envError = env && envProblem(env.trim());
  const hostList = hostsOf(hosts);
  const nameError = !secret && taken.includes(name.trim()) ? `${name.trim()} already exists in ${house}.` : undefined;
  const blocked = allow && audience === "bots" ? blockedHosts(hostList, allow) : [];
  const placeholder = secretPlaceholder(name.trim() || "name");
  // Restricting is offered when the workspace has capabilities (or the secret already is restricted).
  const variableField = <TextField label="Variable" mono value={env} onChange={setEnv} placeholder="GITHUB_TOKEN" error={envError || undefined} hint={audience === "bots" ? "Where bots find it." : "Where scouts find it."} />;
  const canRestrict = audience === "capabilities" || (capabilities?.length ?? 0) > 0;
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: secret ? `Edit secret ${secret.name}` : "Add secret",
        wide: true,
        confirmLabel: secret ? "Save" : "Add secret",
        onConfirm: async () => {
          if (nameError) throw new Error(nameError);
          if (envError) throw new Error(`Variable: ${envError}`);
          await save(name.trim(), { onlyForCapabilities: audience === "capabilities" ? onlyFor : null, value: value.trim(), hosts: hostList, env: env.trim(), header: header.trim() || null, note: note.trim() || null });
        },
        children: (
          <>
            {!secret && (
              <div className="field">
                <span className="field-label">Start from</span>
                <div className="segmented wide" role="group" aria-label="Start from">
                  {[{ id: CUSTOM, label: "Custom" }, ...SECRET_PRESETS].map(({ id, label }) => (
                    <button key={id} type="button" aria-pressed={preset === id} onClick={() => choose(id)}>{label}</button>
                  ))}
                </div>
              </div>
            )}
            {secret ? variableField : (
              <FormGrid>
                <TextField label="Name" mono value={name} onChange={setName} placeholder="github" error={nameError} />
                {variableField}
              </FormGrid>
            )}
            <TextField label="Value" mono value={value} onChange={setValue} placeholder={VALUE_HINTS[preset] ?? "The token"} />
            <TextField label="Hosts" mono value={hosts} onChange={setHosts} placeholder="github.com, api.github.com" hint="Exact hosts, comma-separated."
              warning={blocked.length > 0 && <>Not allowed in Network: {blocked.join(", ")}. Bots cannot reach {blocked.length === 1 ? "it" : "them"} until you allow {blocked.length === 1 ? "it" : "them"}.</>} />
            {canRestrict && (
              <ChoiceList
                label="Who gets it"
                value={audience}
                onChange={(chosen) => setAudience(chosen as "bots" | "capabilities")}
                options={[
                  { value: "bots", label: "Every bot in this workspace", description: "As a placeholder in its variable." },
                  { value: "capabilities", label: "Only scouts with a capability", description: "Bots and sideworkers never get it, not even as a placeholder." },
                ]}
              />
            )}
            {audience === "capabilities" && (
              <CheckList label="Capabilities" checked={onlyFor} options={(capabilities ?? []).map(({ name }) => ({ value: name, label: <span className="mono">{name}</span> }))} onToggle={name => setOnlyFor(previous => previous.includes(name) ? previous.filter(s => s !== name) : [...previous, name])} empty={capabilities ? "No capabilities in this workspace." : "Loading…"} />
            )}
            {capabilityError && <p className="error">Could not load capabilities: {capabilityError}</p>}
            <TextField label="Note" hint="Only you see this." value={note} onChange={setNote} maxLength={noteMax} />
            <details className="field-help disclosure">
              <summary>
                <ChevronRight size={14} aria-hidden className="field-help-chevron" />
                Advanced
              </summary>
              <TextField label="Header" mono value={header} onChange={setHeader} hint="Where the gateway swaps the placeholder for the value, Basic credentials included." />
            </details>
            <p className="check-note info">
              <ArrowRightLeft size={14} strokeWidth={2} aria-hidden />
              {audience === "capabilities" ? (
                <span>{onlyFor.length ? <>Only scouts with {onlyFor.join(", ")} get it.</> : "No one gets it until you tick a capability."} Easier: add keys on the capability’s own page.</span>
              ) : (
                <span>
                  Bots get {env.trim() ? <code>{env.trim()}={placeholder}</code> : "a placeholder in its variable"}. On requests to {hostList.length ? <code>{hostList[0]}</code> : "its hosts"}
                  {hostList.length > 1 && ` and ${hostList.length - 1} more`}, the gateway puts the value in its place.
                  {" "}Works right away{(!secret || secret.env !== env.trim()) && <>; {secret ? "the new variable" : "the variable"} reaches bots at their next VM start</>}.
                </span>
              )}
            </p>
          </>
        ),
      }}
    />
  );
}
