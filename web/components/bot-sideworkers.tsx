import type { SideworkerRecord } from "../../src/app/sideworkers";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { WorkspaceView, BotView } from "../api";
import { api } from "../api";
import { botPath } from "../router";
import { useDialog, type DialogSpec } from "./dialog";
import { Link } from "./link";
import { Cell, List, ListRow, Section } from "./layout";
import { ownBots, petState } from "./bot-state";
import { DEFAULT_SIDEWORKER_LIMITS, gib, petResources } from "../../src/core/resources";

/** Closing a sideworker: its work stops now and its VM goes; what it wrote in the shared files stays. */
export const closeWorkerDialog = (house: string, worker: Pick<BotView, "name" | "title">, closed: () => Promise<void>): DialogSpec => ({
  title: `Close ${worker.title}?`,
  body: "Its VM is removed. The shared files stay.",
  confirmLabel: "Close sideworker",
  danger: true,
  onConfirm: async () => { await api.closeSideworker(house, worker.name); await closed(); },
});

/**
 * A workspace's sideworkers as they run, in one list: each links to its page with its state, the bot that started it,
 * where it works and what it is given; how many more the workspace allows is above. A worker whose removal has not gone
 * through yet stays, to retry.
 */
export function WorkspaceSideworkers({ house, refresh }: { house: WorkspaceView; refresh: () => Promise<void> }) {
  const dialog = useDialog();
  const [records, setRecords] = useState<SideworkerRecord[]>([]);
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    const [, records] = await Promise.all([refresh(), api.sideworkers(house.name)]);
    setRecords(records); setError(undefined);
  }, [house.name, refresh]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await reload(); } catch (e) { if (active) setError((e as Error).message); }
      if (active) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [reload]);
  const closing = records.filter((record) => record.closing);
  const limits = house.sideworkerLimits ?? DEFAULT_SIDEWORKER_LIMITS;
  const active = house.pets.filter((pet) => pet.sideworker).length + closing.filter((record) => !house.pets.some((pet) => pet.name === record.name)).length;
  // Grouped by the bot that started them, in the workspace's order of bots.
  const order = ownBots(house.pets).map((pet) => pet.name);
  const rank = (parent: string) => (order.includes(parent) ? order.indexOf(parent) : order.length);
  const workers = house.pets
    .filter((pet) => pet.sideworker && !closing.some((record) => record.name === pet.name))
    .sort((a, b) => rank(a.sideworker!.parent) - rank(b.sideworker!.parent));
  const parentCell = (name: string) => {
    const pet = house.pets.find((each) => each.name === name);
    return (
      <Cell label="Started by">
        {pet ? <Link href={botPath(house.name, name)} className="row-link ellipsis">{pet.title}</Link> : <span className="muted ellipsis">{name}</span>}
      </Cell>
    );
  };
  const retry = (worker: SideworkerRecord) => dialog.open({ ...closeWorkerDialog(house.name, { name: worker.name, title: worker.name }, reload), title: `Retry closing ${worker.name}?`, confirmLabel: "Retry close" });
  return (
    <Section title="Running" hint={limits.maxWorkers === 0 ? "Off in this workspace: raise the limit below to turn them on." : `${active} of ${limits.maxWorkers} at most.`}>
      {error && <p className="error" role="alert">{error}</p>}
      <List
        columns="minmax(0, 1fr) minmax(0, 0.7fr) minmax(0, 1.4fr) auto auto"
        head={workers.length + closing.length > 0 ? ["Sideworker", "Started by", "Working directory", "Resources"] : undefined}
        empty="None running. A bot starts one when it wants a hand with a task."
      >
        {workers.map((worker) => {
          const state = petState(worker.state);
          const resources = petResources(worker);
          return (
            <ListRow key={worker.name} actions={<button type="button" className="btn small" onClick={() => dialog.open(closeWorkerDialog(house.name, worker, reload))}>Close…</button>}>
              <Cell>
                <span className="avatar" aria-hidden>{worker.emoji}</span>
                <span className="cell-lines">
                  <Link href={botPath(house.name, worker.name)} className="strong ellipsis row-link">{worker.title}</Link>
                  <span className="hint"><span className={`dot ${state.tone}`} /> {state.label}</span>
                </span>
              </Cell>
              {parentCell(worker.sideworker!.parent)}
              <Cell mono label="Working directory">
                <span className="cell-lines">
                  <span className="ellipsis" title={worker.sideworker!.cwd}>{worker.sideworker!.cwd}</span>
                  {worker.sideworker!.branch && <span className="hint ellipsis">{worker.sideworker!.branch}</span>}
                </span>
              </Cell>
              <Cell label="Resources"><span className="muted">{resources.cpus} vCPU · {gib(resources.memoryMiB)}</span></Cell>
            </ListRow>
          );
        })}
        {closing.map((worker) => <PendingSideworkerRow key={worker.name} worker={worker} parent={parentCell(worker.parent)} onRetry={() => retry(worker)} />)}
      </List>
      {dialog.element}
    </Section>
  );
}

/** A worker being closed whose VM has not gone yet: no page to open, but it holds its share of the limit until it goes. */
export function PendingSideworkerRow({ worker, parent, onRetry }: { worker: SideworkerRecord; /** The cell of the bot that started it. */ parent: ReactNode; onRetry: () => void }) {
  return (
    <ListRow actions={<button type="button" className="btn small" onClick={onRetry}>Retry close</button>}>
      <Cell>
        <span className="avatar" aria-hidden>⛏️</span>
        <span className="cell-lines">
          <span className="strong ellipsis">{worker.name}</span>
          <span className="hint" title="Its VM is not gone yet: it still counts toward the limit."><span className="dot danger" /> Cleanup pending</span>
        </span>
      </Cell>
      {parent}
      <Cell mono label="Working directory"><span className="ellipsis" title={worker.cwd}>{worker.cwd}</span></Cell>
      <Cell label="Resources"><span className="muted">{worker.cpus} vCPU · {gib(worker.memoryMiB)}</span></Cell>
    </ListRow>
  );
}
