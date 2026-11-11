import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { gib, type HostCapacity } from "../../src/core/resources";
import { houseFeatures, previewSettings } from "../../src/core/house-features";
import { api, type BotListenStatus, type BotListenView, type DeviceLoginView, type HarnessView, type KeyView, type OnboardingView, type WorkspaceView } from "../api";
import { botPath, navigate, workspacePath } from "../router";
import { ChoiceList, StepperField, Switch, TextField } from "./fields";
import { Cluster, FormGrid, Page, Panel, Stack } from "./layout";
import { Link } from "./link";
import { petState } from "./bot-state";
import { BOT_PRESETS, CHANNELS, KEY_METHODS, PROVIDERS, SLACK_MEMBER_STEPS, TELEGRAM_GROUP_ID, TELEGRAM_USER_ID, guidePieces, presetInstructions, suggestedBudget, type ChannelOption, type KeyMethod, type Provider } from "../../src/core/onboarding";

type Notify = (text: string, warning?: boolean) => void;

/** The setup's steps, each with its own screens (listed under it in the stepper while it is the current one). */
export const SETUP_STEPS = [
  { id: "model", label: "Model", subs: ["Provider", "Sign-in", "Connect"] },
  { id: "workspace", label: "Workspace", subs: [] },
  { id: "channel", label: "Channel", subs: ["Messenger", "Setup", "Owner"] },
  { id: "bot", label: "Bot", subs: ["Purpose", "Details"] },
  { id: "hi", label: "Say hi", subs: [] },
] as const;
type StepId = (typeof SETUP_STEPS)[number]["id"];

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const BOT_NAME = /^[a-z][a-z0-9_-]{0,30}$/;

const freeName = (taken: string[], base: string) => {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const providerLabel = (provider: string) => PROVIDERS.find((each) => each.id === provider)?.label ?? provider;

/** A channel the setup made, for the stepper and the last step; null: the step was skipped. */
interface Connected { kind: string; label: string; bot?: string }

export interface SetupProps {
  houses: WorkspaceView[];
  keys: KeyView[];
  agents: HarnessView[];
  host: HostCapacity;
  /** A workspace to go on with (`/setup?workspace=…`): from the first step it lacks. */
  resume?: string;
  refresh: () => Promise<void>;
  notify: Notify;
}

/**
 * Household · Setup: from nothing to a bot answering in a messenger, as `house onboard` does, one choice at a
 * time: what to choose, then how to get what that choice needs, then the field for it. The stepper on the left
 * shows every step with what was chosen; one done can be opened again. Each step writes as it ends (a key, a
 * workspace and its budget, a channel and its owner, a bot), so leaving halfway keeps what is done.
 */
export function SetupPage({ houses, keys, agents, host, resume, refresh, notify }: SetupProps) {
  const resumed = houses.find((house) => house.name === resume);
  const [key, setKey] = useState<KeyView | undefined>(() => (resumed ? keys.find((each) => resumed.pets.some((pet) => pet.key === each.name)) ?? keys[0] : undefined));
  const [house, setHouse] = useState<string | undefined>(resumed?.name);
  const [channel, setChannel] = useState<Connected | null | undefined>(() => {
    const found = resumed?.channels[0];
    return found ? { kind: found.kind, label: CHANNELS.find((each) => each.kind === found.kind)?.label ?? found.label, bot: found.shown?.token ?? undefined } : undefined;
  });
  const [bot, setBot] = useState<string | undefined>(() => resumed?.pets.find((pet) => !pet.sideworker)?.name);
  const done: Record<StepId, boolean> = { model: !!key, workspace: !!house, channel: channel !== undefined, bot: !!bot, hi: false };
  const firstOpen = SETUP_STEPS.find((step) => !done[step.id])!.id;
  const [at, setAt] = useState<{ step: StepId; sub: number }>({ step: firstOpen, sub: 0 });
  const current = houses.find((each) => each.name === house);

  /** A step is done: on to the first one still open after it. */
  const next = (from: StepId) => {
    const now = { ...done, [from]: true };
    const index = SETUP_STEPS.findIndex((step) => step.id === from);
    const open = SETUP_STEPS.slice(index + 1).find((step) => !now[step.id]) ?? SETUP_STEPS.at(-1)!;
    setAt({ step: open.id, sub: 0 });
  };
  const go = (sub: number) => setAt({ step: at.step, sub });
  const summary: Record<StepId, string | undefined> = {
    model: key && `${providerLabel(key.provider)} · ${key.name}`,
    workspace: current && `${current.name}${current.resources ? ` · ${current.resources.total.cpus} vCPU · ${gib(current.resources.total.memoryMiB)}` : ""}`,
    channel: channel === null ? "Skipped" : channel ? [channel.label, channel.bot].filter(Boolean).join(" · ") : undefined,
    bot: current?.pets.find((pet) => pet.name === bot)?.display ?? bot,
    hi: undefined,
  };
  // A step done may be opened again, but not the key once a bot runs on it: that is the bot's page's.
  const reachable = (step: StepId) => step === firstOpen || (done[step] && !(step === "model" && done.bot));

  return (
    <Page title="Set up Household">
      <div className="setup">
        <nav className="setup-stepper" aria-label="Setup steps">
          <ol>
            {SETUP_STEPS.map((step, index) => {
              const state = step.id === at.step ? "current" : done[step.id] ? "done" : "todo";
              const head = (
                <>
                  <span className="setup-mark" aria-hidden>{state === "done" ? <Check size={12} strokeWidth={2.5} /> : index + 1}</span>
                  <span className="setup-name">{step.label}</span>
                </>
              );
              return (
                <li key={step.id} className={`setup-step ${state}`} aria-current={state === "current" ? "step" : undefined}>
                  {state !== "current" && reachable(step.id)
                    ? <button type="button" className="setup-head" onClick={() => setAt({ step: step.id, sub: 0 })}>{head}</button>
                    : <span className="setup-head">{head}</span>}
                  {summary[step.id] && state !== "current" && <span className="setup-summary">{summary[step.id]}</span>}
                  {state === "current" && step.subs.length > 0 && (
                    <ol className="setup-subs">
                      {step.subs.map((label, each) => (
                        <li key={label} className={each === at.sub ? "current" : each < at.sub ? "done" : undefined}>
                          {each < at.sub ? <button type="button" className="setup-sub" onClick={() => go(each)}>{label}</button> : <span className="setup-sub">{label}</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="setup-body">
          {at.step === "model" && <ModelStep sub={at.sub} go={go} keys={keys} refresh={refresh} onDone={(chosen) => { setKey(chosen); next("model"); }} />}
          {at.step === "workspace" && (current
            ? <Created house={current} onNext={() => next("workspace")} />
            : <WorkspaceStep houses={houses} host={host} refresh={refresh} onDone={(name) => { setHouse(name); next("workspace"); }} />)}
          {at.step === "channel" && house && (
            <ChannelStep sub={at.sub} go={go} house={house} refresh={refresh}
              onDone={(made) => { setChannel(made); next("channel"); }} onSkip={() => { setChannel((was) => was ?? null); next("channel"); }} />
          )}
          {at.step === "bot" && current && key && (
            <BotStep sub={at.sub} go={go} house={current} keyView={key} agents={agents} refresh={refresh} notify={notify} onDone={(name) => { setBot(name); next("bot"); }} />
          )}
          {at.step === "hi" && current && bot && <DoneStep house={current} bot={bot} channel={channel ?? undefined} />}
        </div>
      </div>
    </Page>
  );
}

/** A screen of a step: its question, what to do, and its buttons (Back on the left, the one primary on the right). */
function Screen({ title, hint, back, primary, extra, children }: { title: string; hint?: ReactNode; back?: () => void; primary?: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  return (
    <Panel>
      <Stack gap={5}>
        <Stack gap={1}>
          <h2 className="h2">{title}</h2>
          {hint && <p className="hint">{hint}</p>}
        </Stack>
        {children}
        {(back || primary || extra) && (
          <div className="setup-actions">
            {back ? <button type="button" className="btn" onClick={back}>Back</button> : <span />}
            <Cluster gap={2}>{extra}{primary}</Cluster>
          </div>
        )}
      </Stack>
    </Panel>
  );
}

/** What to do, in order: the catalog's lines, their `code`, **bold** and links drawn. */
function Guide({ steps }: { steps: string[] }) {
  const line = (text: string) => guidePieces(text).map((piece, index) =>
    piece.kind === "code" ? <code key={index}>{piece.text}</code>
    : piece.kind === "bold" ? <b key={index}>{piece.text}</b>
    : piece.kind === "link" ? <a key={index} className="text-link" href={piece.href} target="_blank" rel="noreferrer">{piece.text}</a>
    : piece.text);
  return <ol className="setup-steps">{steps.map((step, index) => <li key={index}><span>{line(step)}</span></li>)}</ol>;
}

/** An action's busy state and its error, shown under the fields. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run, fail: setError, shown: error ? <p className="error" role="alert">{error}</p> : null };
}

// ── Model: a provider, how to sign in, then what that needs ─────────────────────────────────────────────────

function ModelStep({ sub, go, keys, refresh, onDone }: { sub: number; go: (sub: number) => void; keys: KeyView[]; refresh: () => Promise<void>; onDone: (key: KeyView) => void }) {
  const fitting = keys.filter((key) => PROVIDERS.some((provider) => provider.id === key.provider));
  const [choice, setChoice] = useState(fitting[0] ? `key:${fitting[0].name}` : PROVIDERS[0]!.id);
  const [info, setInfo] = useState<OnboardingView>();
  const provider = choice.startsWith("key:") ? undefined : (choice as Provider);
  const methods = KEY_METHODS.filter((method) => method.provider === provider && (!method.needsLocalCodex || info?.localCodex));
  const [methodId, setMethodId] = useState<string>();
  const method = methods.find((each) => each.id === methodId) ?? methods[0];

  useEffect(() => { void api.onboarding().then(setInfo, () => setInfo({ localCodex: null })); }, []);

  if (sub === 0) {
    return (
      <Screen title="Which model will your bots use?" hint="Bots never see the key: Household's gateway adds it to their requests." primary={
        <button className="btn primary" onClick={() => {
          const known = fitting.find((key) => `key:${key.name}` === choice);
          if (known) return onDone(known);
          setMethodId(undefined);
          go(1);
        }}>Next</button>
      }>
        <ChoiceList
          label="Provider"
          value={choice}
          onChange={setChoice}
          options={[
            ...fitting.map((key) => ({ value: `key:${key.name}`, label: <>Use key <span className="id">{key.name}</span></>, description: `${providerLabel(key.provider)} · ${key.kind ?? "key"}${key.note ? ` · ${key.note}` : ""}` })),
            ...PROVIDERS.map((each) => ({ value: each.id, label: fitting.length ? `Add ${each.label}` : each.label, description: each.description })),
          ]}
        />
      </Screen>
    );
  }
  if (sub === 1 || !method) {
    return (
      <Screen title={`How will ${provider === "openai" ? "Codex" : "Claude Code"} sign in?`} back={() => go(0)} primary={<button className="btn primary" disabled={!method} onClick={() => go(2)}>Next</button>}>
        <ChoiceList label="Sign-in" value={method?.id ?? ""} onChange={setMethodId} options={methods.map((each) => ({
          value: each.id,
          label: each.label,
          description: each.id === "chatgpt-local" && info?.localCodex ? [info.localCodex.email, info.localCodex.plan && `ChatGPT ${info.localCodex.plan}`].filter(Boolean).join(" · ") || each.description : each.description,
        }))} />
      </Screen>
    );
  }
  return <KeyConnect key={method.id} method={method} keys={keys} back={() => go(1)} refresh={refresh} onDone={onDone} />;
}

function KeyConnect({ method, keys, back, refresh, onDone }: { method: KeyMethod; keys: KeyView[]; back: () => void; refresh: () => Promise<void>; onDone: (key: KeyView) => void }) {
  const [value, setValue] = useState("");
  const [login, setLogin] = useState<DeviceLoginView>();
  const action = useAction();
  const name = freeName(keys.map((key) => key.name), method.name);
  const { input } = method;

  const saved = async (keyName: string) => {
    const fresh = await api.keys();
    await refresh();
    const key = fresh.find((each) => each.name === keyName);
    if (!key) throw new Error(`key ${keyName} was not saved`);
    onDone(key);
  };

  // A ChatGPT sign-in under way: asked about every two seconds until it ends. One Household no longer knows (it
  // restarted) is said, and the screen starts over; leaving the screen cancels one still running.
  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let over = false;
    const timer = setInterval(() => {
      void api.chatgptLogin(login.id).then((state) => {
        if (stopped || state.status === "waiting") return;
        over = true;
        clearInterval(timer);
        setLogin(undefined);
        if (state.status === "failed") action.fail(state.error);
        else void action.run(() => saved(state.key));
      }, (error) => {
        if (stopped || !(error instanceof Error) || !error.message.startsWith("no such")) return;
        over = true;
        clearInterval(timer);
        setLogin(undefined);
        action.fail(error.message);
      });
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (!over) void api.cancelChatgptLogin(login.id).catch(() => undefined);
    };
  }, [login]); // eslint-disable-line react-hooks/exhaustive-deps -- one poll per sign-in

  const connect = () => action.run(async () => {
    if (input.kind === "local") {
      await api.importCodex(name);
      return saved(name);
    }
    if (input.kind === "device") return setLogin(await api.startChatgptLogin(name));
    const token = value.trim();
    if (!token.startsWith(input.prefix)) throw new Error(input.wrong);
    await api.addKey(name, { provider: method.provider, value: token, note: method.label, houses: null });
    await saved(name);
  });
  const label = input.kind === "device" ? "Sign in with ChatGPT" : input.kind === "local" ? "Use this login" : "Connect";

  return (
    <Screen
      title={method.label}
      hint={<>Saved as key <span className="id">{name}</span>. Manage keys later in Settings.</>}
      back={login ? undefined : back}
      primary={login
        ? <button className="btn" onClick={() => setLogin(undefined)}>Cancel sign-in</button>
        : <button className="btn primary" disabled={action.busy || (input.kind === "paste" && !value.trim())} onClick={connect}>{action.busy ? "Connecting…" : label}</button>}
    >
      <Guide steps={method.steps} />
      {input.kind === "paste" && <TextField label={input.label} type="password" mono value={value} onChange={setValue} placeholder={input.placeholder} />}
      {login && (
        <div className="setup-code">
          <span>Open <a className="text-link" href={login.url} target="_blank" rel="noreferrer">{login.url}</a> and enter</span>
          <code className="setup-code-value">{login.code}</code>
          <span className="hint">Waiting for you to finish…</span>
        </div>
      )}
      {action.shown}
    </Screen>
  );
}

// ── Workspace ───────────────────────────────────────────────────────────────────────────────────────────────

function WorkspaceStep({ houses, host, refresh, onDone }: { houses: WorkspaceView[]; host: HostCapacity; refresh: () => Promise<void>; onDone: (house: string) => void }) {
  const [name, setName] = useState(() => freeName(houses.map((house) => house.name), "home"));
  const taken = houses.reduce((sum, house) => ({ cpus: sum.cpus + (house.resources?.total.cpus ?? 0), memoryMiB: sum.memoryMiB + (house.resources?.total.memoryMiB ?? 0) }), { cpus: 0, memoryMiB: 0 });
  const [cpus, setCpus] = useState(() => String(suggestedBudget(host).cpus));
  const [memory, setMemory] = useState(() => String(suggestedBudget(host).memoryMiB / 1024));
  const action = useAction();
  const nameError = name && !NAME.test(name) ? "Use a lowercase letter first, then a–z, 0–9 or -." : houses.some((house) => house.name === name) ? `${name} exists already.` : undefined;
  const over = Number(cpus) + taken.cpus > host.cpus || Number(memory) * 1024 + taken.memoryMiB > host.memoryMiB;
  return (
    <Screen
      title="Create a workspace"
      hint="A workspace is a trust zone: its own bots, network allowlist, secrets, channels and owners."
      primary={<button className="btn primary" disabled={action.busy || !name || !!nameError} onClick={() => action.run(async () => {
        await api.createWorkspace(name);
        await api.setWorkspaceResources(name, { cpus: Number(cpus), memoryMiB: Number(memory) * 1024 });
        await refresh();
        onDone(name);
      })}>{action.busy ? "Creating…" : "Create workspace"}</button>}
    >
      <TextField label="Name" mono value={name} onChange={setName} maxLength={31} hint="Lowercase letters, digits and dashes." error={nameError} />
      <Stack gap={3}>
        <p className="hint">
          How much of this machine ({host.cpus} vCPU, {gib(host.memoryMiB)}) the workspace may use. Each bot reserves its own share;
          scouts and sideworkers take theirs from the rest while they run.
        </p>
        <FormGrid>
          <StepperField label="CPUs" value={cpus} onChange={setCpus} step={1} min={1} max={host.cpus} unit="vCPU" />
          <StepperField label="Memory" value={memory} onChange={setMemory} step={1} min={1} max={Math.floor(host.memoryMiB / 1024)} unit="GiB" />
        </FormGrid>
        {over && <p className="hint">With your other workspaces this is more than the machine has: they will compete for it.</p>}
      </Stack>
      {action.shown}
    </Screen>
  );
}

/** The workspace, opened again once made: it stays as it is here; its budget is the Resources page's. */
function Created({ house, onNext }: { house: WorkspaceView; onNext: () => void }) {
  return (
    <Screen title={`Workspace ${house.name}`} hint="Created. Change its budget on its Resources page." primary={<button className="btn primary" onClick={onNext}>Next</button>}
      extra={<Link className="btn" href={workspacePath(house.name, "resources")}>Resources</Link>} />
  );
}

// ── Channel: a messenger, what it needs, then who owns it ───────────────────────────────────────────────────

function ChannelStep({ sub, go, house, refresh, onDone, onSkip }: { sub: number; go: (sub: number) => void; house: string; refresh: () => Promise<void>; onDone: (made: Connected) => void; onSkip: () => void }) {
  const [kind, setKind] = useState<ChannelOption["kind"]>(CHANNELS[0]!.kind);
  const option = CHANNELS.find((each) => each.kind === kind)!;
  // What the Setup screen got, for the Owner screen.
  const [listen, setListen] = useState<BotListenView>();
  const [group, setGroup] = useState("");
  const [slack, setSlack] = useState<{ token: string; appToken: string }>();

  if (sub === 0) {
    return (
      <Screen title="Where will you talk to your bots?" hint="You can add more channels later on the workspace's Channels page." extra={<button className="btn" onClick={onSkip}>Skip for now</button>} primary={<button className="btn primary" onClick={() => go(1)}>Next</button>}>
        <ChoiceList label="Messenger" value={kind} onChange={(value) => { setKind(value as ChannelOption["kind"]); setListen(undefined); setSlack(undefined); }} options={CHANNELS.map((each) => ({
          value: each.kind,
          label: <span className="setup-option">{each.label}{each.recommended && <span className="soon">Recommended</span>}{each.beta && <span className="soon">Beta</span>}</span>,
          description: each.description,
        }))} />
      </Screen>
    );
  }
  if (sub === 1 || (kind === "slack-private" ? !slack : !listen)) {
    return kind === "slack-private"
      ? <SlackTokens option={option} back={() => go(0)} onDone={(tokens) => { setSlack(tokens); go(2); }} />
      : <TelegramBot option={option} house={house} back={() => go(0)} onDone={(started, chat) => { setListen(started); setGroup(chat); go(2); }} />;
  }
  return kind === "slack-private"
    ? <SlackOwner house={house} tokens={slack!} back={() => go(1)} refresh={refresh} onDone={() => onDone({ kind, label: option.label })} />
    : <TelegramOwner listen={listen!} group={kind === "telegram-group" ? group : undefined} back={() => go(1)} refresh={refresh} onDone={() => onDone({ kind, label: option.label, bot: listen!.bot })} />;
}

function TelegramBot({ option, house, back, onDone }: { option: ChannelOption; house: string; back: () => void; onDone: (listen: BotListenView, group: string) => void }) {
  const [token, setToken] = useState("");
  const [group, setGroup] = useState("");
  const action = useAction();
  const isGroup = option.kind === "telegram-group";
  const groupError = group && !TELEGRAM_GROUP_ID.test(group.trim()) ? "A negative number starting with -100." : undefined;
  return (
    <Screen title={option.label} back={back} primary={
      <button className="btn primary" disabled={action.busy || !token.trim() || (isGroup && (!group.trim() || !!groupError))} onClick={() => action.run(async () => {
        onDone(await api.listenBot(house, option.kind, token.trim()), group.trim());
      })}>{action.busy ? "Checking…" : "Check the bot"}</button>
    }>
      <Guide steps={option.steps} />
      <TextField label="Bot token" type="password" mono value={token} onChange={setToken} placeholder="123456789:AAH…" />
      {isGroup && <TextField label="Group id" mono value={group} onChange={setGroup} placeholder="-1001234567890" error={groupError} />}
      {action.shown}
    </Screen>
  );
}

function TelegramOwner({ listen, group, back, refresh, onDone }: { listen: BotListenView; group?: string; back: () => void; refresh: () => Promise<void>; onDone: () => void }) {
  const [state, setState] = useState<BotListenStatus>({ status: "waiting" });
  const [manual, setManual] = useState("");
  /** Why the wait is gone (Household restarted, or forgot it): only Back is left, to give the token again. */
  const [gone, setGone] = useState<string>();
  const action = useAction();

  // The wait for the first message: asked about every two seconds while it waits.
  useEffect(() => {
    if (state.status !== "waiting" || gone) return;
    const ask = () => void api.botListen(listen.id).then(
      (found) => { if (found.status !== "waiting") setState(found); },
      (error) => { if (error instanceof Error && error.message.startsWith("no such")) setGone(error.message); },
    );
    ask();
    const timer = setInterval(ask, 2000);
    return () => clearInterval(timer);
  }, [listen.id, state.status, gone]);

  const finish = (owner: string) => action.run(async () => {
    await api.finishBot(listen.id, owner, group);
    await refresh();
    onDone();
  });
  const again = () => action.run(async () => setState(await api.listenAgain(listen.id)));

  return (
    <Screen title={`Tell ${listen.bot} who you are`} hint="You become the workspace's owner: your messages are trusted, and only you approve what bots ask for." back={back}
      primary={gone ? undefined : state.status === "found"
        ? <button className="btn primary" disabled={action.busy} onClick={() => finish(state.contact.id)}>{action.busy ? "Saving…" : "Yes, that's me"}</button>
        : state.status === "waiting" ? undefined
        : <button className="btn primary" disabled={action.busy || !TELEGRAM_USER_ID.test(manual.trim())} onClick={() => finish(manual.trim())}>{action.busy ? "Saving…" : "Save"}</button>}
      extra={gone ? undefined : state.status === "found" ? <button className="btn" onClick={again}>No, wait for mine</button>
        : state.status === "timeout" || state.status === "failed" ? <button className="btn" onClick={again}>Wait again</button> : undefined}
    >
      {gone && <p className="error" role="alert">{gone}</p>}
      {!gone && state.status === "waiting" && (
        <Stack gap={2}>
          <p>Open <a className="text-link" href={listen.link} target="_blank" rel="noreferrer">{listen.link}</a> and send the bot any message{group ? " in a private chat, not in the group" : ""} (pressing <b>Start</b> works).</p>
          <p className="hint">Waiting for your message…</p>
        </Stack>
      )}
      {state.status === "found" && <p>Message from <b>{state.contact.name}</b>{state.contact.username ? ` (@${state.contact.username})` : ""}. Is that you?</p>}
      {(state.status === "timeout" || state.status === "failed" || state.status === "manual") && (
        <Stack gap={3}>
          <p className="hint">
            {state.status === "timeout" ? "No message came in time. " : state.status === "failed" ? `Household could not read the bot's messages (${state.error}). ` : "Household already runs this bot, so it cannot wait for your message here. "}
            Enter your numeric Telegram id instead (<a className="text-link" href="https://t.me/userinfobot" target="_blank" rel="noreferrer">@userinfobot</a> tells it).
          </p>
          <TextField label="Your Telegram id" mono inputMode="numeric" value={manual} onChange={setManual} placeholder="123456789" />
        </Stack>
      )}
      {action.shown}
    </Screen>
  );
}

function SlackTokens({ option, back, onDone }: { option: ChannelOption; back: () => void; onDone: (tokens: { token: string; appToken: string }) => void }) {
  const [token, setToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const action = useAction();
  return (
    <Screen title={option.label} back={back} primary={<button className="btn primary" disabled={!token.trim() || !appToken.trim()} onClick={() => action.run(async () => {
      if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(token.trim())) throw new Error("Paste the Bot User OAuth Token (xoxb-…).");
      if (!/^xapp-[A-Za-z0-9-]{20,}$/.test(appToken.trim())) throw new Error("Paste the app-level token (xapp-…).");
      onDone({ token: token.trim(), appToken: appToken.trim() });
    })}>Next</button>}>
      <Guide steps={option.steps} />
      <TextField label="Bot token" type="password" mono value={token} onChange={setToken} placeholder="xoxb-…" />
      <TextField label="App-level token" type="password" mono value={appToken} onChange={setAppToken} placeholder="xapp-…" />
      {action.shown}
    </Screen>
  );
}

function SlackOwner({ house, tokens, back, refresh, onDone }: { house: string; tokens: { token: string; appToken: string }; back: () => void; refresh: () => Promise<void>; onDone: () => void }) {
  const [member, setMember] = useState("");
  const action = useAction();
  return (
    <Screen title="Your Slack account" hint="You become the workspace's owner. Household finds your DM with the app; nothing is sent." back={back} primary={
      <button className="btn primary" disabled={action.busy || !member.trim()} onClick={() => action.run(async () => {
        const found = await api.resolveSlack(house, tokens.token, tokens.appToken, member.trim());
        await api.addChannel(house, "slack-private", { chat: found.chat, slackMember: member.trim(), own: tokens, name: null, note: null, pets: [], default: null });
        await refresh();
        onDone();
      })}>{action.busy ? "Connecting…" : "Connect Slack"}</button>
    }>
      <Guide steps={SLACK_MEMBER_STEPS} />
      <TextField label="Member ID" mono value={member} onChange={setMember} placeholder="U0123456789" />
      {action.shown}
    </Screen>
  );
}

// ── Bot: what it is for, then its details ───────────────────────────────────────────────────────────────────

function BotStep({ sub, go, house, keyView, agents, refresh, notify, onDone }: { sub: number; go: (sub: number) => void; house: WorkspaceView; keyView: KeyView; agents: HarnessView[]; refresh: () => Promise<void>; notify: Notify; onDone: (bot: string) => void }) {
  const [presetId, setPresetId] = useState(BOT_PRESETS[0]!.id);
  const preset = BOT_PRESETS.find((each) => each.id === presetId)!;
  const taken = house.pets.map((pet) => pet.name);
  const [name, setName] = useState(() => freeName(taken, preset.name));
  const [title, setTitle] = useState(preset.title);
  const [emoji, setEmoji] = useState(preset.emoji);
  const [scouts, setScouts] = useState(preset.scouts);
  const [sideworkers, setSideworkers] = useState(preset.sideworkers);
  const available = house.resources?.available ?? { cpus: preset.cpus, memoryMiB: preset.memoryMiB };
  const resources = { cpus: Math.max(1, Math.min(preset.cpus, available.cpus)), memoryMiB: Math.max(512, Math.min(preset.memoryMiB, available.memoryMiB)) };
  const action = useAction();
  const agent = agents.find((each) => each.name === PROVIDERS.find((provider) => provider.id === keyView.provider)?.harness);
  const channels = house.channels.map((channel) => channel.chat);
  const nameError = name && !BOT_NAME.test(name) ? "Use a lowercase letter first, then a–z, 0–9, _ or -." : taken.includes(name) ? `${name} is in the workspace already.` : undefined;
  const choose = (id: string) => {
    const next = BOT_PRESETS.find((each) => each.id === id)!;
    setPresetId(id);
    setName(freeName(taken, next.name));
    setTitle(next.title);
    setEmoji(next.emoji);
    setScouts(next.scouts);
    setSideworkers(next.sideworkers);
  };

  if (sub === 0) {
    return (
      <Screen title="What is your first bot for?" hint={`It runs ${agent?.name === "codex-app-server" ? "Codex" : "Claude Code"} in its own VM, with a home and memory that stay between sessions. Everything can be changed later.`}
        primary={<button className="btn primary" onClick={() => go(1)}>Next</button>}>
        <ChoiceList label="Purpose" value={presetId} onChange={choose} options={BOT_PRESETS.map((each) => ({ value: each.id, label: `${each.emoji} ${each.label}`, description: each.description }))} />
      </Screen>
    );
  }
  return (
    <Screen title={`${preset.emoji} ${preset.label}`} back={() => go(0)} primary={
      <button className="btn primary" disabled={action.busy || !name || !!nameError || !agent} onClick={() => action.run(async () => {
        await api.addBot(house.name, name, {
          title: title.trim() || null, emoji: emoji.trim() || null, aliases: [],
          agent: agent!.name, model: agent!.defaultModel, mode: agent!.defaultMode, key: keyView.name, ...resources,
        }, channels);
        await api.setWorkspaceFeatures(house.name, { features: { ...houseFeatures(house), scouts, sideworkers }, preview: previewSettings(house) });
        const role = presetInstructions(preset, title.trim() || name);
        if (role) {
          try {
            const file = await api.instructions(house.name, name);
            await api.saveInstructions(house.name, name, `${file.content.trimEnd()}\n\n${role}\n`, file.revision);
          } catch (error) {
            notify(`${name} was created, but its instructions were not set: ${message(error)}`, true);
          }
        }
        await refresh();
        onDone(name);
      })}>{action.busy ? "Creating…" : "Create bot"}</button>
    }>
      <FormGrid>
        <TextField label="Display name" value={title} onChange={setTitle} maxLength={64} />
        <TextField label="Emoji" value={emoji} onChange={setEmoji} />
      </FormGrid>
      <TextField label="Name" mono value={name} onChange={setName} maxLength={31} error={nameError} hint="Its id: lowercase, no spaces." />
      <Stack gap={2}>
        <Switch label="Scouts" on={scouts} onChange={setScouts} />
        <p className="hint">One-task helpers in their own VMs (a browser, media and dev tools). The bot calls one; you approve each run in the chat.</p>
      </Stack>
      <Stack gap={2}>
        <Switch label="Sideworkers" on={sideworkers} onChange={setSideworkers} />
        <p className="hint">Extra bots for longer work, that you can talk to in parallel. Your bot starts each in its own VM and gives it the CPU and memory the job needs, from what the workspace has free.</p>
      </Stack>
      <p className="hint">
        Reserves {resources.cpus} vCPU and {gib(resources.memoryMiB)} of the workspace's budget; runs on key <span className="id">{keyView.name}</span>.
        {channels.length === 0 ? " It joins no channel yet: add one on the workspace's Channels page." : ""}
      </p>
      {!agent && <p className="error">This Household has no harness for {keyView.provider} keys.</p>}
      {action.shown}
    </Screen>
  );
}

// ── Say hi ──────────────────────────────────────────────────────────────────────────────────────────────────

function DoneStep({ house, bot, channel }: { house: WorkspaceView; bot: string; channel?: Connected }) {
  const pet = house.pets.find((each) => each.name === bot);
  const state = pet ? petState(pet.state) : undefined;
  const group = channel?.kind === "telegram-group";
  const link = !group && channel?.bot?.startsWith("@") ? `https://t.me/${channel.bot.slice(1)}` : undefined;
  const where = channel?.kind === "telegram-private" ? ". It answers in its own thread." : ".";
  return (
    <Screen title={`${pet?.display ?? bot} is ready`} hint="The first start downloads the bot's VM image: give it a minute or two."
      primary={<button className="btn primary" onClick={() => navigate(workspacePath(house.name))}>Open workspace</button>}
      extra={<Link className="btn" href={botPath(house.name, bot)}>Bot settings</Link>}
    >
      {state && <p className="setup-state"><span className={`dot ${state.tone}`} aria-hidden />{state.label}</p>}
      {link && <p>Now write to it: open <a className="text-link" href={link} target="_blank" rel="noreferrer">{link}</a>{where}</p>}
      {group && <p>Now write to it in your Telegram group: it has its own topic there.</p>}
      {channel?.kind === "slack-private" && <p>Now write to it in your DM with the Slack app.</p>}
      {!channel && <p className="hint">Connect a channel on the workspace's Channels page to talk to it.</p>}
      <p className="hint">Another workspace? <Link className="text-link" href="/setup">Set one up</Link>.</p>
    </Screen>
  );
}
