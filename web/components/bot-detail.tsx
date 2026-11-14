import { BotPreviews } from "./bot-previews";
import { houseFeatures } from "../../src/core/house-features";
import { closeWorkerDialog } from "./bot-sideworkers";
import { BotUsage } from "./bot-monitoring";
import { SkillsPage } from "./skills";
import { BotHarness } from "./bot-harness";
import { LogsDialog } from "./logs";
import { BotResources } from "./bot-resources";
import { BotResourceSummary, useWorkspaceMetrics } from "./bot-resource-summary";
import { BotInstructions } from "./bot-instructions";
import { BotLifecycleTab } from "./bot-lifecycle";
import { BotEnvironment } from "./bot-environment";
import { BotVolumes } from "./volumes";
import { Link } from "./link";
import { BotMemory } from "./bot-memory";
import { CalendarClock, Gauge, MessagesSquare, Pickaxe } from "lucide-react";
import { BotCrons, relative, scheduledCount, useBotCrons, type Run } from "./bot-crons";
import { BotChannels } from "./bot-channels";
import { BotInboxes, useWorkspaceInboxes } from "./workspace-inboxes";
import { Stat } from "./workspace-overview";
import { useEffect, useState } from "react";
import { api, type HarnessView, type WorkspaceView, type KeyView, type BotView, type PlatformView } from "../api";
import { workspacePath, navigate, botPath, type BotTab } from "../router";
import { useDialog } from "./dialog";
import { Cell, Cluster, List, ListRow, Page, Panel, Section, Stack, Tabs } from "./layout";
import { petState, workersOf } from "./bot-state";
import { DisableDialog, RestartDialog, harnessLabel, modeLabel, BotDialog, type Capacity } from "./bots";
import { gib, petResources } from "../../src/core/resources";
import { TerminalDialog } from "./terminal";
import { written } from "./section";

/** The tabs a sideworker's page has. */
const WORKER_TABS: BotTab[] = ["overview", "skills", "memory", "resources"];

/** How a scheduled task's last run went, in a word, on the overview's tile. */
const RUN_WORDS: Record<Run["status"], string> = { received: "queued", dispatching: "sending", delivered: "running", answered: "replied", failed: "failed" };

export interface BotDetailPageProps {
  house: WorkspaceView;
  pet: BotView;
  /** Which of its tabs: what it is (and removing it), or its scheduled tasks. */
  tab?: BotTab;
  agents: HarnessView[];
  keys: KeyView[];
  /** The host and every workspace's bots: what its Resources tab weighs its CPU and RAM against. */
  capacity: Capacity;
  /** The platforms (their icons, by the channels). */
  platforms?: PlatformView[];
  refresh: () => Promise<void>;
  notify: (text: string, warning?: boolean) => void;
}

/**
 * A bot's page: its title and what is done to it (Console, Restart, Edit its names) over its tabs: Overview (at a
 * glance: its channels, scheduled tasks and resources; its state, what it runs, disabling and removing it), Harness
 * (what runs it), Channels, Tasks, …, and Resources (what its VM uses and is given).
 */
export function BotDetailPage({ house, pet, tab = "overview", agents, keys, capacity, platforms = [], refresh, notify }: BotDetailPageProps) {
  // A sideworker's page: what it is and does, read-only; what runs it, its channels and its tasks are its parent's.
  const worker = pet.sideworker;
  const parent = worker && house.pets.find((each) => each.name === worker.parent);
  if (worker && !WORKER_TABS.includes(tab)) tab = "overview";
  const workers = workersOf(house.pets, pet.name);
  // "1 running · 1 busy": each state its workers are in, by how many.
  const workerStates = Object.entries(Object.groupBy(workers, (each) => petState(each.state).label)).map(([state, list]) => `${list!.length} ${state.toLowerCase()}`).join(" · ");
  const crons = useBotCrons(house.name, pet.name, !worker);
  const inboxes = useWorkspaceInboxes(house.name, !worker);
  const channels = house.channels.filter((channel) => channel.pets.includes(worker?.parent ?? pet.name));
  const defaults = channels.filter((channel) => channel.default === pet.name || channel.pets.length === 1).length;
  const next = crons.view?.jobs.filter((job) => job.state === "scheduled").sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  const last = crons.view?.runs[0];
  const samples = useWorkspaceMetrics(house.name);
  const [disabling, setDisabling] = useState(false);
  const [toggling, setToggling] = useState(false);
  const enabled = pet.enabled !== false;
  const [editing, setEditing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [consoleBot, setConsoleBot] = useState<string>();
  const [logsOpen, setLogsOpen] = useState(false);
  const terminal = agents.find((agent) => agent.name === pet.agent)?.terminal === true;
  const identity = `${house.name}/${pet.name}/${pet.agent}`;
  useEffect(() => setConsoleBot(undefined), [identity]);
  const dialog = useDialog();
  const { tone, label } = petState(pet.state);
  const remove = () =>
    dialog.open({
      title: `Remove ${pet.display}?`,
      body: "Its VM goes and it leaves its channels. Its files stay on disk.",
      confirmLabel: "Remove bot",
      danger: true,
      onConfirm: async () => {
        const warning = await written(api.removeBot(house.name, pet.name));
        navigate(workspacePath(house.name, "bots"));
        await refresh();
        notify(warning ?? `${pet.display} removed`, warning !== undefined);
      },
    });
  /** Back on: its VM starts again (disabling asks how, in DisableDialog). */
  const enable = async () => {
    setToggling(true);
    try {
      const warning = await written(api.updateBot(house.name, pet.name, { enabled: true }));
      await refresh();
      notify(warning ?? `${pet.title} enabled`, warning !== undefined);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setToggling(false);
    }
  };
  // Code-like values (ids) in mono; the words people read in the text's face.
  const details: [name: string, value: string, mono: boolean][] = [
    ...(worker ? [["Working directory", worker.cwd, true] as [string, string, boolean]] : []),
    ...(worker?.branch ? [["Branch", worker.branch, true] as [string, string, boolean]] : []),
    ["Name", pet.name, true],
    ["Configured CPU", `${petResources(pet).cpus} vCPU${petResources(pet).cpus === 1 ? "" : "s"}`, false],
    ["Configured RAM", gib(petResources(pet).memoryMiB), false],
    ["Harness", harnessLabel(pet.agent), false],
    ["Model", pet.model, true],
    ["Reasoning effort", pet.reasoningEffort ?? "Default", !!pet.reasoningEffort],
    ...(pet.mode ? [["Permission mode", modeLabel(agents, pet.agent, pet.mode), false] as [string, string, boolean]] : []),
    // The harness's own settings the config sets, by the harness's words for them (an unknown one by its key).
    ...Object.entries(pet.settings).map(([key, value]) => [agents.find(({ name }) => name === pet.agent)?.settings.find((setting) => setting.key === key)?.label ?? key, value, true] as [string, string, boolean]),
    ["Key", pet.key ?? "None", !!pet.key],
    ...(pet.aliases.length ? [["Aliases", pet.aliases.join(", "), false] as [string, string, boolean]] : []),
  ];
  return (
    <Page
      title={
        <>
          <span className="title-emoji" aria-hidden>
            {pet.emoji}
          </span>
          {pet.title}
        </>
      }
      actions={
        <>
          {terminal && <button type="button" className="btn" disabled={!enabled || toggling} onClick={() => setConsoleBot(identity)}>Console</button>}
          <button type="button" className="btn" onClick={() => setLogsOpen(true)}>Logs</button>
          {!worker && <button type="button" className="btn" disabled={!enabled || toggling} onClick={() => setRestarting(true)}>
            Restart
          </button>}
          {!worker && <button type="button" className="btn primary" onClick={() => setEditing(true)}>
            Edit bot
          </button>}
        </>
      }
    >
      <Tabs
        label={`${pet.title}'s pages`}
        items={[
          { label: "Overview", href: botPath(house.name, pet.name), current: tab === "overview" },
          { label: "Harness", href: botPath(house.name, pet.name, "harness"), current: tab === "harness" },
          { label: "AGENTS.md", href: botPath(house.name, pet.name, "instructions"), current: tab === "instructions" },
          { label: "Lifecycle", href: botPath(house.name, pet.name, "lifecycle"), current: tab === "lifecycle" },
          { label: "Channels", href: botPath(house.name, pet.name, "channels"), current: tab === "channels" },
          { label: "Inboxes", href: botPath(house.name, pet.name, "inboxes"), current: tab === "inboxes" },
          { label: "Scheduled tasks", href: botPath(house.name, pet.name, "tasks"), current: tab === "tasks", count: scheduledCount(crons.view) },
          { label: "Skills", href: botPath(house.name, pet.name, "skills"), current: tab === "skills" },
          { label: "Environment", href: botPath(house.name, pet.name, "environment"), current: tab === "environment" },
          { label: "Volumes", href: botPath(house.name, pet.name, "volumes"), current: tab === "volumes" },
          { label: "Memory", href: botPath(house.name, pet.name, "memory"), current: tab === "memory" },
          { label: "Resources", href: botPath(house.name, pet.name, "resources"), current: tab === "resources" },
          { label: "Dreaming", disabled: true as const },
        ].filter((item) => !worker || (!item.disabled && WORKER_TABS.some((each) => item.href === botPath(house.name, pet.name, each))))}
      />
      {!enabled && !worker && (
        <div className="bot-off" role="status">
          <span className="bot-state">
            <span className="dot off" />
            Disabled
          </span>
          <span className="bot-off-text">Its VM is stopped. Files and memory are kept.</span>
          <button type="button" className="btn small primary" disabled={toggling} onClick={() => void enable()}>
            {toggling ? "Enabling…" : "Enable"}
          </button>
        </div>
      )}
      {tab === "overview" && (
        <>
          <div className="stats">
            {worker && <Stat href={workspacePath(house.name, "sideworkers")} icon={Pickaxe} label="Sideworker of" value={parent?.title ?? worker.parent} />}
            {!worker && <Stat href={botPath(house.name, pet.name, "channels")} icon={MessagesSquare} label="Channels" value={channels.length} sub={channels.length === 0 ? "in no channel" : `default in ${defaults}`} warn={channels.length === 0} />}
            {!worker && <Stat href={botPath(house.name, pet.name, "tasks")} icon={CalendarClock} label="Scheduled tasks" value={scheduledCount(crons.view)}
              sub={!crons.view ? "…" : (
                <>
                  <span className="stat-line">{next ? `next ${relative(next.at, crons.now)} · ${next.name}` : "nothing scheduled"}</span>
                  {last && <span className={last.status === "failed" ? "stat-line error" : "stat-line"}>last {relative(last.queued, crons.now)} · {last.name} · {RUN_WORDS[last.status]}</span>}
                </>
              )} />}
            {!worker && <Stat href={workspacePath(house.name, "sideworkers")} icon={Pickaxe} label="Sideworkers" value={workers.length} sub={workerStates || "none running"} />}
            <Stat href={botPath(house.name, pet.name, "resources")} icon={Gauge} label="Resources">
              <BotResourceSummary pet={pet} sample={samples[pet.name]} disk />
            </Stat>
          </div>
          <BotPreviews key={`${house.name}/${pet.name}`} house={house.name} pet={pet.name} enabled={houseFeatures(house).preview} />
          <Section>
            <span className="bot-state">
              <span className={`dot ${tone}`} />
              {label}
            </span>
            {pet.problem && (
              <p className="error" role="status">
                {pet.problem}
              </p>
            )}
            <List columns="minmax(140px, 220px) minmax(0, 1fr)">
              {details.map(([name, value, mono]) => (
                <ListRow key={name}>
                  <Cell>
                    <span className="muted">{name}</span>
                  </Cell>
                  <Cell mono={mono}>
                    <span className={mono ? "ellipsis" : value === "Default" || value === "None" ? "faint" : undefined}>{value}</span>
                  </Cell>
                </ListRow>
              ))}
            </List>
          </Section>
          {worker && (
            <Section>
              <Panel>
                <Cluster gap={4} justify="between">
                  <div className="grow">
                    <Stack gap={1}>
                      <span className="strong">Close sideworker</span>
                      <span className="hint">Its VM is removed. The shared files stay.</span>
                    </Stack>
                  </div>
                  <button type="button" className="btn danger small" onClick={() => dialog.open(closeWorkerDialog(house.name, pet, async () => { navigate(workspacePath(house.name, "sideworkers")); await refresh(); }))}>
                    Close…
                  </button>
                </Cluster>
              </Panel>
            </Section>
          )}
          {!worker && <Section>
            {enabled && (
              <Panel>
                <Cluster gap={4} justify="between">
                  <div className="grow">
                    <Stack gap={1}>
                      <span className="strong">Disable bot</span>
                      <span className="hint">Stops its VM. Nothing is removed.</span>
                    </Stack>
                  </div>
                  <button type="button" className="btn small" disabled={toggling} onClick={() => setDisabling(true)}>
                    Disable…
                  </button>
                </Cluster>
              </Panel>
            )}
            <Panel>
              <Cluster gap={4} justify="between">
                <div className="grow">
                  <Stack gap={1}>
                    <span className="strong">Remove bot</span>
                    <span className="hint">Its VM goes and it leaves its channels. Its files stay on disk.</span>
                  </Stack>
                </div>
                <button type="button" className="btn danger small" onClick={remove}>
                  Remove
                </button>
              </Cluster>
            </Panel>
          </Section>}
        </>
      )}
      {tab === "instructions" && <BotInstructions key={`${house.name}/${pet.name}`} house={house.name} pet={pet} />}
      {tab === "lifecycle" && <BotLifecycleTab key={`${house.name}/${pet.name}`} house={house.name} pet={pet} refresh={refresh} notify={notify} />}
      {tab === "channels" && <BotChannels house={house} pet={pet} platforms={platforms} refresh={refresh} notify={notify} />}
      {tab === "inboxes" && <BotInboxes house={house} pet={pet} inboxes={inboxes} notify={notify} />}
      {tab === "memory" && <BotMemory key={`${house.name}/${pet.name}`} house={house.name} pet={pet.name} />}
      {tab === "tasks" && <BotCrons house={house.name} pet={pet.name} crons={crons} />}
      {tab === "skills" && <SkillsPage key={`${house.name}/${pet.name}`} house={house.name} pet={pet.name} title={pet.title} worker={!!worker} notify={notify} />}
      {tab === "harness" && <BotHarness key={`${house.name}/${pet.name}`} house={house.name} pet={pet} agents={agents} keys={keys} refresh={refresh} notify={notify} />}
      {tab === "resources" && worker && <BotUsage house={house.name} pet={pet.name} />}
      {tab === "resources" && !worker && <BotResources key={`${house.name}/${pet.name}`} house={house.name} pet={pet} capacity={capacity} refresh={refresh} notify={notify} />}
      {tab === "volumes" && !worker && <BotVolumes key={`${house.name}/${pet.name}`} house={house} pet={pet} notify={notify} />}
      {tab === "environment" && <BotEnvironment key={`${house.name}/${pet.name}`} house={house.name} pet={pet} />}
      {dialog.element}
      {logsOpen && <LogsDialog house={house.name} pet={pet} title={pet.title} onClose={() => setLogsOpen(false)} />}
      {terminal && consoleBot === identity && <TerminalDialog key={identity} house={house.name} pet={pet.name} title={pet.title} onClose={() => setConsoleBot(undefined)} />}
      {disabling && <DisableDialog house={house.name} pet={pet} onClose={() => setDisabling(false)} onDisabled={() => { void refresh(); notify(`${pet.title} disabled`); }} />}
      {restarting && <RestartDialog house={house.name} pet={pet} onClose={() => setRestarting(false)} onRestarted={() => { refresh(); notify("VM restarted"); }} />}
      {editing && (
        <BotDialog
          agents={agents}
          keys={keys}
          pet={pet}
          onClose={() => setEditing(false)}
          save={async (name, fields) => {
            try {
              const warning = await written(api.updateBot(house.name, name, fields));
              notify(warning ?? `${pet.display} saved`, warning !== undefined);
            } finally {
              await refresh();
            }
          }}
        />
      )}
    </Page>
  );
}
