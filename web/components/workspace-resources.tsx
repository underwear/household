import { useEffect, useState } from "react";
import { gib, workspaceResourcesSchema, type HostCapacity, type PetResources, type ResourceAllocation, type WorkspaceBudget } from "../../src/core/resources";
import { api, type WorkspaceView } from "../api";
import { botPath, workspacePath } from "../router";
import { Dialog } from "./dialog";
import { StepperField } from "./fields";
import { Cell, FormGrid, List, ListRow, Page, Section } from "./layout";
import { Link } from "./link";
import { written } from "./section";

type Notify = (text: string, warning?: boolean) => void;
type Key = keyof PetResources;

/** «2 GiB», «1.5 GiB», «4 vCPU»: one resource's amount in its unit. */
const amount = (key: Key, value: number) => (key === "cpus" ? `${value} vCPU` : gib(value));
/** «4», «1.5»: the same amount without its unit, for «4 / 8 vCPU». */
const bare = (key: Key, value: number) => (key === "cpus" ? String(value) : String(Number((value / 1024).toFixed(3))));
/** «1 vCPU · 2 GiB»: both resources. */
export const resourcesText = ({ cpus, memoryMiB }: PetResources) => `${cpus} vCPU · ${gib(memoryMiB)}`;
/** Whether what is reserved and running already goes beyond the workspace's total (a lowered total, an old config). */
export const overBudget = (budget: WorkspaceBudget) =>
  (["cpus", "memoryMiB"] as const).some((key) => budget.reserved[key] + budget.helpers[key] > budget.total[key]);

/**
 * «… · 1 vCPU · 2 GiB free»: what scouts and sideworkers can still take, linked to the Resources page; for the
 * pages of scouts and sideworkers, which no longer have counts of their own.
 */
export function FreeLink({ house }: { house: WorkspaceView }) {
  if (!house.resources) return null;
  return <Link href={workspacePath(house.name, "resources")} className="text-link">{resourcesText(house.resources.available)} free</Link>;
}

/** One resource's meter: bots' reservations, then scouts' and sideworkers' VMs, then what is free. */
function Meter({ label, budget, field }: { label: string; budget: WorkspaceBudget; field: Key }) {
  const total = budget.total[field];
  const share = (value: number) => `${total > 0 ? Math.min(100, (value / total) * 100) : 0}%`;
  const over = budget.reserved[field] + budget.helpers[field] > total;
  return (
    <div className="resource-meter">
      <span className="strong">{label}</span>
      <div className={over ? "resource-bar over" : "resource-bar"} role="img"
        aria-label={`${label}: ${amount(field, budget.reserved[field])} for bots, ${amount(field, budget.helpers[field])} for scouts and sideworkers, ${amount(field, budget.available[field])} free of ${amount(field, total)}`}>
        <span className="resource-bots" style={{ width: share(budget.reserved[field]) }} />
        <span className="resource-helpers" style={{ width: share(budget.helpers[field]) }} />
      </div>
      <span className={over ? "resource-free danger" : "resource-free"}>
        <span className="strong">{bare(field, budget.available[field])}</span><span className="muted"> / {amount(field, total)} free</span>
      </span>
    </div>
  );
}

/** An allocation's state in words, with its dot (pets: reserved, or a resident VM; helpers: their run or record). */
function stateOf({ kind, state }: ResourceAllocation): { dot: string; text: string } {
  switch (state) {
    case "running": case "allocated": return { dot: "idle", text: "running" };
    case "resident": return { dot: "idle", text: "VM up" };
    case "resize pending": return { dot: "busy", text: "smaller at next start" };
    case "waiting_approval": return { dot: "wait", text: "waiting for your approval" };
    case "waiting_owner": return { dot: "wait", text: "waiting for you" };
    case "closing": case "cleanup": return { dot: "busy", text: "being removed" };
    default: return { dot: "off", text: kind === "pet" ? "reserved" : (state?.replaceAll("_", " ") ?? "reserved") };
  }
}

const KIND: Record<ResourceAllocation["kind"], string> = { pet: "Bot", scout: "Scout", sideworker: "Sideworker" };

/**
 * Workspace · Resources: what its VMs may take of this machine, and who holds what. Bots keep their size reserved
 * (even paused); scouts and sideworkers start from what is left and give it back once their VM is gone.
 */
export function ResourcesPage({ house, host, refresh, notify }: { house: WorkspaceView; host: HostCapacity; refresh: () => Promise<void>; notify: Notify }) {
  const [budget, setBudget] = useState(house.resources);
  const [error, setError] = useState<string>();
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    let active = true;
    const poll = () => void api.resources(house.name).then((value) => { if (active) { setBudget(value); setError(undefined); } }, (e: Error) => { if (active) setError(e.message); });
    poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [house.name]);
  const bots = new Set(house.pets.map((pet) => pet.name));
  return (
    <Page title="Resources" actions={<button type="button" className="btn" disabled={!budget} onClick={() => setChanging(true)}>Change capacity…</button>}>
      <Section>
        {error && <p className="error" role="alert">{error}</p>}
        {budget ? (
          <div className="resource-meters">
            <Meter label="CPU" budget={budget} field="cpus" />
            <Meter label="RAM" budget={budget} field="memoryMiB" />
            <p className="resource-legend hint">
              <span><i className="resource-bots" />Bots {resourcesText(budget.reserved)}</span>
              <span><i className="resource-helpers" />Scouts & sideworkers {resourcesText(budget.helpers)}</span>
            </p>
            {overBudget(budget) && <p className="hint danger" role="alert">Over capacity: new scouts and sideworkers wait until some close.</p>}
          </div>
        ) : !error && <p className="hint">Loading…</p>}
      </Section>
      {budget && (
        <Section title="In use">
          <List columns="minmax(0, 1fr) minmax(0, 1fr) auto" empty="Nothing running.">
            {budget.allocations.map((allocation) => {
              const state = stateOf(allocation);
              return (
                <ListRow key={`${allocation.kind}/${allocation.name}`}>
                  <Cell lines>
                    {allocation.kind !== "scout" && bots.has(allocation.name)
                      ? <Link href={botPath(house.name, allocation.name, allocation.kind === "pet" ? "resources" : "overview")} className="row-link strong ellipsis">{allocation.name}</Link>
                      : <span className="strong ellipsis">{allocation.name}</span>}
                    <span className="muted">{KIND[allocation.kind]}</span>
                  </Cell>
                  <Cell label="State"><span className={`dot ${state.dot}`} /> {state.text}</Cell>
                  <Cell label="Holds"><span className="resource-amount">{resourcesText(allocation)}</span></Cell>
                </ListRow>
              );
            })}
          </List>
        </Section>
      )}
      {changing && budget && (
        <CapacityDialog house={house.name} budget={budget} host={host} onClose={() => setChanging(false)}
          save={async (value) => {
            const warning = await written(api.setWorkspaceResources(house.name, value));
            setBudget(await api.resources(house.name));
            await refresh();
            notify(warning ?? `Capacity set to ${resourcesText(value)}`, warning !== undefined);
          }} />
      )}
    </Page>
  );
}

/** The workspace's total CPU and RAM: up to this machine's, and not below what bots, scouts and sideworkers hold now (the daemon refuses it). */
export function CapacityDialog({ house, budget, host, onClose, save }: { house: string; budget: WorkspaceBudget; host: HostCapacity; onClose: () => void; save: (value: PetResources) => Promise<void> }) {
  const [cpus, setCpus] = useState(String(budget.total.cpus));
  const [ram, setRam] = useState(String(budget.total.memoryMiB / 1024));
  const value = { cpus: Number(cpus), memoryMiB: Number(ram) * 1024 };
  const held = { cpus: budget.reserved.cpus + budget.helpers.cpus, memoryMiB: budget.reserved.memoryMiB + budget.helpers.memoryMiB };
  const below = (key: Key) =>
    value[key] < budget.reserved[key] ? `Bots alone hold ${amount(key, budget.reserved[key])}: make one smaller first.`
      : value[key] < held[key] ? `${amount(key, held[key])} is held now: close a scout or sideworker first, or wait for one to finish.` : undefined;
  return (
    <Dialog onClose={onClose} spec={{
      title: `Capacity of ${house}`,
      confirmLabel: "Save",
      busyLabel: "Saving…",
      onConfirm: async () => {
        if (!workspaceResourcesSchema.safeParse(value).success) throw new Error("Whole CPUs, and RAM from 0.5 GiB in steps of 0.125 GiB.");
        const problem = below("cpus") ?? below("memoryMiB");
        if (problem) throw new Error(problem);
        await save(value);
      },
      children: (
        <>
          <FormGrid>
            <StepperField label="CPU" value={cpus} onChange={setCpus} min={1} max={host.cpus} step={1} unit="vCPU" error={below("cpus")} />
            <StepperField label="RAM" value={ram} onChange={setRam} min={0.5} max={host.memoryMiB / 1024} step={0.125} unit="GiB" error={below("memoryMiB")} />
          </FormGrid>
          <p className="hint">Bots reserve {resourcesText(budget.reserved)}; scouts and sideworkers share the rest.</p>
        </>
      ),
    }} />
  );
}
