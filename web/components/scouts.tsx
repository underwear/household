import { useCallback, useEffect, useState } from "react";
import { Compass } from "lucide-react";
import { gib, type HostCapacity } from "../../src/core/resources";
import { houseFeatures } from "../../src/core/house-features";
import { NAME_PATTERN } from "../../src/core/names";
import type { AgentView, HouseView, KeyView } from "../api";
import {
  scoutApi,
  type CapabilityView,
  type ScoutAgent,
  type ScoutDefinition,
  type ScoutDetailView,
  type ScoutLimits,
  type ScoutListView,
  type ScoutRunView,
  type ScoutView,
} from "../scout-api";
import { capabilityPath, housePath, navigate, petPath, scoutPath, type ScoutTab } from "../router";
import { Dialog, useDialog } from "./dialog";
import { CheckList, ChoiceList, FormGroup, StepperField, TextField } from "./fields";
import { FeatureOff } from "./house";
import { Cell, Cluster, FormGrid, List, ListRow, Page, Panel, Section, Stack, Tabs } from "./layout";
import { Link } from "./link";
import { keysFor, useAgentForm } from "./pets";
import { SkillPreview } from "./skills";
import { ScoutDocumentEditor } from "./scout-editor";
import { ScoutsTabs, kindTag } from "./capabilities";

type Notify = (text: string, warning?: boolean) => void;
const done = (run: ScoutRunView) => ["done", "failed", "cancelled"].includes(run.status);
const networkLabel = (network: ScoutView["network"]) =>
  network.open ? "Open internet" : `Only ${network.allow.length} ${network.allow.length === 1 ? "host" : "hosts"}`;
const ago = (value?: string) => {
  if (!value) return "Not started";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
};

/** A run's state for people: a dot's tone and a word (its outcome once it is over). */
export function runState(run: ScoutRunView): { tone: string; label: string } {
  if (run.status === "waiting_approval") return { tone: "busy", label: "Waiting for approval" };
  if (run.status === "waiting_owner") return { tone: "busy", label: "Waiting for you" };
  if (run.status === "running") return { tone: "busy", label: "Working" };
  if (run.status === "cancelled") return { tone: "off", label: "Stopped" };
  if (run.outcome === "success" || (run.status === "done" && !run.outcome)) return { tone: "idle", label: "Succeeded" };
  if (run.outcome === "blocked") return { tone: "busy", label: "Blocked" };
  if (run.outcome === "failed" || run.status === "failed") return { tone: "danger", label: "Failed" };
  return { tone: "busy", label: run.status.replaceAll("_", " ") };
}

/** How long a run took: "40 s", "15 min", "1 h 5 min". */
const took = (run: ScoutRunView) => {
  if (!run.startedAt || !run.endedAt) return undefined;
  const seconds = Math.max(1, Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
};

type Resources = { cpus: number; memoryMiB: number };
/** What a scout runs on, in words: "opus · 2 vCPU · 2 GiB". */
const runtimeWords = (agent: ScoutAgent | null | undefined, r: Resources) =>
  `${agent ? agent.model ?? agent.agent : "no agent"} · ${r.cpus} vCPU · ${gib(r.memoryMiB)}`;

interface ScoutPageProps {
  house: HouseView;
  agents: AgentView[];
  keys: KeyView[];
  refresh: () => Promise<void>;
  notify: Notify;
}

const OFF_TEXT = "Pets cannot call scouts. Scouts and capabilities stay here.";

/** The house's scouts, capabilities, runs, agent and limit, polled while the page is open. */
function useScouts(house: HouseView, initial?: ScoutListView) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string>();
  const enabled = houseFeatures(house).scouts;
  const load = useCallback(async () => { setView(await scoutApi.list(house.name)); setError(undefined); }, [house.name]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const poll = () => scoutApi.list(house.name).then(
      next => { if (active) { setView(next); setError(undefined); } },
      e => active && setError(e.message),
    );
    void poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [house.name, enabled]);
  return { view, error, load, enabled };
}

/**
 * Scouts: the specialists pets call by name, each set up here like a skill; what runs now, and what ran. The house's
 * limit and the agent of scouts that set none are one dialog (Settings).
 */
export function ScoutsPage({ house, agents, keys, host, refresh, notify, initial }: ScoutPageProps & { host?: HostCapacity; initial?: ScoutListView }) {
  const { view, error, load, enabled } = useScouts(house, initial);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const [all, setAll] = useState(false);
  if (!enabled) return <Page title="Scouts"><FeatureOff house={house.name} text={OFF_TEXT} /></Page>;
  const running = (view?.runs ?? []).filter(run => !done(run));
  const ended = (view?.runs ?? []).filter(done);
  const shown = all ? ended : ended.slice(0, 5);
  const agentless = view && !view.agent ? view.scouts.filter(scout => !scout.agent) : [];
  return (
    <Page title="Scouts" actions={<><button type="button" className="btn" disabled={!view} onClick={() => setSettings(true)}>Settings</button><button type="button" className="btn primary" onClick={() => setAdding(true)}>+ New scout</button></>}>
      <ScoutsTabs house={house.name} current="scouts" count={view?.capabilities.length} />
      {error && <p className="error" role="alert">{error}</p>}
      {agentless.length > 0 && (
        <div className="banner danger" role="alert">
          {agentless.map(scout => scout.title ?? scout.name).join(", ")} {agentless.length === 1 ? "has" : "have"} no agent: pets cannot call {agentless.length === 1 ? "it" : "them"}. <button type="button" className="text-btn" onClick={() => setSettings(true)}>Choose one in Settings</button>
        </div>
      )}
      {!view ? !error && <p className="hint">Loading…</p> : (
        <>
          {running.length > 0 ? (
            <Section title="Running" hint={`${running.length} of ${view.limits.maxScouts} at once.`}>
              <ScoutRuns house={house.name} pets={house.pets} runs={running} scouts={view.scouts} running refresh={load} />
            </Section>
          ) : (
            <Section><p className="blank-line"><span><span className="dot off" /> None running · up to {view.limits.maxScouts} at once</span></p></Section>
          )}
          <Section>
            {view.scouts.length === 0 ? (
              <div className="skills-blank">
                <Compass size={28} aria-hidden />
                <strong>No scouts</strong>
                <p className="hint">A scout is a specialist your pets call by name: instructions, capabilities and keys of its own. Pets pick one by its description.</p>
                <button type="button" className="btn" onClick={() => setAdding(true)}>+ New scout</button>
              </div>
            ) : (
              <ul className="pet-cards">
                {view.scouts.map(scout => <li key={scout.name}><ScoutCard house={house.name} scout={scout} runs={view.runs.filter(run => run.blueprint === scout.name)} /></li>)}
              </ul>
            )}
          </Section>
          {ended.length > 0 && (
            <Section title="Recent runs" actions={ended.length > 5 && <button type="button" className="text-btn" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${ended.length}`}</button>}>
              <ScoutRuns house={house.name} pets={house.pets} runs={shown} scouts={view.scouts} showScout refresh={load} />
            </Section>
          )}
        </>
      )}
      {adding && (
        <ScoutDialog capabilities={view?.capabilities ?? []} taken={[...(view?.scouts.map(s => s.name) ?? []), ...(view?.capabilities.map(c => c.name) ?? [])]} onClose={() => setAdding(false)}
          save={async (scout, own) => {
            await scoutApi.create(house.name, scout);
            if (own) await scoutApi.createOwn(house.name, scout.name);
            await refresh(); navigate(scoutPath(house.name, scout.name, "access")); notify("Scout created");
          }} />
      )}
      {settings && view && (
        <ScoutSettingsDialog view={view} agents={agents} keys={keysFor(keys, house.name)} host={host} onClose={() => setSettings(false)}
          save={async (limits, agent) => {
            await scoutApi.setLimits(house.name, limits);
            if (agent) await scoutApi.setAgent(house.name, agent);
            await load(); await refresh(); notify("Scout settings saved");
          }} />
      )}
    </Page>
  );
}

/** A scout's card: who it is, what it is made of (its own setup first), its network, and its last run. */
export function ScoutCard({ house, scout, runs = [] }: { house: string; scout: ScoutView; runs?: ScoutRunView[] }) {
  const last = runs.find(run => run.startedAt) ?? runs[0];
  const state = last && runState(last);
  return (
    <Link href={scoutPath(house, scout.name)} className="pet-card">
      <span className="pet-card-head">
        <span className="avatar large" aria-hidden>{scout.emoji ?? "🧭"}</span>
        {state && <span className="pet-card-state"><span className={`dot ${state.tone}`} />{done(last!) ? ago(last!.startedAt) : state.label}</span>}
      </span>
      <Stack gap={1}>
        <span className="strong ellipsis">{scout.title ?? scout.name}</span>
        <span className="hint clamp-two">{scout.description}</span>
      </Stack>
      <span className="cluster gap-1">
        {scout.own && <span className="tag">own setup</span>}
        {scout.capabilities.map(name => <span key={name} className="tag mono">{name}</span>)}
        {!scout.own && scout.capabilities.length === 0 && <span className="hint">No capabilities</span>}
      </span>
      <span className="hint">
        {networkLabel(scout.network)}
        {scout.keysInVm.length > 0 && <> · <span className="busy">{scout.keysInVm.length} {scout.keysInVm.length === 1 ? "key" : "keys"} in its VM</span></>}
        {` · ${runs.length ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}` : "no runs"}`}
      </span>
      {scout.problems.length > 0 && <span className="error">{scout.problems[0]}</span>}
    </Link>
  );
}

/** Who a run was: its scout (linked), or the capabilities an earlier pet assembled it from. */
function RunScout({ house, run, scouts }: { house: string; run: ScoutRunView; scouts: Pick<ScoutDefinition, "name" | "title" | "emoji">[] }) {
  const scout = run.blueprint ? scouts.find(s => s.name === run.blueprint) : undefined;
  if (run.blueprint) return <Link className="strong ellipsis row-link" href={scoutPath(house, run.blueprint)}>{scout?.title ?? run.blueprint}</Link>;
  return <span className="ellipsis" title={run.capabilities.join(", ")}><span className="strong">Scout</span> <span className="hint">{run.capabilities.join(", ")}</span></span>;
}

export function ScoutRuns({
  house,
  pets = [],
  runs,
  scouts,
  running = false,
  showScout = false,
  refresh,
}: {
  house: string;
  /** The house's pets, to name the one that called each run. */
  pets?: HouseView["pets"];
  runs: ScoutRunView[];
  scouts: Pick<ScoutDefinition, "name" | "title" | "emoji">[];
  running?: boolean;
  /** Runs of several scouts: a column names each run's scout. */
  showScout?: boolean;
  refresh: () => Promise<void>;
}) {
  const dialog = useDialog();
  const [report, setReport] = useState<ScoutRunView>();
  const stop = (run: ScoutRunView) =>
    dialog.open({
      title: "Stop this scout?",
      body: "Its VM and temporary access will be removed. The run remains in history.",
      confirmLabel: "Stop scout",
      danger: true,
      onConfirm: async () => { await scoutApi.stop(house, run.id); await refresh(); },
    });
  const scoutColumn = !running && showScout;
  return (
    <>
      <List
        columns={scoutColumn ? "auto minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.6fr) auto auto" : "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.6fr) auto auto"}
        head={running ? ["Scout", "Called by", "Task", "Started", ""] : scoutColumn ? ["Started", "Scout", "Called by", "Task", "Outcome", ""] : ["Started", "Called by", "Task", "Outcome", ""]}
        empty={running ? "None running." : "No runs yet."}
      >
        {runs.map(run => {
          const scout = run.blueprint ? scouts.find(s => s.name === run.blueprint) : undefined;
          const state = runState(run);
          const parent = pets.find(pet => pet.name === run.parent);
          return (
            <ListRow
              key={run.id}
              actions={running ? (
                <button type="button" className="btn small" onClick={() => stop(run)}>Stop…</button>
              ) : (
                <>
                  {run.report && <button className="text-btn plain" onClick={() => setReport(run)}>Report</button>}
                  {run.threadUrl && <a className="text-link" href={run.threadUrl} target="_blank" rel="noreferrer">Open thread</a>}
                </>
              )}
            >
              {running ? (
                <Cell>
                  <span className="avatar" aria-hidden>{scout?.emoji ?? "🧭"}</span>
                  <span className="cell-lines">
                    <RunScout house={house} run={run} scouts={scouts} />
                    <span className="hint"><span className={`dot ${state.tone}`} /> {state.label}</span>
                  </span>
                </Cell>
              ) : (
                <Cell lines>
                  <span title={run.startedAt}>{ago(run.startedAt)}</span>
                  {took(run) && <span className="hint">took {took(run)}</span>}
                </Cell>
              )}
              {scoutColumn && <Cell label="Scout"><RunScout house={house} run={run} scouts={scouts} /></Cell>}
              <Cell label="Called by">
                <Link className="row-link ellipsis" href={petPath(house, run.parent)}>{parent?.title ?? run.parent}</Link>
              </Cell>
              <Cell label="Task"><span className="ellipsis" title={run.task}>{run.task}</span></Cell>
              <Cell label={running ? "Started" : "Outcome"}>
                {running ? <span title={run.startedAt}>{ago(run.startedAt)}</span> : <span className="hint"><span className={`dot ${state.tone}`} /> {state.label}</span>}
              </Cell>
            </ListRow>
          );
        })}
      </List>
      {report && (
        <Dialog onClose={() => setReport(undefined)} spec={{ title: "Scout report", confirmLabel: "Done", onConfirm: async () => {}, children: <SkillPreview content={report.report ?? ""} parseFrontmatter={false} /> }} />
      )}
      {dialog.element}
    </>
  );
}

const agentValue = ({ agent, key, model, mode, reasoningEffort }: ReturnType<typeof useAgentForm>["value"]): ScoutAgent =>
  ({ agent, key: key ?? "", ...(model ? { model } : {}), ...(mode ? { mode } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
/** The agent form's starting values: a stored agent with its adapter's defaults filled in. */
const agentStart = (agents: AgentView[], agent: ScoutAgent | null | undefined) => {
  if (!agent) return undefined;
  const adapter = agents.find(a => a.name === agent.agent);
  return { agent: agent.agent, key: agent.key, model: agent.model ?? adapter?.defaultModel ?? "", mode: agent.mode ?? adapter?.defaultMode ?? null, reasoningEffort: agent.reasoningEffort ?? null };
};

/** CPU and memory of one scout. It has no time limit: its pet is reminded when it idles, and stops it. */
function ResourceFields({ value, onChange }: { value: { cpus: string; memory: string }; onChange: (next: { cpus: string; memory: string }) => void }) {
  return (
    <FormGrid>
      <StepperField label="CPU" value={value.cpus} onChange={cpus => onChange({ ...value, cpus })} min={1} step={1} unit="vCPU" />
      <StepperField label="Memory" value={value.memory} onChange={memory => onChange({ ...value, memory })} min={512} step={512} unit="MiB" warning={Number(value.memory) < 1024 ? "At least 1 GiB is recommended." : undefined} />
    </FormGrid>
  );
}
const resourceText = (r: Resources) => ({ cpus: String(r.cpus), memory: String(r.memoryMiB) });
const resourceValue = (t: { cpus: string; memory: string }): Resources => ({ cpus: Number(t.cpus), memoryMiB: Number(t.memory) });
const resourcesValid = (r: Resources) => Object.values(r).every(n => Number.isInteger(n) && n >= 1);

/**
 * The house's scout settings: how many run at once (and what that may take of this machine at worst), and the agent
 * and resources of every scout that sets none of its own.
 */
function ScoutSettingsDialog({ view, agents, keys, host, onClose, save }: {
  view: ScoutListView; agents: AgentView[]; keys: KeyView[]; host?: HostCapacity; onClose: () => void;
  save: (limits: ScoutLimits, agent?: ScoutAgent) => Promise<void>;
}) {
  const [max, setMax] = useState(String(view.limits.maxScouts));
  const [text, setText] = useState(resourceText(view.limits));
  const form = useAgentForm(agents, keys, agentStart(agents, view.agent), "scout");
  const [opened] = useState(() => JSON.stringify(agentValue(form.value)));
  const count = Number(max), resources = resourceValue(text);
  // At worst every run is as large as the largest scout.
  const sizes = [resources, ...view.scouts.map(scout => ({ ...resources, ...scout.resources }))];
  const cpus = Math.max(...sizes.map(each => each.cpus)) * (Number.isInteger(count) ? count : 0);
  const memory = Math.max(...sizes.map(each => each.memoryMiB)) * (Number.isInteger(count) ? count : 0);
  const over = host && (cpus > host.cpus || memory > host.memoryMiB);
  return (
    <Dialog onClose={onClose} spec={{
      title: "Scout settings",
      wide: true,
      confirmLabel: "Save",
      onConfirm: async () => {
        if (!Number.isInteger(count) || count < 0) throw new Error("Scouts at once: a whole number.");
        if (!resourcesValid(resources)) throw new Error("CPU and memory must be whole numbers.");
        const agentChanged = !view.agent || JSON.stringify(agentValue(form.value)) !== opened;
        if (agentChanged && form.error) throw new Error(form.error);
        await save({ maxScouts: count, ...resources }, agentChanged ? agentValue(form.value) : undefined);
      },
      children: (
        <>
          <FormGroup title="At once">
            <StepperField label="Scouts at once" hideLabel value={max} onChange={setMax} min={0} step={1} unit="scouts" />
            <p className={over ? "error" : "hint"}>
              At worst {Number.isInteger(count) ? count : 0} × the largest scout: up to {cpus} vCPU and {gib(memory)}{host ? ` of this machine's ${host.cpus} vCPU and ${gib(host.memoryMiB)}` : ""}, beside the pets. A pet's call beyond it is refused.
            </p>
          </FormGroup>
          <FormGroup title="Agent">
            <p className="hint">Every scout runs on it unless it sets its own. A change applies from the next run.</p>
            {form.fields}
          </FormGroup>
          <FormGroup title="Each run">
            <p className="hint">No time limit: a scout runs until it finishes or is stopped. After 30 minutes idle, the pet that called it is reminded and decides.</p>
            <ResourceFields value={text} onChange={setText} />
          </FormGroup>
        </>
      ),
    }} />
  );
}

/** A scout's agent and resources: the house's, or its own. */
function ScoutRuntimeDialog({ scout, defaults, agents, keys, onClose, save }: { scout: ScoutView; defaults: ScoutDetailView["defaults"]; agents: AgentView[]; keys: KeyView[]; onClose: () => void; save: (patch: Partial<ScoutDefinition>) => Promise<void> }) {
  const [mode, setMode] = useState(scout.agent || scout.resources ? "own" : "house");
  const [text, setText] = useState(resourceText({ ...defaults.limits, ...scout.resources }));
  const form = useAgentForm(agents, keys, agentStart(agents, scout.agent ?? defaults.agent), "scout");
  return (
    <Dialog onClose={onClose} spec={{
      title: `What ${scout.title ?? scout.name} runs on`,
      confirmLabel: "Save",
      onConfirm: async () => {
        if (mode === "house") return save({ agent: undefined, resources: undefined });
        if (form.error) throw new Error(form.error);
        const value = resourceValue(text);
        if (!resourcesValid(value)) throw new Error("CPU and memory must be whole numbers.");
        await save({ agent: agentValue(form.value), resources: value });
      },
      children: (
        <>
          <ChoiceList label="Runs on" value={mode} onChange={setMode} options={[
            { value: "house", label: "The house's", description: runtimeWords(defaults.agent, defaults.limits) },
            { value: "own", label: "Its own", description: "An agent, model and resources for this scout only. They show on its launch card." },
          ]} />
          {mode === "own" && <>{form.fields}<ResourceFields value={text} onChange={setText} /></>}
        </>
      ),
    }} />
  );
}

/** A new scout, or its basics edited: who it is and when pets call it; new: shared capabilities and its own setup. */
export function ScoutDialog({
  scout,
  capabilities = [],
  taken,
  onClose,
  save,
}: {
  scout?: ScoutDefinition;
  capabilities?: CapabilityView[];
  taken: string[];
  onClose: () => void;
  save: (value: ScoutDefinition, own: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(scout?.name ?? "");
  const [title, setTitle] = useState(scout?.title ?? "");
  const [emoji, setEmoji] = useState(scout?.emoji ?? "🧭");
  const [description, setDescription] = useState(scout?.description ?? "");
  const [chosen, setChosen] = useState<string[]>(scout?.capabilities ?? []);
  const [own, setOwn] = useState(false);
  const nameError = name && (!NAME_PATTERN.test(name) ? "Lowercase letters, digits and hyphens, starting with a letter." : !scout && taken.includes(name) ? "A scout or capability already uses this name." : undefined);
  return (
    <Dialog onClose={onClose} spec={{
      title: scout ? `Edit ${scout.title ?? scout.name}` : "New scout",
      wide: !scout,
      confirmLabel: scout ? "Save" : "Create scout",
      onConfirm: async () => {
        if (!name.trim() || nameError) throw new Error(nameError || "Name the scout.");
        if (!description.trim()) throw new Error("Describe when pets should call it.");
        await save({
          ...(scout ?? { instructions: "" }),
          name: name.trim(), title: title.trim() || undefined, emoji: emoji.trim() || undefined, description: description.trim(),
          capabilities: scout ? scout.capabilities : chosen,
        }, !scout && own);
      },
      children: (
        <>
          <FormGroup title="Scout">
            {!scout && <TextField label="Name" mono value={name} onChange={setName} error={nameError || undefined} maxLength={31} placeholder="prod-ops" hint="Pets call it by this name." />}
            <FormGrid>
              <TextField label="Title" value={title} onChange={setTitle} placeholder="Prod Ops" />
              <TextField label="Emoji" value={emoji} onChange={setEmoji} />
            </FormGrid>
            <TextField label="Description" value={description} onChange={setDescription} placeholder="Prod incidents through Heroku: logs, config, database" hint="Pets choose a scout by it: it is in their prompt (its first 300 characters). Say when to call it." />
          </FormGroup>
          {!scout && (
            <FormGroup title="Capabilities">
              <CheckList label="Shared ones it has" options={capabilities.map(capability => ({ value: capability.name, label: <>{capability.name} {kindTag(capability.kind)}</> }))} checked={chosen}
                onToggle={value => setChosen(current => current.includes(value) ? current.filter(each => each !== value) : [...current, value])}
                empty="No shared capabilities yet." />
              <label className="check">
                <input type="checkbox" checked={own} onChange={() => setOwn(!own)} />
                <span className="cell-lines"><span>A setup of its own</span><span className="hint">Software, hosts and keys only this scout gets: prod access, an account. You set it up next.</span></span>
              </label>
            </FormGroup>
          )}
        </>
      ),
    }} />
  );
}

/** A scout's page: Overview (what it is and runs on), Instructions, Access (capabilities, own setup, workspace), Runs. */
export function ScoutDetailPage({ house, name, tab = "overview", agents, keys, refresh, notify, initial }: ScoutPageProps & { name: string; tab?: ScoutTab; initial?: ScoutDetailView }) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [runtime, setRuntime] = useState(false);
  const dialog = useDialog();
  const enabled = houseFeatures(house).scouts;
  const load = useCallback(async () => { setView(await scoutApi.detail(house.name, name)); setError(undefined); }, [house.name, name]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const poll = () => scoutApi.detail(house.name, name).then(next => { if (active) { setView(next); setError(undefined); } }, e => active && setError(e.message));
    void poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [house.name, name, enabled]);
  if (!enabled) return <Page title="Scouts"><FeatureOff house={house.name} text={OFF_TEXT} /></Page>;
  const scout = view?.scout;
  const save = async (patch: Partial<ScoutDefinition>) => { await scoutApi.update(house.name, name, patch); await load(); await refresh(); notify("Scout saved"); };
  const back = { href: housePath(house.name, "scouts"), label: "Scouts" };
  if (!scout || !view) return <Page title={name} back={back}>{error ? <p className="error" role="alert">{error}</p> : <p className="hint">Loading…</p>}</Page>;
  const own = !!(scout.agent || scout.resources);
  const effective = { ...view.defaults.limits, ...scout.resources };
  const last = view.runs.find(run => run.startedAt);
  const details: [string, React.ReactNode][] = [
    ["Pets call it", <span className="mono">{scout.name}</span>],
    ["Capabilities", scout.own || scout.capabilities.length ? [...(scout.own ? ["own setup"] : []), ...scout.capabilities].join(", ") : <span className="faint">None</span>],
    ["Network", scout.network.open ? <>Open internet <span className="faint">· no capability limits it</span></> : <>Only {scout.network.allow.join(", ")} <span className="faint">· {scout.network.limitedBy.join(" and ")}</span></>],
    ["Keys in its VM", scout.keysInVm.length ? <span className="busy">{scout.keysInVm.map(key => `$${key.env}`).join(", ")}</span> : <span className="faint">None</span>],
    ["Workspace", scout.workspace ? <span className="mono">{scout.workspace.repo}{scout.workspace.branch ? ` · ${scout.workspace.branch}` : ""}</span> : <span className="faint">An empty folder</span>],
    ["Runs on", <>{runtimeWords(scout.agent ?? view.defaults.agent, effective)} <span className="faint">· {own ? "its own" : "the house's"}</span> <button type="button" className="text-btn" onClick={() => setRuntime(true)}>Change…</button></>],
    ["Last run", last ? <>{ago(last.startedAt)} · {runState(last).label}</> : <span className="faint">Never</span>],
  ];
  return (
    <Page title={<><span className="title-emoji" aria-hidden>{scout.emoji ?? "🧭"}</span>{scout.title ?? scout.name}</>} back={back} actions={<button className="btn" onClick={() => setEditing(true)}>Edit scout…</button>}>
      <Tabs label={`${scout.title ?? scout.name}'s pages`} items={[
        { label: "Overview", href: scoutPath(house.name, name), current: tab === "overview" },
        { label: "Instructions", href: scoutPath(house.name, name, "instructions"), current: tab === "instructions" },
        { label: "Access", href: scoutPath(house.name, name, "access"), current: tab === "access" },
        { label: "Runs", href: scoutPath(house.name, name, "runs"), current: tab === "runs", count: view.runs.length },
      ]} />
      {error && <p className="error" role="alert">{error}</p>}
      {scout.problems.length > 0 && <div className="banner danger" role="alert">{scout.problems.join("; ")}</div>}
      {tab === "overview" && (
        <>
          <Section width="narrow">
            <p className="hint">{scout.description}</p>
            <List columns="minmax(120px, 180px) minmax(0, 1fr)">
              {details.map(([label, value]) => (
                <ListRow key={label}>
                  <Cell><span className="muted">{label}</span></Cell>
                  <Cell>{value}</Cell>
                </ListRow>
              ))}
            </List>
          </Section>
          <Section width="narrow">
            <Panel>
              <Cluster justify="between">
                <Stack gap={1}><strong>Delete scout</strong><span className="hint">{scout.own ? "Its own setup goes with it; shared capabilities stay." : "Shared capabilities stay."} Stop its runs first.</span></Stack>
                <button className="btn danger small" onClick={() => dialog.open({ title: `Delete ${scout.title ?? name}?`, body: scout.own ? "Its instructions and its own setup (history, skills) are removed. Its keys stay, kept for no one." : "Its instructions are removed.", danger: true, confirmLabel: "Delete scout", onConfirm: async () => { await scoutApi.remove(house.name, name); await refresh(); navigate(housePath(house.name, "scouts")); } })}>Delete…</button>
              </Cluster>
            </Panel>
          </Section>
        </>
      )}
      {tab === "instructions" && <ScoutDocumentEditor house={house.name} scout={name} kind="instructions" />}
      {tab === "access" && <ScoutAccess key={JSON.stringify([scout.capabilities, scout.workspace ?? null])} house={house.name} scout={scout} capabilities={view.capabilities} save={save}
        created={async () => { await load(); navigate(capabilityPath(house.name, scout.name)); }} />}
      {tab === "runs" && <Section><ScoutRuns house={house.name} pets={house.pets} runs={view.runs} scouts={[scout]} refresh={load} /></Section>}
      {editing && <ScoutDialog scout={scout} taken={[]} onClose={() => setEditing(false)} save={value => save(value)} />}
      {runtime && <ScoutRuntimeDialog scout={scout} defaults={view.defaults} agents={agents} keys={keysFor(keys, house.name)} onClose={() => setRuntime(false)} save={save} />}
      {dialog.element}
    </Page>
  );
}

/**
 * What a scout can reach: the shared capabilities it ticks, its own setup (its own capability, edited on its page) and
 * the repository it starts in. One Save; the network and keys they make show below, unsaved ticks included.
 */
export function ScoutAccess({ house, scout, capabilities, save, created }: { house: string; scout: ScoutView; capabilities: CapabilityView[]; save: (patch: Partial<ScoutDefinition>) => Promise<void>; created?: () => Promise<void> }) {
  const [chosen, setChosen] = useState(scout.capabilities);
  const [repo, setRepo] = useState(scout.workspace?.repo ?? "");
  const [branch, setBranch] = useState(scout.workspace?.branch ?? "");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const workspace = repo.trim() ? { repo: repo.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) } : undefined;
  const repoError = repo.trim() && !/^https:\/\//.test(repo.trim()) ? "Use an https:// URL" : undefined;
  // In the order the house lists them: their install scripts run in this order, its own setup last.
  const ordered = capabilities.map(capability => capability.name).filter(name => chosen.includes(name));
  const dirty = JSON.stringify(ordered) !== JSON.stringify(capabilities.map(c => c.name).filter(name => scout.capabilities.includes(name))) || JSON.stringify(workspace ?? null) !== JSON.stringify(scout.workspace ?? null);
  const used = [...(scout.own ? [scout.own] : []), ...ordered.flatMap(name => capabilities.filter(capability => capability.name === name))];
  const limiting = used.filter(capability => !capability.network.any);
  let repoHost: string | undefined;
  try { repoHost = workspace && !repoError ? new URL(workspace.repo).hostname : undefined; } catch { repoHost = undefined; }
  const hosts = [...new Set([...limiting.flatMap(capability => capability.network.allow), ...(repoHost ? [repoHost] : [])])];
  const inVm = used.flatMap(capability => capability.keyVariables.filter(key => key.via === "vm").map(key => `$${key.env}`));
  const own = scout.own;
  const submit = () => {
    if (busy || repoError) return;
    setBusy(true); setError(undefined);
    void save({ capabilities: ordered, workspace }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <Section width="narrow" title="Shared capabilities" hint="Their install scripts run at the start of every run, in this order." actions={<Link href={housePath(house, "capabilities")} className="btn small">Manage</Link>}>
        <List empty="This house has no shared capabilities yet.">
          {capabilities.map(capability => (
            <ListRow key={capability.name}>
              <Cell>
                <label className="check grow">
                  <input type="checkbox" checked={chosen.includes(capability.name)} onChange={() => setChosen(current => current.includes(capability.name) ? current.filter(each => each !== capability.name) : [...current, capability.name])} />
                  <span className="cell-lines">
                    <span><Link href={capabilityPath(house, capability.name)} className="mono row-link">{capability.name}</Link> {kindTag(capability.kind)}</span>
                    <span className="hint">{capability.description || "No description"}</span>
                  </span>
                </label>
              </Cell>
            </ListRow>
          ))}
        </List>
      </Section>
      <Section width="narrow" title="Its own setup" hint="Software, hosts and keys only this scout gets: no other scout and no pet can use them.">
        {own ? (
          <List columns="minmax(100px, 140px) minmax(0, 1fr)">
            <ListRow actions={<Link href={capabilityPath(house, own.name)} className="text-btn">Edit</Link>}>
              <Cell><span className="muted">Install</span></Cell>
              <Cell>{own.install.trim() ? <span className="mono">install.sh · {own.install.trim().split("\n").length} lines</span> : <span className="faint">Empty</span>}{own.lastTest && <span className="hint"> · <span className={`dot ${own.lastTest.ok ? "idle" : "danger"}`} /> {own.lastTest.ok ? "passed" : "failed"}</span>}</Cell>
            </ListRow>
            <ListRow actions={<Link href={capabilityPath(house, own.name)} className="text-btn">Edit</Link>}>
              <Cell><span className="muted">Network</span></Cell>
              <Cell>{own.network.any ? "Any host" : <span className="mono ellipsis">{own.network.allow.join(", ")}</span>}</Cell>
            </ListRow>
            <ListRow actions={<Link href={capabilityPath(house, own.name)} className="text-btn">Edit</Link>}>
              <Cell><span className="muted">Keys</span></Cell>
              <Cell>{own.keyVariables.length ? <span className="mono ellipsis">{own.keyVariables.map(key => `$${key.env}`).join(", ")}</span> : <span className="faint">None</span>}</Cell>
            </ListRow>
          </List>
        ) : (
          <p className="blank-line">
            <span>None: it has only shared capabilities.</span>
            <button type="button" className="btn small" disabled={adding} onClick={() => { setAdding(true); setError(undefined); void scoutApi.createOwn(house, scout.name).then(created, (e: Error) => setError(e.message)).finally(() => setAdding(false)); }}>+ Add own setup</button>
          </p>
        )}
      </Section>
      <Section width="narrow" title="Workspace" hint="A repository cloned fresh for every run; the scout starts in it. A private one needs a key through the gateway for its host.">
        <FormGrid>
          <TextField label="Repository" mono value={repo} onChange={setRepo} placeholder="https://github.com/acme/ops.git" error={repoError} hint="Empty: an empty folder." />
          <TextField label="Branch" mono value={branch} onChange={setBranch} placeholder="main" hint="Empty: the default branch." />
        </FormGrid>
      </Section>
      <Section width="narrow">
        <div className="access-result">
          <span>
            <span className="muted">Result: </span>
            {limiting.length === 0 ? "Open internet" : `Only ${hosts.join(", ")}`}
            {" · "}
            {inVm.length ? <span className="busy">{inVm.join(", ")} inside its VM</span> : "no keys inside its VM"}
          </span>
          <button type="submit" className="btn primary" disabled={!dirty || busy || !!repoError}>{busy ? "Saving…" : "Save"}</button>
        </div>
        {limiting.length === 0 && inVm.length > 0 && <div className="banner">This scout holds keys and has the open internet.</div>}
        {error && <p className="error" role="alert">{error}</p>}
      </Section>
    </form>
  );
}
