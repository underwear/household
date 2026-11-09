import { useEffect, useState } from "react";
import { gib, workspaceResourcesSchema, type HostCapacity, type WorkspaceBudget } from "../../src/core/resources";
import { api, type WorkspaceView } from "../api";
import { StepperField } from "./fields";
import { Cluster, FormGrid, Section } from "./layout";
import { written } from "./section";

/** Allocations, deliberately separate from measured CPU and memory utilization. */
export function ResourceBudgetSummary({ budget }: { budget: WorkspaceBudget }) {
  return <Section title="Resource budget" hint="Reserved VM maxima, not live utilization. Pets keep their reservations while paused; scouts and sideworkers share everything left.">
    <div className="resource-budget-grid">
      {([['CPU', 'cpus', 'vCPU'], ['RAM', 'memoryMiB', 'GiB']] as const).map(([label, key, unit]) => {
        const format = (n: number) => key === 'cpus' ? String(n) : String(Number((n / 1024).toFixed(3)));
        const over = budget.reserved[key] + budget.helpers[key] > budget.total[key];
        return <div key={key} className="stack gap-4">
          <strong>{label} · {format(budget.total[key])} {unit} total</strong>
          <div className="resource-budget-bar" role="img" aria-label={`${label}: ${format(budget.reserved[key])} reserved for pets, ${format(budget.helpers[key])} allocated to helpers, ${format(budget.available[key])} free ${unit}`}>
            <span className="resource-pets" style={{ width: `${Math.min(100, budget.reserved[key] / budget.total[key] * 100)}%` }} />
            <span className="resource-helpers" style={{ width: `${Math.min(100, budget.helpers[key] / budget.total[key] * 100)}%` }} />
          </div>
          <span className="hint">Pets {format(budget.reserved[key])} · Helpers {format(budget.helpers[key])} · <strong>{format(budget.available[key])} {unit} free</strong></span>
          {over && <p className="error" role="alert">Existing allocations exceed the budget. Close helpers or raise the budget before starting more.</p>}
        </div>;
      })}
    </div>
  </Section>;
}

export function WorkspaceResources({ house, host, refresh, notify }: { house: WorkspaceView; host: HostCapacity; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const [budget, setBudget] = useState(house.resources);
  const [cpus, setCpus] = useState(String(house.resources?.total.cpus ?? 8));
  const [ram, setRam] = useState(String((house.resources?.total.memoryMiB ?? 8192) / 1024));
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const poll = () => void api.resources(house.name).then(value => { if (active) setBudget(value); }).catch(e => { if (active) setError(e.message); });
    poll(); const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [house.name]);
  const value = { cpus: Number(cpus), memoryMiB: Number(ram) * 1024 };
  const changed = budget && (value.cpus !== budget.total.cpus || value.memoryMiB !== budget.total.memoryMiB);
  const save = async () => {
    if (!workspaceResourcesSchema.safeParse(value).success) return setError("Use whole CPUs and RAM of at least 0.5 GiB in steps of 0.125 GiB.");
    setBusy(true); setError(undefined);
    try {
      const warning = await written(api.setWorkspaceResources(house.name, value));
      setBudget(await api.resources(house.name)); await refresh();
      notify(warning ?? "Workspace resource budget saved", !!warning);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    {budget && <ResourceBudgetSummary budget={budget} />}
    <Section title="Workspace capacity" width="narrow" hint={`Set this workspace's CPU/RAM ceiling. Host: ${host.cpus} vCPU · ${gib(host.memoryMiB)}. Other workspaces have separate budgets.`}>
      <form className="stack gap-4" onSubmit={e => { e.preventDefault(); if (!busy) void save(); }}>
        <FormGrid>
          <StepperField label="Total CPU" value={cpus} onChange={setCpus} min={1} max={host.cpus} step={1} unit="vCPU" />
          <StepperField label="Total RAM" value={ram} onChange={setRam} min={0.5} max={host.memoryMiB / 1024} step={0.125} unit="GiB" />
        </FormGrid>
        <p className="hint">Set each pet’s reservation on its Resources tab. Helpers choose their VM size from the remaining pool; there is no limit on their number.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <Cluster justify="end"><button className="btn primary" disabled={busy || !changed}>{busy ? "Saving…" : "Save budget"}</button></Cluster>
      </form>
    </Section>
    {budget && <Section title="Allocations" hint="Includes pending scouts and helpers still being removed. Resources are released after cleanup completes.">
      <div className="stack gap-4">{budget.allocations.length ? budget.allocations.map(a => <Cluster key={`${a.kind}/${a.name}`} justify="between"><span><strong>{a.name}</strong> <span className="hint">{a.kind} · {a.state?.replaceAll("_", " ") ?? "reserved"}</span></span><span>{a.cpus} vCPU · {gib(a.memoryMiB)}</span></Cluster>) : <p className="hint">No allocations yet. All capacity is available.</p>}</div>
    </Section>}
  </>;
}
