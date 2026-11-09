import { useState } from "react";
import { api, type BotView } from "../api";
import { Cluster, Section } from "./layout";
import { BotUsage } from "./bot-monitoring";
import { useResourceForm, type Capacity } from "./bots";
import { written } from "./section";

/**
 * A bot's Resources tab: what its VM uses (Usage) over what it is given (Allocation, up to what the host has). A new
 * allocation is saved without stopping the bot and applies on its next Restart or Enable.
 */
export function BotResources({ house, pet, capacity, refresh, notify }: { house: string; pet: BotView; capacity: Capacity; refresh: () => Promise<void>; notify: (text: string, warning?: boolean) => void }) {
  const form = useResourceForm(capacity, house, pet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (form.error) return setError(form.error);
    setBusy(true);
    setError(undefined);
    try {
      const warning = await written(api.updateBot(house, pet.name, form.value));
      notify(warning ?? `Allocation saved; applies on the next restart`, warning !== undefined);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <BotUsage house={house} pet={pet.name} />
      <Section width="narrow" title="Allocation" hint="Reserved on the host for this bot's VM.">
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
            <span className={form.changed ? "hint busy grow" : "hint grow"} role="status">
              Applies on the next restart. Saving doesn't interrupt {pet.title}.
            </span>
            <button type="submit" className="btn primary" disabled={busy || !form.changed}>
              {busy ? "Saving…" : "Save"}
            </button>
          </Cluster>
        </form>
      </Section>
    </>
  );
}
