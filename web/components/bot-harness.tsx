import { useState } from "react";
import { api, type HarnessView, type KeyView, type BotView } from "../api";
import { Cluster, Section } from "./layout";
import { keysFor, useHarnessForm } from "./bots";
import { written } from "./section";

/**
 * A bot's Harness tab: what runs it (harness, key, model, reasoning effort, permission mode), saved together. A change
 * that needs a new harness session says so before Save; its files and memory stay.
 */
export function BotHarness({ house, pet, agents, keys, refresh, notify }: { house: string; pet: BotView; agents: HarnessView[]; keys: KeyView[]; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const form = useHarnessForm(agents, keysFor(keys, house), pet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (form.error) return setError(form.error);
    setBusy(true);
    setError(undefined);
    try {
      const warning = await written(api.updateBot(house, pet.name, form.value));
      notify(warning ?? (form.restarts ? `${pet.title} saved; restarting` : `${pet.title} saved`), warning !== undefined);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section width="narrow" title="Harness">
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
