import { useCallback, useEffect, useState } from "react";
import { Boxes, FlaskConical, Globe, KeyRound, Wrench } from "lucide-react";
import { houseFeatures } from "../../src/core/house-features";
import { NAME_PATTERN } from "../../src/core/names";
import { envProblem } from "../../src/core/secrets";
import type { WorkspaceView } from "../api";
import { capabilityApi, type CapabilityDetailView, type CapabilityDraftView, type CapabilityInput, type CapabilityTemplate, type CapabilityView } from "../scout-api";
import { capabilityPath, workspacePath, navigate, scoutPath } from "../router";
import { Dialog, useDialog } from "./dialog";
import { ChoiceList, SelectField, TextField } from "./fields";
import { Cell, Cluster, List, ListRow, Page, Panel, Section, Stack, Tabs } from "./layout";
import { Link } from "./link";
import { MarkdownEditor } from "./markdown-editor";
import { AddForm } from "./section";
import { SkillsPage } from "./skills";

type Notify = (text: string, warning?: boolean) => void;

/** "3 min ago", "2 h ago", "4 days ago". */
export const ago = (at: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  const days = Math.floor(minutes / 1440);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};
/** A capability's kind in words, as a tag: a tool does not limit its scouts' network; access does. */
export const kindTag = (kind: CapabilityView["kind"]) => <span className={kind === "access" ? "tag busy" : "tag"}>{kind === "access" ? "Access" : "Tool"}</span>;
const networkWords = (network: CapabilityInput["network"]) => network.any ? "Any host" : `Only ${network.allow.join(", ")}`;

/** The Scouts page's tabs: the scouts (and their runs), and the capabilities they are built from. */
export function ScoutsTabs({ house, current, count }: { house: string; current: "scouts" | "capabilities"; /** How many capabilities. */ count?: number }) {
  return <Tabs label="Scouts" items={[
    { label: "Scouts", href: workspacePath(house, "scouts"), current: current === "scouts" },
    { label: "Capabilities", href: workspacePath(house, "capabilities"), current: current === "capabilities", ...(count === undefined ? {} : { count }) },
  ]} />;
}

/** The workspace's capabilities: what its scouts can be made of; bots' drafts waiting on top. */
export function CapabilitiesPage({ house, refresh, notify }: { house: WorkspaceView; refresh: () => Promise<void>; notify: Notify }) {
  const [view, setView] = useState<{ capabilities: CapabilityView[]; drafts: CapabilityDraftView[] }>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState<CapabilityDraftView>();
  const enabled = houseFeatures(house).scouts;
  const load = useCallback(async () => { setView(await capabilityApi.list(house.name)); setError(undefined); }, [house.name]);
  useEffect(() => { if (enabled) void load().catch((e: Error) => setError(e.message)); }, [load, enabled]);
  if (!enabled) return <Page title="Scouts"><p className="hint">Scouts are off in this workspace. <Link href={workspacePath(house.name, "settings")} className="text-link">Turn them on in Settings</Link></p></Page>;
  const fresh = view?.drafts.filter(draft => !view.capabilities.some(capability => capability.name === draft.capability)) ?? [];
  return (
    <Page title="Scouts" actions={<button type="button" className="btn primary" onClick={() => setAdding(true)}>+ New capability</button>}>
      <ScoutsTabs house={house.name} current="capabilities" count={view?.capabilities.length} />
      {error && <p className="error" role="alert">{error}</p>}
      {fresh.length > 0 && (
        <Section title="New from bots" hint="Proposed capabilities. Nothing exists until you apply one.">
          <List>
            {fresh.map(draft => (
              <ListRow key={draft.id} actions={<button type="button" className="btn small" onClick={() => setReviewing(draft)}>Review</button>}>
                <Cell lines><span className="strong mono">{draft.capability}</span><span className="hint">from {petTitle(house, draft.pet)} · {ago(draft.at)}{draft.definition.description ? ` · ${draft.definition.description}` : ""}</span></Cell>
              </ListRow>
            ))}
          </List>
        </Section>
      )}
      <Section hint="The bricks scouts are built from: software installed at the start of every run, skills, network and keys. A scout ticks the ones it needs. Each change is a revision.">
        {!view ? <p className="hint">Loading…</p> : (
          <List columns="minmax(0, 1fr) auto minmax(0, 0.9fr) minmax(0, 0.8fr) auto" head={view.capabilities.length ? ["Capability", "Kind", "Network", "Used by", ""] : undefined} empty="No capabilities yet. Start from a template: browser, media, developer tools, Heroku CLI.">
            {view.capabilities.map(capability => {
              const draft = view.drafts.find(each => each.capability === capability.name);
              return (
                <ListRow key={capability.name} actions={<>{draft && <span className="tag busy">Draft</span>}<Link href={capabilityPath(house.name, capability.name)} className="btn small">Open</Link></>}>
                  <Cell lines>
                    <Link href={capabilityPath(house.name, capability.name)} className="strong mono row-link ellipsis">{capability.name}</Link>
                    <span className="hint clamp-two">{capability.description || "No description"}</span>
                  </Cell>
                  <Cell label="Kind">{kindTag(capability.kind)}</Cell>
                  <Cell label="Network"><span className="hint ellipsis">{networkWords(capability.network)}{capability.keys.length ? ` · ${capability.keys.length} ${capability.keys.length === 1 ? "key" : "keys"}` : ""}</span></Cell>
                  <Cell label="Used by"><span className="hint ellipsis">{capability.usedBy.length ? capability.usedBy.map(scout => <span key={scout}>{scout === capability.usedBy[0] ? "" : ", "}<Link href={scoutPath(house.name, scout)} className="row-link">{scout}</Link></span>) : "—"}</span></Cell>
                </ListRow>
              );
            })}
          </List>
        )}
      </Section>
      {adding && <NewCapabilityDialog house={house.name} taken={view?.capabilities.map(c => c.name) ?? []} onClose={() => setAdding(false)} created={async name => { await refresh(); navigate(capabilityPath(house.name, name)); notify(`Capability ${name} created`); }} />}
      {reviewing && <DraftDialog house={house} draft={reviewing} onClose={() => setReviewing(undefined)} done={async (applied) => { await load(); await refresh(); notify(applied ? `Capability ${reviewing.capability} created` : "Draft discarded"); if (applied) navigate(capabilityPath(house.name, reviewing.capability)); }} />}
    </Page>
  );
}

const petTitle = (house: WorkspaceView, pet: string) => { const found = house.pets.find(each => each.name === pet); return found ? `${found.emoji} ${found.title}` : pet; };

/** A new capability: its name, and a template to start from (or nothing). */
function NewCapabilityDialog({ house, taken, onClose, created }: { house: string; taken: string[]; onClose: () => void; created: (name: string) => Promise<void> }) {
  const [templates, setTemplates] = useState<CapabilityTemplate[]>([]);
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  useEffect(() => { void capabilityApi.templates(house).then(setTemplates, () => {}); }, [house]);
  const chosen = templates.find(each => each.name === template);
  const nameError = name && (!NAME_PATTERN.test(name) ? "Lowercase letters, digits and hyphens, starting with a letter." : taken.includes(name) ? "A capability already uses this name." : undefined);
  return (
    <Dialog onClose={onClose} spec={{
      title: "New capability",
      confirmLabel: "Create capability",
      onConfirm: async () => {
        if (!name.trim() || nameError) throw new Error(nameError || "Name the capability.");
        await capabilityApi.create(house, { name: name.trim(), description: chosen?.description ?? "", install: chosen?.install ?? "", network: chosen?.network ?? { any: true, allow: [] } });
        await created(name.trim());
      },
      children: (
        <>
          <SelectField label="Start from" value={template} onChange={value => { setTemplate(value); if (!name || templates.some(each => each.name === name)) setName(value); }}
            options={[{ value: "", label: "Nothing: an empty script" }, ...templates.map(each => ({ value: each.name, label: each.label }))]} />
          {chosen && <p className="hint">{chosen.description}</p>}
          <p className="hint">No scout has it until you tick it in the scout's Access.</p>
          <TextField label="Name" mono value={name} onChange={setName} error={nameError || undefined} maxLength={31} placeholder="heroku-prod" hint="Scouts and their bots know it by this name." />
        </>
      ),
    }} />
  );
}

/** A bot's draft beside what is in force: field by field, then Apply (a new revision) or Discard. */
function DraftDialog({ house, draft, current, onClose, done }: { house: WorkspaceView; draft: CapabilityDraftView; current?: CapabilityInput; onClose: () => void; done: (applied: boolean) => Promise<void> }) {
  const [error, setError] = useState<string>();
  const fields: [string, string, string][] = [
    ["Description", current?.description ?? "", draft.definition.description],
    ["Install", current?.install ?? "", draft.definition.install],
    ["Network", current ? networkWords(current.network) : "", networkWords(draft.definition.network)],
  ];
  const changed = fields.filter(([, before, after]) => before !== after);
  return (
    <Dialog onClose={onClose} spec={{
      title: `Draft from ${petTitle(house, draft.pet)}: ${draft.capability}`,
      wide: true,
      confirmLabel: current ? "Apply as new revision" : "Create capability",
      onConfirm: async () => { await capabilityApi.applyDraft(house.name, draft.id); await done(true); },
      children: (
        <Stack gap={4}>
          <p className="hint">{ago(draft.at)}. The install script runs as root in every scout that has this capability: read it before applying. Run Test install afterwards.</p>
          {changed.length === 0 && <p className="hint">Nothing differs from what is in force.</p>}
          {changed.map(([label, before, after]) => (
            <div key={label} className="stack gap-2">
              <span className="strong">{label}</span>
              {current && <><span className="hint">Now</span><pre className="command-output">{before || "(empty)"}</pre></>}
              <span className="hint">{current ? "Proposed" : "Proposed"}</span>
              <pre className="command-output">{after || "(empty)"}</pre>
            </div>
          ))}
          {draft.needsKeys.length > 0 && <p className="hint">Needs keys you add after applying: {draft.needsKeys.map(key => <code key={key}>{key} </code>)}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <Cluster><button type="button" className="text-btn" onClick={() => void capabilityApi.discardDraft(house.name, draft.id).then(() => done(false), (e: Error) => setError(e.message))}>Discard draft</button></Cluster>
        </Stack>
      ),
    }} />
  );
}

/**
 * A capability: what it is, its install script, its network, its keys, its skills and its history. One Save makes a
 * new revision of description, install and network; keys are added and removed on their own (each a secret).
 */
export function CapabilityPage({ house, name, refresh, notify }: { house: WorkspaceView; name: string; refresh: () => Promise<void>; notify: Notify }) {
  const [view, setView] = useState<CapabilityDetailView>();
  const [error, setError] = useState<string>();
  const [form, setForm] = useState<CapabilityInput>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [host, setHost] = useState("");
  const [addingKey, setAddingKey] = useState(false);
  const [reviewing, setReviewing] = useState<CapabilityDraftView>();
  const [duplicating, setDuplicating] = useState(false);
  const dialog = useDialog();
  const load = useCallback(async () => {
    const next = await capabilityApi.detail(house.name, name);
    setView(next); setError(undefined);
    setForm(current => current ?? { name: next.capability.name, description: next.capability.description, install: next.capability.install, network: next.capability.network });
    return next;
  }, [house.name, name]);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  if (!houseFeatures(house).scouts) return <Page title={name}><p className="hint">Scouts are off in this workspace. <Link href={workspacePath(house.name, "settings")} className="text-link">Turn them on in Settings</Link></p></Page>;
  if (!view || !form) return <Page title={name}>{error ? <p className="error" role="alert">{error}</p> : <p className="hint">Loading…</p>}</Page>;
  const capability = view.capability;
  const saved = { description: capability.description, install: capability.install, network: capability.network };
  const dirty = JSON.stringify({ description: form.description, install: form.install, network: form.network }) !== JSON.stringify(saved);
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true); setError(undefined);
    try { const revision = await capabilityApi.save(house.name, form); setForm(undefined); await load(); notify(`Saved as r${revision.rev}`); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setTesting(true); setError(undefined);
    try { const result = await capabilityApi.test(house.name, name); await load(); setShowLog(!result.ok); notify(result.ok ? `Install works (${result.seconds} s)` : "Install failed", !result.ok); }
    catch (e) { setError((e as Error).message); }
    finally { setTesting(false); }
  };
  const last = capability.lastTest;
  const draft = view.drafts[0];
  return (
    <Page title={<span className="mono">{name}</span>} back={capability.owner ? { href: scoutPath(house.name, capability.owner, "access"), label: capability.ownerTitle ?? capability.owner } : { href: workspacePath(house.name, "capabilities"), label: "Capabilities" }} actions={
      <>
        <button type="button" className="btn" disabled={testing || dirty} title={dirty ? "Save first: the test runs what is saved" : undefined} onClick={() => void test()}>
          <FlaskConical size={15} strokeWidth={1.75} aria-hidden /> {testing ? "Testing…" : "Test install"}
        </button>
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </>
    }>
      {error && <p className="error" role="alert">{error}</p>}
      {capability.owner && <p className="hint">The own setup of scout <Link href={scoutPath(house.name, capability.owner, "access")} className="text-link">{capability.ownerTitle ?? capability.owner}</Link>: no other scout and no bot can use it. It goes when the scout is deleted.</p>}
      {draft && (
        <div className="bot-off" role="status">
          <span className="bot-state"><span className="dot busy" /> Draft</span>
          <span className="bot-off-text">From {petTitle(house, draft.pet)}, {ago(draft.at)}. Nothing changes until you apply it.</span>
          <button type="button" className="btn small" onClick={() => setReviewing(draft)}>Review</button>
        </div>
      )}
      <div className="stats">
        <Stat icon={Boxes} label="Kind" value={capability.kind === "access" ? "Access" : "Tool"} sub={capability.kind === "access" ? "limits its scouts' network" : "does not limit the network"} />
        {capability.owner
          ? <Stat icon={Wrench} label="Own setup of" value={1} sub={capability.owner} links={[scoutPath(house.name, capability.owner, "access")]} />
          : <Stat icon={Wrench} label="Used by" value={capability.usedBy.length} sub={capability.usedBy.join(", ") || "no scout yet: tick it in a scout's Access"} links={capability.usedBy.map(scout => scoutPath(house.name, scout, "access"))} />}
        <Stat icon={FlaskConical} label="Last test" value={last ? (last.ok ? "Passed" : "Failed") : "—"} sub={last ? `${ago(last.at)} · ${last.seconds} s` : "never tested"} warn={!!last && !last.ok} />
      </div>
      <Section width="narrow" title="Description" hint="What it gives a scout, and which variables it uses. Bots read it.">
        <TextField label="Description" hideLabel value={form.description} onChange={description => setForm({ ...form, description })} placeholder="Heroku CLI for prod: logs, config, pg:psql (HEROKU_API_KEY)" />
      </Section>
      <Section title="Install" hint="Bash, run as root at the start of every run of a scout that has it. Fetch software with package managers; pin versions here if needed.">
        <div className="script short">
          <header className="skills-doc-head">
            <div className="skills-doc-title"><span>install.sh</span><span className={dirty ? "skills-doc-state unsaved" : "skills-doc-state"}>{dirty ? "Unsaved" : `Saved · r${view.history[0]?.rev ?? 1}`}</span></div>
          </header>
          <div className="skills-doc-body">
            <MarkdownEditor value={form.install} onChange={install => setForm({ ...form, install })} onSave={() => void save()} markdownFile={false} />
          </div>
          <footer className="skills-doc-foot">
            <span><kbd>⌘</kbd><kbd>S</kbd> saves a revision</span>
            {last ? (
              <span>
                <span className={`dot ${last.ok ? "idle" : "danger"}`} /> Last test {last.ok ? "passed" : "failed"} {ago(last.at)}{" "}
                <button type="button" className="text-btn plain" onClick={() => setShowLog(!showLog)}>{showLog ? "Hide log" : "Log"}</button>
              </span>
            ) : <span>Not tested yet</span>}
          </footer>
        </div>
        {showLog && last && <pre className="command-output">{last.output || "(no output)"}</pre>}
      </Section>
      <Section width="narrow" title="Network">
        <ChoiceList label="Hosts" value={form.network.any ? "any" : "only"} onChange={value => setForm({ ...form, network: { any: value === "any", allow: form.network.allow } })} options={[
          { value: "any", label: "Any host", description: "A tool: it does not limit the network of the scouts that have it." },
          { value: "only", label: "Only these hosts", description: "Access: a scout with it reaches only the hosts of its capabilities. Add the hosts the install script downloads from too." },
        ]} />
        {!form.network.any && (
          <>
            <AddForm addLabel="Add host" ready={!!host.trim()} onAdd={() => {
              const value = host.trim().toLowerCase();
              if (!/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/.test(value)) throw new Error("Use a host or host:port.");
              if (form.network.allow.includes(value)) throw new Error("Already there.");
              setForm({ ...form, network: { any: false, allow: [...form.network.allow, value] } }); setHost("");
            }}>
              <TextField label="Host" hideLabel mono value={host} onChange={setHost} placeholder="api.heroku.com or db.example.com:5432" />
            </AddForm>
            <List empty="No hosts yet: name at least one.">
              {form.network.allow.map(entry => (
                <ListRow key={entry} actions={<button type="button" className="text-btn" onClick={() => setForm({ ...form, network: { any: false, allow: form.network.allow.filter(each => each !== entry) } })}>Remove</button>}>
                  <Cell mono>{entry}</Cell>
                </ListRow>
              ))}
            </List>
          </>
        )}
      </Section>
      <Section width="narrow" title="Keys" hint="Secrets this capability brings, kept only for it: never a bot's. Added and removed at once, not with Save." actions={<button type="button" className="btn small" onClick={() => setAddingKey(true)}>+ Add key</button>}>
        <List empty="No keys.">
          {capability.keyVariables.map(key => (
            <ListRow key={key.secret} actions={
              <>
                {key.via === "vm" && <span className="tag danger">Inside its VM</span>}
                <button type="button" className="text-btn" onClick={() => dialog.open({ title: `Remove key ${key.secret}?`, body: "The secret is deleted. New runs no longer get it.", confirmLabel: "Remove key", danger: true, onConfirm: async () => { await capabilityApi.removeKey(house.name, name, key.secret); await load(); notify(`Key ${key.secret} removed`); } })}>Remove</button>
              </>
            }>
              <Cell lines><span className="mono">{key.secret}</span><span className="hint">{key.via === "vm" ? <>Real value in <span className="mono">${key.env}</span></> : <>Through the gateway: a placeholder in <span className="mono">${key.env}</span></>}</span></Cell>
            </ListRow>
          ))}
        </List>
      </Section>
      <SkillsPage house={house.name} capability={name} title={name} notify={notify} />
      <Section width="narrow" title="History" hint="Every save is a revision. Restoring one makes it the newest.">
        <List>
          {view.history.map((revision, index) => (
            <ListRow key={revision.rev} actions={index === 0 ? <span className="tag">Current</span> : <button type="button" className="text-btn plain" onClick={() => dialog.open({ title: `Restore r${revision.rev}?`, body: "Its description, install script and network become a new revision. Keys stay as they are.", confirmLabel: `Restore r${revision.rev}`, onConfirm: async () => { await capabilityApi.restore(house.name, name, revision.rev); setForm(undefined); await load(); notify(`Restored r${revision.rev}`); } })}>Restore</button>}>
              <Cell lines>
                <span><span className="strong">r{revision.rev}</span> · {revision.summary}</span>
                <span className="hint">{ago(revision.at)} · {revision.author.kind === "owner" ? "you" : `${petTitle(house, revision.author.pet)}'s draft`}{revision.from ? ` · copied from ${revision.from.capability} r${revision.from.rev}` : ""}</span>
              </Cell>
            </ListRow>
          ))}
        </List>
      </Section>
      {!capability.owner && <Section>
        <Panel>
          <Cluster justify="between">
            <Stack gap={1}><strong>Duplicate</strong><span className="hint">A copy under a new name, without keys: for another account of the same service.</span></Stack>
            <button type="button" className="btn small" onClick={() => setDuplicating(true)}>Duplicate…</button>
          </Cluster>
        </Panel>
      </Section>}
      {!capability.owner && <Section>
        <Panel>
          <Cluster justify="between">
            <Stack gap={1}><strong>Delete capability</strong><span className="hint">{capability.usedBy.length ? `In scouts ${capability.usedBy.join(", ")}: untick it there first.` : "Its history, skills and test results go. Its keys stay, kept for no one."}</span></Stack>
            <button type="button" className="btn danger small" disabled={capability.usedBy.length > 0} onClick={() => dialog.open({ title: `Delete ${name}?`, body: "Its history, skills and test results are removed.", confirmLabel: "Delete capability", danger: true, onConfirm: async () => { await capabilityApi.remove(house.name, name); await refresh(); navigate(workspacePath(house.name, "capabilities")); } })}>Delete…</button>
          </Cluster>
        </Panel>
      </Section>}
      {addingKey && <KeyDialog capability={capability} onClose={() => setAddingKey(false)} save={async key => { await capabilityApi.addKey(house.name, name, key); await load(); notify(`Key ${key.secret} added`); }} />}
      {reviewing && <DraftDialog house={house} draft={reviewing} current={saved && { name, ...saved }} onClose={() => setReviewing(undefined)} done={async applied => { setForm(undefined); await load(); notify(applied ? "Draft applied as a new revision" : "Draft discarded"); }} />}
      {duplicating && <DuplicateDialog house={house.name} name={name} onClose={() => setDuplicating(false)} done={async copy => { await refresh(); navigate(capabilityPath(house.name, copy)); notify(`Copied to ${copy}`); }} />}
      {dialog.element}
    </Page>
  );
}

/** A tile on a capability's page; links go to the scouts that use it. */
function Stat({ icon: Icon, label, value, sub, warn, links }: { icon: typeof Globe; label: string; value: string | number; sub: string; warn?: boolean; links?: string[] }) {
  return (
    <div className="stat">
      <span className="stat-label"><Icon size={14} strokeWidth={1.75} aria-hidden />{label}</span>
      <span className="stat-value">{value}</span>
      <span className={warn ? "stat-sub error" : "stat-sub"}>{links?.length ? sub.split(", ").map((part, i) => <span key={part}>{i ? ", " : ""}<Link href={links[i]!} className="text-link">{part}</Link></span>) : sub}</span>
    </div>
  );
}

/** A key for a capability: a new secret, kept for it alone, its value given once here. */
function KeyDialog({ capability, onClose, save }: { capability: CapabilityView; onClose: () => void; save: (key: { secret: string; value: string; hosts: string[]; via: "gateway" | "vm"; env: string }) => Promise<void> }) {
  const [secret, setSecret] = useState(`${capability.name}-key`);
  const [value, setValue] = useState("");
  const [env, setEnv] = useState("");
  const [via, setVia] = useState<"gateway" | "vm">("gateway");
  const [hosts, setHosts] = useState(capability.network.allow.map(entry => entry.replace(/:443$/, "")).join(", "));
  const envError = env ? envProblem(env.trim()) : undefined;
  return (
    <Dialog onClose={onClose} spec={{
      title: `Add a key to ${capability.name}`,
      confirmLabel: "Add key",
      onConfirm: async () => {
        if (!NAME_PATTERN.test(secret.trim())) throw new Error("Name: lowercase letters, digits and hyphens.");
        if (!value.trim()) throw new Error("Give the key's value.");
        if (!env.trim() || envError) throw new Error(envError ? `Variable: ${envError}` : "Name the variable it goes in.");
        const list = hosts.split(/[\s,]+/).map(host => host.trim()).filter(Boolean);
        if (!list.length) throw new Error("Name the hosts it is for.");
        await save({ secret: secret.trim(), value: value.trim(), hosts: list, via, env: env.trim() });
      },
      children: (
        <>
          <ChoiceList label="How the scout gets it" value={via} onChange={value => setVia(value as "gateway" | "vm")} options={[
            { value: "gateway", label: "Through the gateway", description: "A placeholder in the variable; Household puts the value in HTTPS headers to its hosts. For HTTP APIs: the scout never holds it." },
            { value: "vm", label: "Inside its VM", description: "The real value in the variable. Needed by database clients and some CLIs; a tricked scout could disclose it." },
          ]} />
          <TextField label="Variable" mono value={env} onChange={setEnv} placeholder="HEROKU_API_KEY" error={envError || undefined} />
          <TextField label="Value" mono value={value} onChange={setValue} placeholder="hrku-…" hint="Kept by Household; only scouts with this capability get it." />
          <TextField label="Hosts" mono value={hosts} onChange={setHosts} placeholder="api.heroku.com" hint="Where it is used (comma-separated)." />
          <TextField label="Secret name" mono value={secret} onChange={setSecret} hint="How Household Settings lists it." />
        </>
      ),
    }} />
  );
}

function DuplicateDialog({ house, name, onClose, done }: { house: string; name: string; onClose: () => void; done: (copy: string) => Promise<void> }) {
  const [copy, setCopy] = useState(`${name}-2`);
  return (
    <Dialog onClose={onClose} spec={{
      title: `Duplicate ${name}`,
      confirmLabel: "Duplicate",
      onConfirm: async () => {
        if (!NAME_PATTERN.test(copy.trim())) throw new Error("Lowercase letters, digits and hyphens, starting with a letter.");
        await capabilityApi.duplicate(house, name, copy.trim()); await done(copy.trim());
      },
      children: <TextField label="New name" mono value={copy} onChange={setCopy} hint="Description, install script and network are copied; keys are not." />,
    }} />
  );
}

