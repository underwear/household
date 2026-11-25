import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { houseFeatures } from "../../src/core/house-features";
import type { WorkspaceView } from "../api";
import { scoutDraftApi, type ScoutDraftApply, type ScoutDraftKey, type ScoutDraftSummary, type ScoutDraftView } from "../scout-api";
import { navigate, scoutDraftPath, scoutPath, workspacePath } from "../router";
import { useDialog } from "./dialog";
import { ChoiceList } from "./fields";
import { Cell, Cluster, List, ListRow, Page, Section, Stack } from "./layout";
import { Link } from "./link";
import { ago } from "./capabilities";
import { ROUTINE_WARNING, routineBots, routineToggleable } from "./scouts";

type Notify = (text: string, warning?: boolean) => void;

/**
 * The owner's decisions on a draft, as the review page holds them. Nothing is preselected that changes access: no key
 * choice, no bot; who runs it starts at "ask every time", and a stale draft at "not confirmed".
 */
export interface DraftDecision {
  keys?: "keep" | "drop";
  routine: "ask" | "bots";
  bots: string[];
  /** The owner confirmed applying it over what changed since it was drafted. */
  force: boolean;
}
export const FIRST_DECISION: DraftDecision = { routine: "ask", bots: [], force: false };

/**
 * The hosts the result reaches that the scout does not reach now; `opens`: it would reach the open internet, which it
 * does not now. A new scout has no now: nothing is marked.
 */
export function newHosts(view: Pick<ScoutDraftView, "network" | "currentNetwork">): { opens: boolean; hosts: string[] } {
  const now = view.currentNetwork;
  if (!now || now.open) return { opens: false, hosts: [] };
  if (view.network.open) return { opens: true, hosts: [] };
  return { opens: false, hosts: view.network.allow.filter(host => !now.allow.includes(host)) };
}

/**
 * What Apply sends: only what the owner decided, and what they decided on (the view's fingerprint: the daemon refuses
 * the apply if any of it moved since). The bots in the workspace's order (a sideworker is never one), a key choice only
 * where keys are at stake, force only for a stale draft. Nothing decided: every run asks.
 */
export function draftApplyBody(view: Pick<ScoutDraftView, "keyGate" | "stale" | "reviewed">, decision: DraftDecision, pets: WorkspaceView["pets"]): ScoutDraftApply {
  const bots = decision.routine === "bots" ? routineBots(pets).map(pet => pet.name).filter(name => decision.bots.includes(name)) : [];
  return {
    reviewed: view.reviewed,
    ...(bots.length ? { routine: bots } : {}),
    ...(view.keyGate && decision.keys ? { keys: decision.keys } : {}),
    ...(view.stale && decision.force ? { force: true as const } : {}),
  };
}

/**
 * The owner's decisions after the view was read again: each holds only for what it was made on. A changed fingerprint
 * (keys at stake, hosts, the scout as it is…) clears every choice: the keys, the stale confirmation, the bots (back to
 * Ask every time). A gate that appeared asks; one that went leaves nothing behind.
 */
export function reconcileDecision(before: Pick<ScoutDraftView, "reviewed" | "routineBlocker">, after: Pick<ScoutDraftView, "reviewed" | "routineBlocker">, decision: DraftDecision): DraftDecision {
  const next = { ...decision };
  if (before.reviewed !== after.reviewed || before.routineBlocker !== after.routineBlocker) { delete next.keys; next.force = false; next.routine = "ask"; next.bots = []; }
  return next;
}

/** Why Apply cannot be pressed yet, in words, one per decision still missing; none: it can. `scoutsOn`: the workspace's scouts feature. */
export function draftApplyBlockers(view: Pick<ScoutDraftView, "keyGate" | "stale" | "routineBlocker" | "problems">, decision: DraftDecision, scoutsOn = true): string[] {
  return [
    ...(scoutsOn ? [] : ["Scouts are off in this workspace: turn them on in its settings to apply a draft."]),
    ...(view.problems.length ? [`It cannot be applied as it is: ${view.problems.join("; ")}.`] : []),
    ...(view.keyGate && !decision.keys ? ["Choose what happens to the keys at stake."] : []),
    ...(view.keyGate && decision.keys === "drop" && !view.keyGate.choices.includes("drop") ? ["The keys at stake come with shared capabilities: keep them, or decline the draft."] : []),
    ...(decision.routine === "bots" && view.routineBlocker ? [`${view.routineBlocker}: it cannot run without asking.`] : []),
    ...(decision.routine === "bots" && !view.routineBlocker && !decision.bots.length ? ["Tick the bots that run it without asking, or choose Ask every time."] : []),
    ...(view.stale && !decision.force ? ["Confirm applying it over what changed since it was drafted."] : []),
  ];
}

/** Which part of the review a refusal from the daemon is about, so it shows next to that control. `applied`: it went in. */
export type RefusalAt = "keys" | "routine" | "stale" | "apply";
export function draftRefusal(message: string): { at: RefusalAt; applied: boolean } {
  if (/^applied/.test(message)) return { at: "apply", applied: true };
  if (/^This change puts keys|cannot be dropped/.test(message)) return { at: "keys", applied: false };
  if (/changed since it was drafted|changed while the draft was being applied/.test(message)) return { at: "stale", applied: false };
  if (/without asking|not a bot of this workspace/.test(message)) return { at: "routine", applied: false };
  return { at: "apply", applied: false };
}

/** How long a text is in lines, said above it: what reading it takes. */
export const lineCount = (text: string) => { const count = text.trimEnd() ? text.trimEnd().split("\n").length : 0; return `${count} ${count === 1 ? "line" : "lines"}`; };
/** A capability's hosts in words: "only a, b"; none listed (a tool): it adds no limit of its own. */
export const hostWords = (hosts: string[] | null) => hosts?.length ? `only ${hosts.join(", ")}` : "no network limit of its own";
/** A key in words: "METER_PASSWORD · own setup · value in its VM". */
const keyLine = (key: ScoutDraftKey) => `${key.source} · ${key.via === "vm" ? "value in its VM" : "gateway placeholder"}${key.keptWith?.length ? ` · kept, with a changed ${key.keptWith.join(" and ")}` : ""}`;
/** Household's own words as a sentence: its first letter up. */
const sentence = (text: string) => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
const shown = (scout: { name: string; title?: string; emoji?: string }) => `${scout.emoji ?? "🧭"} ${scout.title ?? scout.name}`;

/** The drafts waiting on the Scouts page: who proposed what, new or a change, when; stale and asking for routine marked. */
export function ScoutDrafts({ house, drafts }: { house: string; drafts: ScoutDraftSummary[] }) {
  if (!drafts.length) return null;
  return (
    <Section title="Drafts" hint="Scouts your bots proposed. Nothing changes until you apply one.">
      <List>
        {drafts.map(draft => (
          <ListRow key={draft.id} actions={<Link href={scoutDraftPath(house, draft.id)} className="btn small">Review</Link>}>
            <Cell lines>
              <span><span className="strong">{draft.petTitle}</span> proposes {draft.change ? "a change to" : "a new scout,"} <span className="mono">{draft.scout}</span></span>
              <span className="cluster gap-1">
                <span className="hint">{ago(draft.at)}</span>
                {draft.stale && <span className="tag danger" title="The scout changed since it was drafted">Stale</span>}
                {draft.wantsRoutine && <span className="tag busy">Asks to run without asking</span>}
              </span>
            </Cell>
          </ListRow>
        ))}
      </List>
    </Section>
  );
}

/** One field of a draft: as proposed, and for a change, as it is now when it differs. `block`: a script, whole. */
function BeforeAfter({ label, before, after, block = false, by }: { label: string; before?: string; after: string; block?: boolean; /** Who proposed it: a bot's words are labelled as its. */ by?: string }) {
  // A script's length is said above it: hidden text could not shorten what there is to read.
  const value = (text: string) => block ? <><span className="hint">{lineCount(text)}</span><pre className="command-output tall">{text || "(empty)"}</pre></> : <span>{text || <span className="faint">(empty)</span>}</span>;
  const changed = before !== undefined && before !== after;
  return (
    <Stack gap={1}>
      <span className="muted">{label}{by && <span className="faint"> · proposed by {by}</span>}{before !== undefined && !changed && <span className="faint"> · unchanged</span>}</span>
      {changed && <><span className="hint">Now</span>{value(before!)}<span className="hint">Proposed</span></>}
      {value(after)}
    </Stack>
  );
}

/**
 * The review of a bot's scout draft, in the order a careful owner decides: what it is for, what it runs, where it can
 * go, what it holds, who runs it; then Apply or Decline. Nothing that widens access is preselected, and a refusal from
 * the daemon shows next to the decision it is about.
 */
export function ScoutDraftPage({ house, id, refresh, notify, initial }: { house: WorkspaceView; id: string; refresh: () => Promise<void>; notify: Notify; initial?: ScoutDraftView }) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string>();
  const [decision, setDecision] = useState<DraftDecision>(FIRST_DECISION);
  const [refusal, setRefusal] = useState<{ at: RefusalAt; text: string }>();
  const [busy, setBusy] = useState(false);
  // Pressed once, sent once: a second press before the page re-renders sees this, not the render's state.
  const sending = useRef(false);
  const dialog = useDialog();
  // With scouts off, the owner still reads and declines what waits; applying needs them on.
  const enabled = houseFeatures(house).scouts;
  // The view the owner's choices were made on: a reload reconciles them with what it is now.
  const decidedOn = useRef(initial);
  const load = useCallback(async () => {
    const next = await scoutDraftApi.view(house.name, id), previous = decidedOn.current;
    decidedOn.current = next;
    setView(next); setError(undefined);
    if (previous) setDecision(current => reconcileDecision(previous, next, current));
  }, [house.name, id]);
  useEffect(() => { if (!initial) void load().catch((e: Error) => setError(e.message)); }, [load, initial]);
  const back = { href: workspacePath(house.name, "scouts"), label: "Scouts" };
  if (!view) return <Page title="Draft" back={back}>{error ? <p className="error" role="alert">{error}</p> : <p className="hint">Loading…</p>}</Page>;

  const set = (patch: Partial<DraftDecision>) => { setDecision(current => ({ ...current, ...patch })); setRefusal(undefined); };
  const blockers = draftApplyBlockers(view, decision, enabled);
  const fresh = newHosts(view);
  const scout = view.definition, was = view.current;
  const bots = routineBots(house.pets);
  const pet = view.petTitle;
  const refused = (at: RefusalAt) => refusal?.at === at && <p className="error" role="alert">{refusal.text}</p>;
  const apply = () => {
    if (sending.current || blockers.length) return;
    sending.current = true; setBusy(true); setRefusal(undefined);
    void scoutDraftApi.apply(house.name, view.id, draftApplyBody(view, decision, house.pets)).then(
      async () => { await refresh(); notify(`Scout ${scout.title ?? scout.name} ${view.change ? "changed" : "created"}`); navigate(scoutPath(house.name, scout.name, "access")); },
      async (e: Error) => {
        const where = draftRefusal(e.message);
        // In the config already: its page is where it is now, and the rest of the message says what is not done.
        if (where.applied) { await refresh(); notify(`${scout.title ?? scout.name}: ${e.message}`, true); navigate(scoutPath(house.name, scout.name, "access")); return; }
        setRefusal({ at: where.at, text: e.message });
        // Whatever was refused, decide again on the draft as it is now: choices made on what moved are cleared.
        await load().catch(() => {});
      },
    ).finally(() => { sending.current = false; setBusy(false); });
  };
  const decline = () => dialog.open({
    title: "Decline this draft?",
    body: `${pet} is told it was declined. Nothing changes.`,
    confirmLabel: "Decline",
    onConfirm: async () => {
      if (sending.current) return;
      sending.current = true;
      try { await scoutDraftApi.decline(house.name, view.id); } finally { sending.current = false; }
      await refresh(); notify("Draft declined"); navigate(workspacePath(house.name, "scouts"));
    },
  });

  return (
    <Page title={<><span className="title-emoji" aria-hidden>{scout.emoji ?? "🧭"}</span>{scout.title ?? scout.name}</>} back={back}>
      <p className="hint">{pet} proposes {view.change ? <>a change to scout <Link href={scoutPath(house.name, scout.name)} className="text-link">{was ? shown(was) : scout.name}</Link></> : <>a new scout, <span className="mono">{scout.name}</span></>} · {ago(view.at)}. Nothing changes until you apply it.</p>
      {view.stale && (
        <div className="banner danger" role="alert">
          The scout changed since this was drafted: {view.changedSince.join(", ")}. Applying the draft undoes that.
        </div>
      )}
      {view.problems.length > 0 && <div className="banner danger" role="alert">{view.problems.join("; ")}</div>}
      {!enabled && <div className="banner" role="note">Scouts are off in this workspace. You can read this draft and decline it; applying it needs scouts on (<Link href={workspacePath(house.name, "settings")} className="text-link">settings</Link>).</div>}

      <Section width="narrow" title="What it is for">
        <Stack gap={4}>
          <Stack gap={1}>
            <span className="muted">Why, in {pet}’s words</span>
            <blockquote className="draft-reason">{view.reason}</blockquote>
            <span className="hint">A bot wrote this: read it as its claim, not as Household’s.</span>
          </Stack>
          <BeforeAfter label="Title" before={was ? shown(was) : undefined} after={shown(scout)} by={pet} />
          <BeforeAfter label="Description" before={was?.description} after={scout.description} by={pet} />
          <BeforeAfter label="Shared capabilities" before={was ? was.capabilities.join(", ") || "none" : undefined} after={scout.capabilities.join(", ") || "none"} />
          {view.shared.length > 0 && (
            <List>
              {view.shared.map(capability => (
                <ListRow key={capability.name}>
                  <Cell lines>
                    <span className="mono">{capability.name}</span>
                    <span className="hint">{hostWords(capability.hosts)} · {capability.installs ? "its install script is yours, as it is now" : "nothing to install"}</span>
                  </Cell>
                </ListRow>
              ))}
            </List>
          )}
        </Stack>
      </Section>

      <Section width="narrow" title="What it runs">
        <Stack gap={4}>
          <BeforeAfter label="Instructions" before={was?.instructions} after={scout.instructions} block by={pet} />
          {view.own ? (
            <>
              <BeforeAfter label="Its own setup's description" before={view.currentOwn?.description} after={view.own.description} />
              <BeforeAfter label="Its own install script (runs as root at the start of every run)" before={view.currentOwn?.install} after={view.own.install} block by={pet} />
              <BeforeAfter label="Its own setup's network" before={view.currentOwn ? hostWords(view.currentOwn.network.any ? null : view.currentOwn.network.allow) : undefined} after={hostWords(view.own.network.any ? null : view.own.network.allow)} by={pet} />
            </>
          ) : <span className="hint">{view.currentOwn ? "Its own setup stays as it is." : "No setup of its own."}</span>}
        </Stack>
      </Section>

      <Section width="narrow" title="Where it can go">
        <Stack gap={2}>
          {view.network.open
            ? <span>🌐 Network: open internet{fresh.opens && <> <span className="tag danger">new</span></>}</span>
            : <span>🔒 Network: only {view.network.allow.map((host, index) => <span key={host}>{index ? ", " : ""}<code>{host}</code>{fresh.hosts.includes(host) && <> <span className="tag busy">new</span></>}</span>)}</span>}
          {view.currentNetwork && <span className="hint">Now: {view.currentNetwork.open ? "open internet" : `only ${view.currentNetwork.allow.join(", ")}`}</span>}
        </Stack>
      </Section>

      <Section width="narrow" title="What it holds">
        <Stack gap={3}>
          <List empty="No keys.">
            {view.keys.map(key => (
              <ListRow key={`${key.source}/${key.secret}`}>
                <Cell lines><span className="mono">{key.env ?? key.secret}</span><span className="hint">{keyLine(key)}</span></Cell>
              </ListRow>
            ))}
          </List>
          {view.vmKeyNote && <p className="hint busy">{view.vmKeyNote}</p>}
          {view.needsKeys.length > 0 && (
            <p className="hint">Still to be provided: {view.needsKeys.map(env => <code key={env}>{env} </code>)}. Values never come from a bot: you add them after applying, on the <Link href={scoutPath(house.name, scout.name, "access")} className="text-link">scout’s access page</Link> (its own setup).</p>
          )}
          {view.keyGate && (
            <div className="banner" role="note">
              <Stack gap={2}>
                <span><span className="strong">Keys at stake: {view.keyGate.keys.map(key => key.env ?? key.secret).join(", ")}.</span> {sentence(view.keyGate.reasons.join("; "))}.</span>
                <ChoiceList label="These keys" value={decision.keys ?? ""} onChange={value => set({ keys: value as "keep" | "drop" })} options={[
                  { value: "keep", label: "Keep them", description: "They go along with the change." },
                  ...(view.keyGate.choices.includes("drop")
                    ? [{ value: "drop", label: "Take its own setup’s off", description: "The workspace’s secrets stay; you can add them back on its setup’s page. Keys of shared capabilities stay with them." }]
                    : []),
                ]} />
                {!view.keyGate.choices.includes("drop") && <span className="hint">They come with shared capabilities: to leave them out, decline this draft and ask {pet} for one without those capabilities.</span>}
                {refused("keys")}
              </Stack>
            </div>
          )}
        </Stack>
      </Section>

      <Section width="narrow" title="Who runs it">
        <Stack gap={3}>
          {view.wantsRoutine && <p className="hint busy">{pet} asks to run it without asking. Only you decide that.</p>}
          {was?.routine?.length ? <p className="hint">Now it runs without asking for {was.routine.map(bot => bots.find(each => each.name === bot)?.display ?? bot).join(", ")}. Applying makes it ask every time unless you tick them again.</p> : null}
          {view.routineBlocker && <p className="hint busy">{view.routineBlocker}. Its bots ask you every time.</p>}
          <ChoiceList label="Each run" value={decision.routine} onChange={value => set({ routine: value as DraftDecision["routine"] })} options={[
            { value: "ask", label: "Ask every time", description: "Every run waits for your Run, every message to it for your Pass." },
            { value: "bots", label: "Run without asking for chosen bots", description: view.routineBlocker ? `Not possible: ${view.routineBlocker.toLowerCase()}.` : "No Run card for them; what it sends back still waits for your Pass." },
          ]} />
          {decision.routine === "bots" && !view.routineBlocker && (
            <fieldset className="field">
              <legend className="field-label">Bots</legend>
              {bots.map(bot => (
                <label key={bot.name} className="check">
                  <input type="checkbox" disabled={!routineToggleable(view.routineBlocker, decision.bots, bot.name)} checked={decision.bots.includes(bot.name)}
                    onChange={() => set({ bots: decision.bots.includes(bot.name) ? decision.bots.filter(each => each !== bot.name) : [...decision.bots, bot.name] })} />
                  <span>{bot.display}</span>
                </label>
              ))}
            </fieldset>
          )}
          <p className="hint">{ROUTINE_WARNING}</p>
          {refused("routine")}
        </Stack>
      </Section>

      <Section width="narrow">
        <Stack gap={3}>
          {view.stale && (
            <label className="check">
              <input type="checkbox" checked={decision.force} onChange={() => set({ force: !decision.force })} />
              <span>Apply anyway, over what changed since it was drafted ({view.changedSince.join(", ")})</span>
            </label>
          )}
          {refused("stale")}
          {blockers.length > 0 && <ul className="hint">{blockers.map(text => <li key={text}>{text}</li>)}</ul>}
          {refused("apply")}
          <Cluster justify="between">
            <button type="button" className="btn" disabled={busy} onClick={() => { if (!sending.current) decline(); }}>Decline…</button>
            <button type="button" className="btn primary" disabled={busy || blockers.length > 0} onClick={apply}>{busy ? "Applying…" : view.change ? "Apply change" : "Create scout"}</button>
          </Cluster>
        </Stack>
      </Section>
      {dialog.element}
    </Page>
  );
}

/** A scout's page names the drafts of a change to it, with a way to their review. */
export function ScoutDraftsWaiting({ house, drafts }: { house: string; drafts: ScoutDraftSummary[] }): ReactNode {
  if (!drafts.length) return null;
  return (
    <div className="banner" role="note">
      {drafts.map(draft => <span key={draft.id}>{draft.petTitle} proposes a change to this scout{draft.stale ? " (stale)" : ""}. <Link href={scoutDraftPath(house, draft.id)} className="text-link">Review it</Link></span>)}
    </div>
  );
}
