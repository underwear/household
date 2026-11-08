import { useState } from "react";
import { api, type AgentView, type KeyView, type PetView } from "../api";
import { Cluster, Section } from "./layout";
import { keysFor, useAgentForm } from "./pets";
import { written } from "./section";

/**
 * A pet's Agent tab: what runs it (agent, key, model, reasoning effort, permission mode), saved together. A change
 * that needs a new agent session says so before Save; its files and memory stay.
 */
export function PetAgent({ house, pet, agents, keys, refresh, notify }: { house: string; pet: PetView; agents: AgentView[]; keys: KeyView[]; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const form = useAgentForm(agents, keysFor(keys, house), pet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (form.error) return setError(form.error);
    setBusy(true);
    setError(undefined);
    try {
      const warning = await written(api.updatePet(house, pet.name, form.value));
      notify(warning ?? (form.restarts ? `${pet.title} saved; restarting` : `${pet.title} saved`), warning !== undefined);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section width="narrow" title="Agent">
      <form
        className="stack gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void save();
        }}
      >
        {form.fields}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Cluster gap={4} justify="end">
          {form.restarts && (
            <span className="hint busy grow" role="status">
              Saving restarts {pet.title}. Files and memory stay.
            </span>
          )}
          <button type="submit" className="btn primary" disabled={busy || !form.changed}>
            {busy ? "Saving…" : form.restarts ? "Save and restart" : "Save"}
          </button>
        </Cluster>
      </form>
    </Section>
  );
}
