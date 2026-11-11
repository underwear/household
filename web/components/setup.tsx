import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { gib, type HostCapacity } from "../../src/core/resources";
import { api, type BotListenStatus, type BotListenView, type DeviceLoginView, type KeyView, type OnboardingView, type SetupFields, type WorkspaceView } from "../api";
import { botPath, navigate, workspacePath } from "../router";
import { ChoiceList, StepperField, Switch, TextField } from "./fields";
import { Cell, Cluster, FormGrid, List, ListRow, Page, Panel, Stack } from "./layout";
import { Link } from "./link";
import { petState } from "./bot-state";
import { CHANNELS, DEFAULT_BOT, KEY_METHODS, PROVIDERS, SLACK_MEMBER_STEPS, TELEGRAM_GROUP_ID, TELEGRAM_USER_ID, defaultBotSize, guidePieces, suggestedBudget, type ChannelOption, type KeyMethod, type Provider } from "../../src/core/onboarding";

/** The setup's steps, each with its own screens (listed under it in the stepper while it is the current one). */
export const SETUP_STEPS = [
  { id: "model", label: "Model", subs: ["Provider", "Sign-in", "Connect"] },
  { id: "workspace", label: "Workspace", subs: [] },
  { id: "channel", label: "Channel", subs: ["Messenger", "Setup", "Check"] },
  { id: "review", label: "Review", subs: [] },
] as const;
type StepId = (typeof SETUP_STEPS)[number]["id"];

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

const freeName = (taken: string[], base: string) => {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const providerLabel = (provider: string) => PROVIDERS.find((each) => each.id === provider)?.label ?? provider;

/** The key chosen: one there is (or one a sign-in just saved), or one pasted here, saved with the rest. */
export interface KeyDraft { name: string; provider: Provider; label: string; pasted?: string }
export interface WorkspaceDraft { name: string; cpus: number; memoryMiB: number }
/** The channel chosen, checked with its service: a Telegram bot waited on and its owner, or a Slack app and its owner. */
export interface ChannelDraft {
  kind: ChannelOption["kind"];
  label: string;
  /** A Telegram bot's @username. */
  bot?: string;
  /** The bot watched (`listen`), its owner, and for a group the group found (or typed, for a bot that could not be watched). */
  telegram?: { listen: string; owner: { id: string; name?: string }; group?: { id: string; title: string } };
  slack?: { token: string; appToken: string; member: string; owner: string };
}
/** Everything chosen so far; a channel of null was skipped. */
export interface SetupDraft { key?: KeyDraft; workspace?: WorkspaceDraft; channel?: ChannelDraft | null }

export interface SetupProps {
  houses: WorkspaceView[];
  keys: KeyView[];
  agents: { name: string }[];
  host: HostCapacity;
  refresh: () => Promise<void>;
  /** Where to start (tests). */
  initial?: SetupDraft;
}

/**
 * Household · Setup: from nothing to a bot answering in a messenger, as `house onboard` does, one choice at a
 * time: what to choose, then how to get what that choice needs, then the field for it. The steps only gather and
 * check (a bot's token, its owner and group, a Slack DM); Review makes it all at once, with setup's own bot and one
 * reload. A ChatGPT sign-in is the exception: it saves its key as it ends. The stepper shows what was chosen; a step
 * done opens again until it is all made.
 */
export function SetupPage({ houses, keys, agents, host, refresh, initial = {} }: SetupProps) {
  const [draft, setDraft] = useState<SetupDraft>(initial);
  const [made, setMade] = useState<{ house: WorkspaceView; channel?: ChannelDraft; applying: boolean }>();
  const done: Record<StepId, boolean> = { model: !!draft.key, workspace: !!draft.workspace, channel: draft.channel !== undefined, review: !!made };
  const firstOpen = SETUP_STEPS.find((step) => !done[step.id])?.id ?? "review";
  const [at, setAt] = useState<{ step: StepId; sub: number }>({ step: firstOpen, sub: 0 });

  /** A choice made: kept, and on to the first step still open after it. */
  const choose = <K extends keyof SetupDraft>(from: StepId, key: K, value: SetupDraft[K]) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    const now = { model: !!next.key, workspace: !!next.workspace, channel: next.channel !== undefined, review: false };
    const index = SETUP_STEPS.findIndex((step) => step.id === from);
    const open = SETUP_STEPS.slice(index + 1).find((step) => !now[step.id]) ?? SETUP_STEPS.at(-1)!;
    setAt({ step: open.id, sub: 0 });
  };
  const go = (sub: number) => setAt({ step: at.step, sub });
  const summary: Record<StepId, string | undefined> = {
    model: draft.key && `${providerLabel(draft.key.provider)} · ${draft.key.name}`,
    workspace: draft.workspace && `${draft.workspace.name} · ${draft.workspace.cpus} vCPU · ${gib(draft.workspace.memoryMiB)}`,
    channel: draft.channel === null ? "Skipped" : draft.channel ? [draft.channel.label, draft.channel.bot].filter(Boolean).join(" · ") : undefined,
    review: undefined,
  };
  // Once it is all made, nothing goes back; until then, any step chosen, and the first open one.
  const reachable = (step: StepId) => !made && (step === firstOpen || done[step]);

  return (
    <Page title="Set up Household">
      <div className="setup">
        <nav className="setup-stepper" aria-label="Setup steps">
          <ol>
            {SETUP_STEPS.map((step, index) => {
              const state = step.id === at.step ? "current" : done[step.id] ? "done" : "todo";
              const head = (
                <>
                  <span className="setup-mark" aria-hidden>{state === "done" || (state === "current" && made) ? <Check size={12} strokeWidth={2.5} /> : index + 1}</span>
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
          {at.step === "model" && <ModelStep sub={at.sub} go={go} keys={keys} refresh={refresh} onDone={(key) => choose("model", "key", key)} />}
          {at.step === "workspace" && <WorkspaceStep houses={houses} host={host} chosen={draft.workspace} onDone={(workspace) => choose("workspace", "workspace", workspace)} />}
          {at.step === "channel" && draft.workspace && (
            <ChannelStep sub={at.sub} go={go} house={draft.workspace.name} onDone={(channel) => choose("channel", "channel", channel)} onSkip={() => choose("channel", "channel", null)} />
          )}
          {at.step === "channel" && !draft.workspace && <Missing step="Workspace" onOpen={() => setAt({ step: "workspace", sub: 0 })} />}
          {at.step === "review" && !made && <ReviewStep draft={draft} agents={agents} open={(step) => setAt({ step, sub: 0 })} refresh={refresh}
            onMade={(house, applying) => setMade({ house, applying, ...(draft.channel ? { channel: draft.channel } : {}) })} />}
          {at.step === "review" && made && <DoneStep house={houses.find((each) => each.name === made.house.name) ?? made.house} channel={made.channel} applying={made.applying} />}
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

/** A step that needs an earlier one first. */
function Missing({ step, onOpen }: { step: string; onOpen: () => void }) {
  return <Screen title={`Choose the ${step.toLowerCase()} first`} primary={<button className="btn primary" onClick={onOpen}>{step}</button>} />;
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

function ModelStep({ sub, go, keys, refresh, onDone }: { sub: number; go: (sub: number) => void; keys: KeyView[]; refresh: () => Promise<void>; onDone: (key: KeyDraft) => void }) {
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
          if (known) return onDone({ name: known.name, provider: known.provider as Provider, label: known.kind ?? "key" });
          setMethodId(undefined);
          go(1);
        }}>Next</button>
      }>
        {fitting.length > 0 && (
          <ChoiceList label="Saved keys" value={choice} onChange={setChoice} options={fitting.map((key) => ({
            value: `key:${key.name}`,
            label: <span className="mono">{key.name}</span>,
            description: `${providerLabel(key.provider)} · ${key.kind ?? "key"}${key.note ? ` · ${key.note}` : ""}`,
          }))} />
        )}
        <ChoiceList label={fitting.length ? "Add a new key" : "Provider"} value={choice} onChange={setChoice}
          options={PROVIDERS.map((each) => ({ value: each.id, label: each.label, description: each.description }))} />
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

function KeyConnect({ method, keys, back, refresh, onDone }: { method: KeyMethod; keys: KeyView[]; back: () => void; refresh: () => Promise<void>; onDone: (key: KeyDraft) => void }) {
  const [value, setValue] = useState("");
  const [login, setLogin] = useState<DeviceLoginView>();
  const action = useAction();
  const name = freeName(keys.map((key) => key.name), method.name);
  const { input } = method;
  const draft = (pasted?: string): KeyDraft => ({ name, provider: method.provider, label: method.label, ...(pasted ? { pasted } : {}) });

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
        else void action.run(async () => { await refresh(); onDone(draft()); });
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
      await refresh();
      return onDone(draft());
    }
    if (input.kind === "device") return setLogin(await api.startChatgptLogin(name));
    const token = value.trim();
    if (!token.startsWith(input.prefix)) throw new Error(input.wrong);
    onDone(draft(token));
  });
  const label = input.kind === "device" ? "Sign in with ChatGPT" : input.kind === "local" ? "Use this login" : "Next";

  return (
    <Screen
      title={method.label}
      hint={input.kind === "paste" ? <>Saved as key <span className="id">{name}</span> when you set it all up. Manage keys later in Settings.</> : <>Saved as key <span className="id">{name}</span> as soon as you are signed in.</>}
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

function WorkspaceStep({ houses, host, chosen, onDone }: { houses: WorkspaceView[]; host: HostCapacity; chosen?: WorkspaceDraft; onDone: (workspace: WorkspaceDraft) => void }) {
  const [name, setName] = useState(() => chosen?.name ?? freeName(houses.map((house) => house.name), "home"));
  const taken = houses.reduce((sum, house) => ({ cpus: sum.cpus + (house.resources?.total.cpus ?? 0), memoryMiB: sum.memoryMiB + (house.resources?.total.memoryMiB ?? 0) }), { cpus: 0, memoryMiB: 0 });
  const [cpus, setCpus] = useState(() => String(chosen?.cpus ?? suggestedBudget(host).cpus));
  const [memory, setMemory] = useState(() => String((chosen?.memoryMiB ?? suggestedBudget(host).memoryMiB) / 1024));
  const nameError = name && !NAME.test(name) ? "Use a lowercase letter first, then a–z, 0–9 or -." : houses.some((house) => house.name === name) ? `${name} exists already.` : undefined;
  const over = Number(cpus) + taken.cpus > host.cpus || Number(memory) * 1024 + taken.memoryMiB > host.memoryMiB;
  return (
    <Screen
      title="Name your workspace"
      hint="A workspace is a trust zone: its own bots, network allowlist, secrets, channels and owners."
      primary={<button className="btn primary" disabled={!name || !!nameError} onClick={() => onDone({ name, cpus: Number(cpus), memoryMiB: Number(memory) * 1024 })}>Next</button>}
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
    </Screen>
  );
}

// ── Channel: a messenger, what it needs, then who owns it ───────────────────────────────────────────────────

export function ChannelStep({ sub, go, house, onDone, onSkip }: { sub: number; go: (sub: number) => void; house: string; onDone: (channel: ChannelDraft) => void; onSkip: () => void }) {
  const [kind, setKind] = useState<ChannelOption["kind"]>(CHANNELS[0]!.kind);
  const option = CHANNELS.find((each) => each.kind === kind)!;
  // What the Setup screen got, for the Check screen.
  const [listen, setListen] = useState<BotListenView>();
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
      : <TelegramBot option={option} house={house} back={() => go(0)} onDone={(started) => { setListen(started); go(2); }} />;
  }
  return kind === "slack-private"
    ? <SlackOwner house={house} tokens={slack!} back={() => go(1)} onDone={(member, owner) => onDone({ kind, label: option.label, slack: { ...slack!, member, owner } })} />
    : <TelegramCheck listen={listen!} back={() => go(1)}
      onDone={(owner, group) => onDone({ kind, label: option.label, bot: listen!.bot, telegram: { listen: listen!.id, owner, ...(group ? { group } : {}) } })} />;
}

function TelegramBot({ option, house, back, onDone }: { option: ChannelOption; house: string; back: () => void; onDone: (listen: BotListenView) => void }) {
  const [token, setToken] = useState("");
  const action = useAction();
  return (
    <Screen title={option.label} back={back} primary={
      <button className="btn primary" disabled={action.busy || !token.trim()} onClick={() => action.run(async () => onDone(await api.listenBot(house, option.kind, token.trim())))}>
        {action.busy ? "Checking…" : "Check the bot"}
      </button>
    }>
      <Guide steps={option.steps} />
      <TextField label="Bot token" type="password" mono value={token} onChange={setToken} placeholder="123456789:AAH…" />
      {action.shown}
    </Screen>
  );
}

/** A line of the check: done, or what is still to do. */
function CheckLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <li className={ok ? "done" : undefined}><span className="setup-check-mark" aria-hidden>{ok ? <Check size={12} strokeWidth={2.5} /> : "…"}</span><span>{children}</span></li>;
}

/**
 * The bot watched: its owner (the first to write to it in private) and, for a group, the group it is in, found by
 * itself and checked (Topics on, the bot an admin that may manage topics and delete messages), each line ticked as
 * it comes. A bot Household runs already, or a watch that ended, takes typed ids instead.
 */
function TelegramCheck({ listen, back, onDone }: { listen: BotListenView; back: () => void; onDone: (owner: { id: string; name?: string }, group?: { id: string; title: string }) => void }) {
  const [state, setState] = useState<BotListenStatus>({ status: "waiting", needsGroup: false });
  const [manual, setManual] = useState("");
  const [manualGroup, setManualGroup] = useState("");
  /** Why the watch is gone (Household restarted, or forgot it): only Back is left, to give the token again. */
  const [gone, setGone] = useState<string>();
  const action = useAction();

  // The watch: asked about every two seconds while it goes on.
  useEffect(() => {
    if (state.status !== "waiting" || gone) return;
    const ask = () => void api.botListen(listen.id).then(setState, (error) => { if (error instanceof Error && error.message.startsWith("no such")) setGone(error.message); });
    ask();
    const timer = setInterval(ask, 2000);
    return () => clearInterval(timer);
  }, [listen.id, state.status, gone]);

  const again = () => action.run(async () => setState(await api.listenAgain(listen.id)));
  const recheck = () => action.run(async () => setState(await api.checkGroup(listen.id)));
  const typed = state.status === "timeout" || state.status === "failed" || state.status === "manual";
  const group = state.group;
  const groupReady = !state.needsGroup || (!!group && group.problems.length === 0);
  const ready = !!state.contact && groupReady;
  const typedReady = TELEGRAM_USER_ID.test(manual.trim()) && (!state.needsGroup || groupReady || TELEGRAM_GROUP_ID.test(manualGroup.trim()));
  const next = () => {
    if (ready) return onDone({ id: state.contact!.id, name: state.contact!.name }, group && { id: group.id, title: group.title });
    onDone({ id: manual.trim() }, group && groupReady ? { id: group.id, title: group.title } : state.needsGroup ? { id: manualGroup.trim(), title: manualGroup.trim() } : undefined);
  };

  return (
    <Screen title={`Connect ${listen.bot}`} back={back}
      primary={!gone && <button className="btn primary" disabled={!(ready || (typed && typedReady))} onClick={next}>Next</button>}
      extra={!gone && state.contact && <button className="btn" onClick={again}>Not me</button>}
    >
      {gone && <p className="error" role="alert">{gone}</p>}
      {!gone && (
        <ol className="setup-check">
          <CheckLine ok={!!state.contact}>
            {state.contact
              ? <>Owner: <b>{state.contact.name}</b>{state.contact.username ? ` (@${state.contact.username})` : ""}</>
              : <>Open <a className="text-link" href={listen.link} target="_blank" rel="noreferrer">{listen.link}</a> and send the bot any message in a private chat (pressing <b>Start</b> works): you become the workspace's owner.</>}
          </CheckLine>
          {state.needsGroup && (
            <CheckLine ok={groupReady}>
              {!group && <>Add the bot to your group as an admin (Manage topics, Delete messages); if it is in the group already, send <code>/start@{listen.bot.replace(/^@/, "")}</code> there. Household finds it by itself.</>}
              {group && group.problems.length === 0 && <>Group: <b>{group.title}</b></>}
              {group && group.problems.length > 0 && (
                <Stack gap={2}>
                  <span>Group <b>{group.title}</b> still needs: {group.problems.join("; ")}.</span>
                  <span><button type="button" className="btn small" disabled={action.busy} onClick={recheck}>Check again</button></span>
                </Stack>
              )}
            </CheckLine>
          )}
        </ol>
      )}
      {!gone && state.status === "waiting" && !ready && <p className="hint">Waiting…</p>}
      {!gone && typed && !ready && (
        <Stack gap={3}>
          <p className="hint">
            {state.status === "timeout" ? "Nothing came in time. " : state.status === "failed" ? `Household could not read the bot's messages (${state.error}). ` : "Household already runs this bot, so it cannot watch it here. "}
            Enter the ids instead (<a className="text-link" href="https://t.me/userinfobot" target="_blank" rel="noreferrer">@userinfobot</a> tells yours){state.status !== "manual" && <>, or <button type="button" className="text-btn plain" onClick={again}>wait again</button></>}.
          </p>
          {!state.contact && <TextField label="Your Telegram id" mono inputMode="numeric" value={manual} onChange={setManual} placeholder="123456789" />}
          {state.needsGroup && !groupReady && <TextField label="Group id" mono value={manualGroup} onChange={setManualGroup} placeholder="-1001234567890" hint="In Telegram Web, the part of the group's address after #." />}
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

function SlackOwner({ house, tokens, back, onDone }: { house: string; tokens: { token: string; appToken: string }; back: () => void; onDone: (member: string, owner: string) => void }) {
  const [member, setMember] = useState("");
  const action = useAction();
  return (
    <Screen title="Your Slack account" hint="You become the workspace's owner. Household finds your DM with the app; nothing is sent." back={back} primary={
      <button className="btn primary" disabled={action.busy || !member.trim()} onClick={() => action.run(async () => {
        const found = await api.findSlackDm(house, tokens.token, tokens.appToken, member.trim());
        onDone(member.trim(), found.owner);
      })}>{action.busy ? "Finding your DM…" : "Next"}</button>
    }>
      <Guide steps={SLACK_MEMBER_STEPS} />
      <TextField label="Member ID" mono value={member} onChange={setMember} placeholder="U0123456789" />
      {action.shown}
    </Screen>
  );
}

// ── Review: everything chosen, made at once ─────────────────────────────────────────────────────────────────

/** The setup's choices as the one request that makes them; undefined while one is missing. */
export function setupFields(draft: SetupDraft): SetupFields | undefined {
  const { key, workspace, channel } = draft;
  if (!key || !workspace || channel === undefined) return undefined;
  return {
    key: key.pasted ? { name: key.name, provider: key.provider, value: key.pasted, note: key.label } : key.name,
    workspace,
    channel: channel?.telegram ? { telegram: { listen: channel.telegram.listen, owner: channel.telegram.owner.id, ...(channel.telegram.group ? { chat: channel.telegram.group.id } : {}) } }
      : channel?.slack ? { slack: { token: channel.slack.token, appToken: channel.slack.appToken, member: channel.slack.member } }
      : null,
  };
}

export function ReviewStep({ draft, agents, open, refresh, onMade }: { draft: SetupDraft; agents: { name: string }[]; open: (step: StepId) => void; refresh: () => Promise<void>; onMade: (house: WorkspaceView, applying: boolean) => void }) {
  const action = useAction();
  const [slow, setSlow] = useState(false);
  const fields = setupFields(draft);
  const { key, workspace, channel } = draft;
  const harness = PROVIDERS.find((provider) => provider.id === key?.provider)?.harness;
  const size = workspace && defaultBotSize(workspace);
  const row = (step: StepId | undefined, title: string, value: ReactNode, detail?: ReactNode) => (
    <ListRow key={title} actions={step && !action.busy ? <button type="button" className="btn small" onClick={() => open(step)}>Change</button> : undefined}>
      <Cell><span className="strong">{title}</span></Cell>
      <Cell><span className="cell-lines"><span>{value}</span>{detail && <span className="hint">{detail}</span>}</span></Cell>
    </ListRow>
  );
  const owner = channel?.telegram ? [`owner ${channel.telegram.owner.name ?? channel.telegram.owner.id}`, channel.telegram.group && `group ${channel.telegram.group.title}`].filter(Boolean).join(" · ") : channel?.slack ? `owner ${channel.slack.owner}` : undefined;
  return (
    <Screen title="Ready to set it all up" hint="Nothing is made yet. One press makes all of it; if anything fails, nothing is left half made."
      primary={<button className="btn primary" disabled={!fields || action.busy || !agents.some((each) => each.name === harness)} onClick={() => action.run(async () => {
        const timer = setTimeout(() => setSlow(true), 4000);
        try {
          const made = await api.setUp(fields!);
          await refresh();
          onMade(made.house!, !!made.applying);
        } finally {
          clearTimeout(timer);
          setSlow(false);
        }
      })}>{action.busy ? "Setting up…" : "Set it all up"}</button>}
    >
      <List columns="minmax(0, 0.5fr) minmax(0, 1.5fr) auto">
        {row("model", "Model", key ? `${providerLabel(key.provider)} · key ${key.name}` : "—", key?.pasted ? "pasted here; saved with the rest" : undefined)}
        {row("workspace", "Workspace", workspace ? workspace.name : "—", workspace && `${workspace.cpus} vCPU · ${gib(workspace.memoryMiB)}`)}
        {row("channel", "Channel", channel === null ? "None yet" : channel ? [channel.label, channel.bot].filter(Boolean).join(" · ") : "—", owner)}
        {row(undefined, "Bot", `🤖 ${DEFAULT_BOT.title}`, size && `${harness === "codex-app-server" ? "Codex" : "Claude Code"} · ${size.cpus} vCPU · ${gib(size.memoryMiB)}`)}
      </List>
      {action.busy && <p className="setup-state"><span className="dot busy" aria-hidden />Got everything. Setting it up, please wait…</p>}
      {slow && <p className="hint">Still setting up: Household applies changes one at a time, and a bot that is starting holds them for a moment.</p>}
      {action.shown}
    </Screen>
  );
}

// ── Done ────────────────────────────────────────────────────────────────────────────────────────────────────

function DoneStep({ house, channel, applying }: { house: WorkspaceView; channel?: ChannelDraft; applying: boolean }) {
  const pet = house.pets.find((each) => !each.sideworker);
  const state = pet ? petState(pet.state) : undefined;
  const group = channel?.kind === "telegram-group";
  const link = !group && channel?.bot?.startsWith("@") ? `https://t.me/${channel.bot.slice(1)}` : undefined;
  const where = channel?.kind === "telegram-private" ? ". It answers in its own thread." : ".";
  return (
    <Screen title={`${pet?.display ?? "Your bot"} is ready`} hint={applying ? "Household is still applying it: the bot starts in a minute or two (its first start downloads its VM image)." : "The first start downloads the bot's VM image: give it a minute or two."}
      primary={<button className="btn primary" onClick={() => navigate(workspacePath(house.name))}>Open workspace</button>}
      extra={pet && <Link className="btn" href={botPath(house.name, pet.name)}>Bot settings</Link>}
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
