import { BotResourceSummary, useWorkspaceMetrics } from "./bot-resource-summary";
import { allocatedTotal, crowds, CROWDED_SHARE, petResources, petCpuSchema, petMemorySchema, type HostCapacity, type PetResources as BotResources } from "../../src/core/resources";
import { PET_NAME_PATTERN as BOT_NAME_PATTERN, PET_NAME_HINT as BOT_NAME_HINT } from "../../src/core/names";
import type { AgentModel as HarnessModel } from "../../src/core/agent";
import { useEffect, useState } from "react";
import { Brain, MessagesSquare, Pickaxe } from "lucide-react";
import { api, type HarnessModelsView, type HarnessView, type WorkspaceView, type KeyView, type BotFields, type BotView } from "../api";
import { botPath } from "../router";
import { Dialog } from "./dialog";
import { CheckList, ChoiceList, SelectField, StepperField, SwitchList, TextField } from "./fields";
import { FormGrid, Page } from "./layout";
import { channelLabel } from "./workspaces";
import { Link } from "./link";
import { ownBots, petState, workerCount, workersOf } from "./bot-state";
import type { SectionProps } from "./section";

/**
 * A workspace's Bots page: a card per bot (its state, harness, model, reasoning effort and permission mode, the channels it
 * is in, how many sideworkers it has going, its CPU and RAM now), each opening its page; add one here.
 */
export function BotsPage({ house, save, agents, keys = [], capacity }: SectionProps & { agents: HarnessView[]; keys?: KeyView[]; capacity: Capacity }) {
  const [adding, setAdding] = useState(false);
  const samples = useWorkspaceMetrics(house.name);
  return (
    <Page
      title="Bots"
      actions={
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Add bot
        </button>
      }
    >
      {ownBots(house.pets).length === 0 ? (
        <p className="list-empty bot-empty">No bots yet.</p>
      ) : (
        <ul className="bot-cards">
          {ownBots(house.pets).map((pet) => {
            const { tone, label } = petState(pet.state);
            const workers = workerCount(workersOf(house.pets, pet.name).length);
            return (
              <li key={pet.name}>
                <Link href={botPath(house.name, pet.name)} className="bot-card">
                  <span className="bot-card-head">
                    <span className="avatar large" aria-hidden>
                      {pet.emoji}
                    </span>
                    <span className="bot-card-state">
                      <span className={`dot ${tone}`} />
                      {label}
                    </span>
                  </span>
                  <span className="cell-lines">
                    <span className="strong ellipsis">{pet.title}</span>
                    {pet.title !== pet.name && <span className="id ellipsis">{pet.name}</span>}
                  </span>
                  <span className="bot-card-runs mono">
                    <span className="ellipsis">{pet.agent}</span>
                    <span className="bot-card-model">
                      <span className="ellipsis" title={pet.model}>{pet.model}</span>
                      <span className="tag" title="Reasoning effort">
                        <Brain size={11} strokeWidth={1.75} aria-hidden />
                        {pet.reasoningEffort ?? "default"}
                      </span>
                      {pet.mode && <span className="tag bot-card-mode" title="Permission mode">{modeLabel(agents, pet.agent, pet.mode)}</span>}
                    </span>
                  </span>
                  <span className="bot-card-channels">
                    {house.channels.filter((channel) => channel.pets.includes(pet.name)).map((channel) => (
                      <span key={channel.chat} className="bot-card-channel">
                        <MessagesSquare size={13} strokeWidth={1.75} aria-hidden />
                        <span className="ellipsis">{channelLabel(channel)}</span>
                        {channel.default === pet.name && channel.pets.length > 1 && <span className="faint">default</span>}
                      </span>
                    ))}
                    {!house.channels.some((channel) => channel.pets.includes(pet.name)) && <span className="faint">In no channel</span>}
                    {workers && (
                      <span className="bot-card-channel">
                        <Pickaxe size={13} strokeWidth={1.75} aria-hidden />
                        <span className="ellipsis">{workers}</span>
                      </span>
                    )}
                  </span>
                  <BotResourceSummary pet={pet} sample={samples[pet.name]} />
                  {pet.problem && <span className="error">{pet.problem}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {adding && <BotDialog agents={agents} keys={keysFor(keys, house.name)} house={house} capacity={capacity} onClose={() => setAdding(false)} save={(name, fields, channels) => save(api.addBot(house.name, name, fields, channels), `${name} added`)} />}
    </Page>
  );
}

/** The keys a workspace's bots may run on: those for every workspace, and those for this one. */
export const keysFor = (keys: KeyView[], house: string) => keys.filter((key) => !key.houses || key.houses.includes(house));

/** What runs a bot: its harness, the key, the model and how that model works. */
export type HarnessChoice = Pick<BotFields, "agent" | "model" | "reasoningEffort" | "mode" | "settings" | "key">;

/**
 * The fields that choose what runs a bot, in the order each depends on the one before: harness, key (one of a
 * provider its harness takes; chosen already when there is just one), the model (from the key's live list for harnesses
 * that have one), its reasoning effort and permission mode, and the harness's own settings (a field each, from
 * `HarnessView.settings`). `fields` is the form, `value` what it says, `error` why it cannot be saved yet, `changed`
 * whether it differs from `bot`'s.
 */
export function useHarnessForm(agents: HarnessView[], keys: KeyView[], pet?: Pick<BotView, "agent" | "model" | "reasoningEffort" | "mode" | "key"> & Partial<Pick<BotView, "settings">>, scope: "bot" | "scout" = "bot") {
  const [agentName, setHarnessName] = useState(pet?.agent ?? agents[0]?.name ?? "");
  const agent = agents.find((candidate) => candidate.name === agentName);
  const availableSettings = (agent?.settings ?? []).filter(setting => scope === "bot" || !setting.petOnly);
  const [model, setModel] = useState(pet?.model ?? agent?.defaultModel ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(pet?.reasoningEffort ?? null);
  const [mode, setMode] = useState(pet?.mode ?? agent?.defaultMode ?? null);
  /** The harness's own settings as chosen: a key absent or null is its Default. */
  const [settings, setSettings] = useState<Record<string, string | null>>(pet?.settings ?? {});
  const settingsChanged = availableSettings.some(({ key }) => (pet?.settings?.[key] ?? null) !== (settings[key] ?? null));
  const fittingFor = (providers: readonly string[] | undefined) => keys.filter((each) => providers?.includes(each.provider));
  const only = (providers: readonly string[] | undefined) => {
    const fits = fittingFor(providers);
    return fits.length === 1 ? fits[0]!.name : "";
  };
  const [key, setKey] = useState(pet?.key ?? only(agent?.providers));
  const [catalog, setCatalog] = useState<{ selection: string; data?: HarnessModelsView; error?: string }>();
  const [refresh, setRefresh] = useState(0);
  const [customModel, setCustomModel] = useState(false);
  const selection = `${agentName}/${key}`;
  useEffect(() => {
    if (!agent?.dynamicModels || !key) return;
    let cancelled = false;
    setCatalog({ selection });
    void api.agentModels(agentName, key).then(
      (data) => { if (!cancelled) setCatalog({ selection, data }); },
      (error) => { if (!cancelled) setCatalog({ selection, error: error instanceof Error ? error.message : "Could not load models" }); },
    );
    return () => { cancelled = true; };
  }, [agentName, key, agent?.dynamicModels, selection, refresh]);
  const currentCatalog = catalog?.selection === selection ? catalog : undefined;
  const choices: HarnessModel[] = currentCatalog?.data?.models ?? agent?.modelOptions ?? (agent?.models ?? []).map((id) => ({ id, label: id }));
  const selectedModel = choices.find(({ id }) => id === model);
  const efforts = selectedModel?.supportedReasoningEfforts;
  // Only an explicit model change resets effort. Loading or refreshing metadata must preserve saved settings.
  const changeModel = (value: string) => {
    setModel(value);
    setReasoningEffort((current) => effortForModel(current, choices.find(({ id }) => id === value)));
  };
  const invalidEffort = !!reasoningEffort && efforts !== undefined && !efforts.some((option) => option.reasoningEffort === reasoningEffort);
  const effortHint = efforts?.find((option) => option.reasoningEffort === reasoningEffort)?.description
    || (efforts?.length ? `Default${selectedModel?.defaultReasoningEffort ? `: ${selectedModel.defaultReasoningEffort}` : ""}.`
      : efforts ? "Not adjustable for this model." : "Unknown for this model; Default uses its own.");
  const modelHint = !agent?.dynamicModels ? undefined : !key ? "Choose a key first." : currentCatalog?.error
    ? "List unavailable: keep the model or enter its ID."
    : !currentCatalog?.data ? "Loading models…"
    : currentCatalog.data.source === "live" ? undefined
    : currentCatalog.data.source === "cache" ? "Cached list."
    : "No list yet: start a Codex bot with this key, or enter an ID.";
  const modelDescription = currentCatalog?.data?.models.find(({ id }) => id === model)?.description;
  const fitting = fittingFor(agent?.providers);
  const none = fitting.length === 0 ? `No ${agent?.providers.join(" or ") ?? ""} key yet (add one under Keys)` : "Choose a key…";
  const kindOf = (name: string | null | undefined) => keys.find((each) => each.name === name)?.kind;
  const changed = pet !== undefined && (pet.agent !== agentName || pet.model !== model || pet.mode !== mode || (pet.reasoningEffort ?? null) !== reasoningEffort || settingsChanged || pet.key !== (key || null));
  // Another kind of key (a subscription for an API key) gives the bot another placeholder: a new container.
  const restarts = pet !== undefined && (pet.agent !== agentName || pet.model !== model || pet.mode !== mode || (pet.reasoningEffort ?? null) !== reasoningEffort || settingsChanged || (pet.key !== null && kindOf(pet.key) !== kindOf(key)));
  // Only the harness's own settings go (another harness's stay out); every one named, null for Default, so a cleared one is removed.
  const value: HarnessChoice = { agent: agentName, model, reasoningEffort, mode, settings: Object.fromEntries(availableSettings.map(({ key }) => [key, settings[key] ?? null])), key: key || null }; // the key always named: the store refuses a bot without one
  const error = !key ? "Choose a key it runs on." : !model ? "Choose a model." : invalidEffort ? "Choose a supported reasoning effort or Default for this model." : undefined;
  const fields = (
    <>
      <SelectField
        label="Harness"
        value={agentName}
        onChange={(chosen) => {
          setHarnessName(chosen);
          setCustomModel(false);
          const next = agents.find((candidate) => candidate.name === chosen);
          setModel(next?.defaultModel ?? "");
          setMode(next?.defaultMode ?? null);
          setReasoningEffort(null);
          setSettings({});
          if (!keys.some((each) => each.name === key && next?.providers.includes(each.provider))) setKey(only(next?.providers));
        }}
        options={agents.map((candidate) => ({ value: candidate.name, label: candidate.name }))}
      />
      <SelectField
        label="Key"
        hint="The bot never sees it."
        value={key}
        onChange={(chosen) => { setKey(chosen); setReasoningEffort(null); }}
        options={[
          ...(key ? [] : [{ value: "", label: none, disabled: true }]),
          ...fitting.map((each) => ({ value: each.name, label: keyLabel(each) })),
          // One the config names that is not among them (another provider's, gone): shown, so the form says what is there.
          ...(key && !fitting.some((each) => each.name === key) ? [{ value: key, label: `${key} (does not fit)`, disabled: true }] : []),
        ]}
      />
      <SelectField label="Model" value={customModel ? "__custom" : model}
        hint={modelDescription || modelHint || (agent?.dynamicModels && key) ? (
          <>
            {modelDescription ?? modelHint}
            {agent?.dynamicModels && key && <> <button type="button" className="text-btn plain" onClick={() => setRefresh((count) => count + 1)}>Refresh list</button></>}
          </>
        ) : undefined}
        onChange={(chosen) => { setCustomModel(chosen === "__custom"); if (chosen !== "__custom") changeModel(chosen); }}
        options={[
          ...choices.map(({ id, label }) => ({ value: id, label })),
          ...(model && !choices.some(({ id }) => id === model) ? [{ value: model, label: `${model} (configured, not in this list)` }] : []),
          ...(agent?.dynamicModels ? [{ value: "__custom", label: "Enter model ID…" }] : []),
        ]} />
      {agent?.dynamicModels && customModel && <TextField label="Model ID" mono value={model} onChange={changeModel}
        hint="Checked when the bot starts." />}
      {currentCatalog?.error && <p className="error" role="status">{currentCatalog.error}</p>}
      <FormGrid>
        <SelectField label="Reasoning effort" value={reasoningEffort ?? ""} onChange={(chosen) => setReasoningEffort(chosen || null)} hint={effortHint} error={invalidEffort ? "Choose a supported effort or Default before saving." : undefined}
          options={[
            { value: "", label: "Default (native)" },
            ...(efforts ?? []).map(({ reasoningEffort }) => ({ value: reasoningEffort, label: reasoningEffort })),
            ...(reasoningEffort && !efforts?.some((option) => option.reasoningEffort === reasoningEffort)
              ? [{ value: reasoningEffort, label: `${reasoningEffort} (configured; support unconfirmed)` }] : []),
          ]} />
        {agent && agent.modes.length > 0 && (
          <SelectField
            label="Permission mode"
            value={mode ?? ""}
            onChange={setMode}
            options={[
              ...agent.modes.map(({ id, label }) => ({ value: id, label })),
              // One the config names that the harness does not have: shown, so the form says what is there.
              ...(mode && !agent.modes.some(({ id }) => id === mode) ? [{ value: mode, label: `${mode} (unknown)`, disabled: true }] : []),
            ]}
          />
        )}
        {availableSettings.filter((setting) => !setting.checkbox).map((setting) => {
          const chosen = settings[setting.key] ?? "";
          const option = setting.options.find(({ id }) => id === chosen);
          return (
            <SelectField key={setting.key} label={setting.label} value={chosen}
              hint={option?.description || (chosen ? undefined : `${setting.description ? `${setting.description} ` : ""}Default: ${setting.defaultLabel}.`)}
              onChange={(picked) => setSettings((current) => ({ ...current, [setting.key]: picked || null }))}
              options={[
                { value: "", label: `Default (${setting.defaultLabel})` },
                ...setting.options.map(({ id, label }) => ({ value: id, label })),
                // One the config names that the harness does not offer: shown, so the form says what is there.
                ...(chosen && !option ? [{ value: chosen, label: `${chosen} (unknown)`, disabled: true }] : []),
              ]} />
          );
        })}
      </FormGrid>
      {/* On/off settings under the selects, full width: a switch and the line on what it allows. */}
      {availableSettings.some((setting) => setting.checkbox) && (
        <SwitchList label="Harness options"
          options={availableSettings.filter((setting) => setting.checkbox).map((setting) => ({ value: setting.key, label: setting.label, description: setting.description }))}
          on={availableSettings.filter((setting) => settings[setting.key] === "true").map((setting) => setting.key)}
          onToggle={(key) => setSettings((current) => ({ ...current, [key]: current[key] === "true" ? null : "true" }))} />
      )}
    </>
  );
  return { fields, value, error, changed, restarts };
}

/** What a bot's CPU and RAM are weighed against: this host, and every workspace's bots (each enabled one takes its share). */
export interface Capacity {
  host: HostCapacity;
  houses: WorkspaceView[];
}

// The RAM stepper's step: a quarter of a GiB (the config takes any 128 MiB).
const RAM_STEP_MIB = 256;
const CROWDED = `More than ${CROWDED_SHARE * 100}% of this host.`;

/**
 * A bot's CPU and RAM, a stepper each up to what the host has; one past 80% of the host turns red (a warning: it
 * still saves), and under them what every workspace's enabled bots take together with these. `value` is what it says,
 * `error` why it cannot be saved, `changed` whether it differs from `bot`'s.
 */
export function useResourceForm({ host, houses }: Capacity, house: string, pet?: BotView) {
  const saved = petResources(pet ?? {});
  const [cpus, setCpus] = useState(String(saved.cpus));
  const [ram, setRam] = useState(String(saved.memoryMiB / 1024));
  const value = { cpus: Number(cpus), memoryMiB: Number(ram) * 1024 };
  const maxRam = (Math.floor(host.memoryMiB / RAM_STEP_MIB) * RAM_STEP_MIB) / 1024;
  const cpuError = petCpuSchema.safeParse(value.cpus).success && value.cpus <= host.cpus ? undefined : `A whole number from 1 to ${host.cpus}.`;
  const ramError = petMemorySchema.safeParse(value.memoryMiB).success && value.memoryMiB <= host.memoryMiB ? undefined : `From 0.5 to ${maxRam} GiB, in steps of 0.125 GiB (128 MiB).`;
  const changed = pet !== undefined && (value.cpus !== saved.cpus || value.memoryMiB !== saved.memoryMiB);
  // A new bot has no name yet that any bot has: it counts on top of the rest.
  const total = allocatedTotal(houses.flatMap((each) => each.pets.map((one) => ({ ...one, house: each.name }))), { house, name: pet?.name ?? "", enabled: pet?.enabled, ...value });
  const fields = (
    <>
      <FormGrid>
        <StepperField label="CPU" value={cpus} onChange={setCpus} step={1} min={1} max={host.cpus} unit="vCPU" error={cpuError}
          warning={!cpuError && crowds(value.cpus, host.cpus) ? CROWDED : undefined} />
        <StepperField label="RAM" value={ram} onChange={setRam} step={RAM_STEP_MIB / 1024} min={0.5} max={maxRam} unit="GiB" error={ramError}
          hint={!ramError && value.memoryMiB < 1024 ? "Under 1 GiB a harness may run out of memory." : undefined}
          warning={!ramError && crowds(value.memoryMiB, host.memoryMiB) ? CROWDED : undefined} />
      </FormGrid>
      {!cpuError && !ramError && <AllocatedLine total={total} host={host} hostRam={maxRam} />}
    </>
  );
  const error = cpuError ? `CPU: ${cpuError}` : ramError ? `RAM: ${ramError}` : undefined;
  return { fields, value, error, changed };
}

/** «Allocated: 7 of 10 vCPU · 20 of 32 GiB»: every workspace's enabled bots together; red past 80% of the host. */
function AllocatedLine({ total, host, hostRam }: { total: BotResources; host: HostCapacity; /** The host's memory as the RAM stepper shows it, in GiB. */ hostRam: number }) {
  const crowded = crowds(total.cpus, host.cpus) || crowds(total.memoryMiB, host.memoryMiB);
  return (
    <p className={crowded ? "hint danger" : "hint"} role="status">
      Allocated: {total.cpus} of {host.cpus} vCPU · {total.memoryMiB / 1024} of {hostRam} GiB{crowded && ` — ${CROWDED.toLowerCase()}`}
    </p>
  );
}

type BotDialogProps = {
  agents: HarnessView[];
  /** The Household's keys: the bot runs on one its harness takes. */
  keys?: KeyView[];
  onClose: () => void;
} & (
  /** A new bot: all of it, and the chats of the workspace's channels it joins. */
  | { pet?: undefined; house: WorkspaceView; capacity: Capacity; save: (name: string, fields: BotFields, channels: string[]) => Promise<void> }
  /** The bot to edit: its names. */
  | { pet: BotView; save: (name: string, fields: Partial<BotFields>) => Promise<void> }
);

/**
 * Adding a bot is a wizard (`AddBotDialog`); editing one is its names only: what runs it, its channels and its size
 * have their own tabs. The config's errors (an emoji that is not one, …) show in it.
 */
export function BotDialog(props: BotDialogProps) {
  if (!props.pet) return <AddBotDialog {...props} />;
  const { pet, onClose, save } = props;
  return <EditBotDialog pet={pet} onClose={onClose} save={save} />;
}

/** A bot's names: display name, emoji, aliases. */
function useNames(pet?: BotView) {
  const [title, setTitle] = useState(pet?.ownTitle ?? "");
  const [emoji, setEmoji] = useState(pet?.ownEmoji ?? "");
  const [aliases, setAliases] = useState(pet?.aliases.join(", ") ?? "");
  const value = { title: title.trim() || null, emoji: emoji.trim() || null, aliases: aliases.split(",").map((alias) => alias.trim()).filter(Boolean) };
  const aliasesField = <TextField label="Aliases" value={aliases} onChange={setAliases} placeholder="Sib, Sibby" hint="Other names it answers to, comma-separated." />;
  return { title, setTitle, emoji, setEmoji, aliasesField, value };
}

function EditBotDialog({ pet, onClose, save }: { pet: BotView; onClose: () => void; save: (name: string, fields: Partial<BotFields>) => Promise<void> }) {
  const names = useNames(pet);
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: `Edit ${pet.display}`,
        confirmLabel: "Save",
        onConfirm: () => save(pet.name, names.value),
        children: (
          <>
            <FormGrid>
              <TextField label="Display name" maxLength={64} value={names.title} onChange={names.setTitle} placeholder={pet.name} />
              <TextField label="Emoji" value={names.emoji} onChange={names.setEmoji} placeholder="🤖" />
            </FormGrid>
            {names.aliasesField}
          </>
        ),
      }}
    />
  );
}

const STEPS = ["Bot", "Harness", "Resources"] as const;

/**
 * Adding a bot, in three steps: Bot (name, display name, emoji, aliases, and the channels it joins), Harness (what runs
 * it) and Resources (its CPU and RAM); Back keeps what was entered. Its channels are on the first step, not a step of
 * their own: a tick or two, the workspace's only channel ticked already. A bot in none hears no one, and its «started»
 * notice reaches no one.
 */
function AddBotDialog({ agents, keys = [], house, capacity, onClose, save }: { agents: HarnessView[]; keys?: KeyView[]; house: WorkspaceView; capacity: Capacity; onClose: () => void; save: (name: string, fields: BotFields, channels: string[]) => Promise<void> }) {
  const [name, setName] = useState("");
  const names = useNames();
  const [channels, setChannels] = useState(() => (house.channels.length === 1 ? [house.channels[0]!.chat] : []));
  const [step, setStep] = useState(0);
  const agent = useHarnessForm(agents, keys);
  const resources = useResourceForm(capacity, house.name);
  const last = step === STEPS.length - 1;
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: "Add bot",
        step: STEPS[step],
        wide: true,
        back: step > 0 ? () => setStep(step - 1) : undefined,
        confirmLabel: last ? "Add bot" : "Next",
        onConfirm: async () => {
          if (step === 0 && !BOT_NAME_PATTERN.test(name.trim())) throw new Error(BOT_NAME_HINT);
          if (step === 1 && agent.error) throw new Error(agent.error);
          if (!last) {
            setStep(step + 1);
            return "stay";
          }
          if (resources.error) throw new Error(resources.error);
          await save(name.trim(), { ...names.value, ...agent.value, ...resources.value }, channels);
        },
        children: (
          <>
            <ol className="steps" aria-label="Steps">
              {STEPS.map((label, index) => (
                <li key={label} className={index === step ? "current" : index < step ? "done" : undefined} aria-current={index === step ? "step" : undefined}>{label}</li>
              ))}
            </ol>
            {step === 0 && (
              <>
                <FormGrid>
                  <TextField label="Name" mono value={name} onChange={setName} placeholder="my_bot" maxLength={31} hint={BOT_NAME_HINT} error={name && !BOT_NAME_PATTERN.test(name) ? "Use a lowercase Latin letter first, then a–z, 0–9, _ or -." : undefined} />
                  <TextField label="Emoji" value={names.emoji} onChange={names.setEmoji} placeholder="🤖" />
                </FormGrid>
                <FormGrid>
                  <TextField label="Display name" maxLength={64} value={names.title} onChange={names.setTitle} placeholder={name || "Sibling"} />
                  {names.aliasesField}
                </FormGrid>
                <CheckList
                  label="Channels"
                  options={house.channels.map((channel) => ({ value: channel.chat, label: channelLabel(channel) }))}
                  checked={channels}
                  onToggle={(chat) => setChannels((chosen) => (chosen.includes(chat) ? chosen.filter((each) => each !== chat) : [...chosen, chat]))}
                  empty={`No channels in ${house.name} yet. Add one on the workspace's Channels page, then switch the bot on in it from the bot's Channels tab.`}
                />
              </>
            )}
            {step === 1 && agent.fields}
            {step === 2 && (
              <>
                {resources.fields}
                <p className="hint">You can change it later on the Resources tab.</p>
              </>
            )}
          </>
        ),
      }}
    />
  );
}

/** How people call a bot's permission mode (its harness's label; the id when the harness does not know it). */
export function modeLabel(agents: HarnessView[], agent: string, mode: string): string {
  return agents.find((candidate) => candidate.name === agent)?.modes.find(({ id }) => id === mode)?.label ?? mode;
}

/** A key in a select: its name and kind, then the start of its note, if any («claude (subscription) — Max, Oleg's…»). */
export function keyLabel(key: { name: string; kind?: string | null; provider: string; note?: string | null }): string {
  const base = `${key.name} (${key.kind ?? key.provider})`;
  if (!key.note) return base;
  const start = key.note.length > 32 ? `${key.note.slice(0, 31).trimEnd()}…` : key.note;
  return `${base} — ${start}`;
}

/** An explicitly selected model can keep only an effort it advertises. Unknown models use their native default. */
export function effortForModel(current: string | null, model: HarnessModel | undefined): string | null {
  return current && model?.supportedReasoningEfforts?.some(({ reasoningEffort }) => reasoningEffort === current) ? current : null;
}

/**
 * Restarting a bot's VM: files, packages and Household memory stay; the harness starts a fresh session. Either the
 * harness is asked to save its work first (Household waits up to three minutes) or the current turn stops at once.
 */
export function RestartDialog({ house, pet, onClose, onRestarted }: { house: string; pet: BotView; onClose: () => void; onRestarted: () => void }) {
  const [mode, setMode] = useState<"notify" | "now">("notify");
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: `Restart ${pet.title}?`,
        body: "Files, packages and memory stay. The harness starts a new session.",
        children: (
          <ChoiceList
            label="How"
            value={mode}
            onChange={(value) => setMode(value as "notify" | "now")}
            options={[
              { value: "notify", label: "Let it save its work first", description: "Asks the harness to wrap up; restarts when done or after 3 min." },
              { value: "now", label: "Restart now", description: "Stops the current turn. Unsaved work is lost." },
            ]}
          />
        ),
        confirmLabel: mode === "notify" ? "Restart" : "Restart now",
        danger: mode === "now",
        busyLabel: mode === "notify" ? "Waiting for the harness…" : "Restarting…",
        onConfirm: async () => {
          await api.restartEnvironment(house, pet.name, mode);
          onRestarted();
        },
      }}
    />
  );
}

export function DisableDialog({ house, pet, onClose, onDisabled }: { house: string; pet: BotView; onClose: () => void; onDisabled: () => void }) {
  const [mode, setMode] = useState<"notify" | "now">("notify");
  return <Dialog onClose={onClose} spec={{
    title: `Disable ${pet.title}?`,
    body: "Its VM stops until you enable it. Files, packages and memory stay.",
    children: <ChoiceList label="How" value={mode} onChange={value => setMode(value as "notify" | "now")} options={[
      { value: "notify", label: "Let it save its work first", description: "Asks the harness to wrap up; stops when done or after 3 min." },
      { value: "now", label: "Disable now", description: "Stops the VM at once. Unsaved work is lost." },
    ]} />,
    confirmLabel: mode === "notify" ? "Disable" : "Disable now",
    danger: mode === "now",
    busyLabel: mode === "notify" ? "Waiting for the harness…" : "Disabling…",
    onConfirm: async () => { await api.disableBot(house, pet.name, mode); onDisabled(); },
  }} />;
}
