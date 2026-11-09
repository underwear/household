import { useState } from "react";
import { DEFAULT_SIDEWORKER_LIMITS, beyondHost, sideworkerLimitsSchema, type HostCapacity } from "../../src/core/resources";
import { api, type WorkspaceView } from "../api";
import { StepperField } from "./fields";
import { Cluster, FormGrid, Section } from "./layout";
import { written } from "./section";

/** Defaults used when a bot omits the VM size at spawn. */
export function SideworkerSettings({ house, host, refresh, notify }: { house: WorkspaceView; host: HostCapacity; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const initial = house.sideworkerLimits ?? DEFAULT_SIDEWORKER_LIMITS;
  const [cpus, setCpus] = useState(String(initial.cpus));
  const [ram, setRam] = useState(String(initial.memoryMiB / 1024));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const limits = { cpus: Number(cpus), memoryMiB: Number(ram) * 1024 };
  const changed = limits.cpus !== initial.cpus || limits.memoryMiB !== initial.memoryMiB;
  const save = async () => {
    if (!cpus.trim() || !ram.trim() || !sideworkerLimitsSchema.safeParse(limits).success) return setError("Use whole CPUs and at least 0.5 GiB RAM in steps of 0.125 GiB.");
    const problems = beyondHost(limits, host);
    if (problems.length) return setError(problems.join("; "));
    setBusy(true); setError(undefined);
    try {
      const warning = await written(api.setSideworkerLimits(house.name, limits));
      await refresh();
      notify(warning ?? "Sideworker limits saved", warning !== undefined);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Section width="narrow" title="Default VM size" hint="Bots can choose a different size for each sideworker within the shared workspace budget.">
      <form className="stack gap-4" onSubmit={(event) => { event.preventDefault(); if (!busy) void save(); }}>
        <FormGrid>
          <StepperField label="CPU each" value={cpus} onChange={setCpus} step={1} min={1} max={host.cpus} unit="vCPU" />
          <StepperField label="RAM each" value={ram} onChange={setRam} step={0.125} min={0.5} max={host.memoryMiB / 1024} unit="GiB" />
        </FormGrid>
        {error && <p className="error" role="alert">{error}</p>}
        <Cluster gap={4} justify="end">
          <span className={changed ? "hint busy grow" : "hint grow"} role="status">
            Applies to new sideworkers.
          </span>
          <button type="submit" className="btn primary" disabled={busy || !changed}>{busy ? "Saving…" : "Save"}</button>
        </Cluster>
      </form>
    </Section>
  );
}
