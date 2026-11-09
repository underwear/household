import { useEffect, useState } from "react";
import { api, type WorkspaceView, type PreviewView } from "../api";
import { botPath } from "../router";
import { Cell, List, ListRow, Section } from "./layout";
import { Link } from "./link";

/** A preview's state in words and a dot: waiting on the owner, opening, or how long its link has left. */
function previewState(item: PreviewView, now: number): { tone: string; label: string } {
  if (item.status === "pending") return { tone: "busy", label: "Waiting for you in chat" };
  if (item.status === "opening") return { tone: "busy", label: "Opening…" };
  const left = Math.max(0, Math.ceil((Date.parse(item.expires_at ?? "") - now) / 60_000));
  return { tone: "idle", label: `Open · ${left} min left` };
}

/**
 * The previews of some bots, polled every 5 s, and Close for each: what a bot's Overview and a workspace's Previews
 * page both show. `load` lists them (one bot's, or every bot's in the workspace).
 */
function usePreviews(load: () => Promise<PreviewView[]>, deps: unknown[], initial: PreviewView[]) {
  const [items, setItems] = useState<PreviewView[]>(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const next = await load(); if (alive) { setItems(next); setError(undefined); setNow(Date.now()); } }
      catch (failure) { if (alive) setError((failure as Error).message); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, deps);
  const close = async (item: PreviewView) => {
    setBusy(item.id);
    try { await api.closePreview(item.house, item.pet, item.id); setItems(await load()); setError(undefined); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(undefined); }
  };
  return { items, error, busy, now, close };
}

/** Previews as rows: title and link, (the bot whose VM it is,) port, state, Close or Cancel. */
function PreviewList({ items, busy, now, close, empty, pets }: {
  items: PreviewView[]; busy?: string; now: number; close: (item: PreviewView) => void; empty: string;
  /** The workspace's bots, to show whose each preview is (a workspace's page); none: one bot's own. */
  pets?: WorkspaceView["pets"];
}) {
  return (
    <List columns={pets ? "minmax(0, 1fr) minmax(0, 0.6fr) auto minmax(0, 12rem) auto" : "minmax(0, 1fr) auto minmax(0, 12rem) auto"} empty={empty}
      head={pets && items.length > 0 ? ["Preview", "Bot", "Port", "State"] : undefined}>
      {items.map(item => {
        const state = previewState(item, now);
        const pet = pets?.find(each => each.name === item.pet);
        return (
          <ListRow key={`${item.pet}/${item.id}`} actions={
            <button type="button" className="btn small" disabled={busy !== undefined} onClick={() => close(item)}>
              {busy === item.id ? "Closing…" : item.status === "pending" ? "Cancel" : "Close"}
            </button>
          }>
            <Cell>
              <span className="cell-lines">
                <span className="strong ellipsis">{item.title}</span>
                {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-link mono ellipsis">{item.url}</a> : <span className="hint">No link yet</span>}
              </span>
            </Cell>
            {pets && <Cell label="Bot"><Link href={botPath(item.house, item.pet)} className="row-link ellipsis">{pet?.title ?? item.pet}</Link></Cell>}
            <Cell mono label="Port">{item.port}</Cell>
            <Cell label="State"><span className="hint"><span className={`dot ${state.tone}`} /> {state.label}</span></Cell>
          </ListRow>
        );
      })}
    </List>
  );
}

/**
 * A bot's HTTP previews (its own VM's, a sideworker's too): each link it asked for, its port and state, Close.
 * With previews off in the workspace and none left open, nothing at all.
 */
export function BotPreviews({ house, pet, enabled, initial = [] }: {
  house: string; pet: string;
  /** Previews are on in the workspace. */
  enabled: boolean;
  /** For a render without the API (tests). */
  initial?: PreviewView[];
}) {
  const { items, error, busy, now, close } = usePreviews(() => api.previews(house, pet), [house, pet], initial);
  if (!enabled && items.length === 0) return null;
  return (
    <Section title="Previews" hint="Links to web apps in its VM, each for 15 minutes once you approve it in chat.">
      {error && <p className="error" role="alert">{error}</p>}
      <PreviewList items={items} busy={busy} now={now} close={close} empty="None open." />
    </Section>
  );
}

/** Every bot's previews in a workspace, in one list, with whose each is. */
export function WorkspacePreviews({ house, initial = [] }: { house: WorkspaceView; /** For a render without the API (tests). */ initial?: PreviewView[] }) {
  const names = house.pets.filter(pet => pet.enabled !== false).map(pet => pet.name);
  const { items, error, busy, now, close } = usePreviews(
    async () => (await Promise.all(names.map(name => api.previews(house.name, name)))).flat(),
    [house.name, names.join(",")],
    initial,
  );
  return (
    <Section title="Open" hint="A bot asks you in chat for each one; its link closes after 15 minutes.">
      {error && <p className="error" role="alert">{error}</p>}
      <PreviewList items={items} busy={busy} now={now} close={close} pets={house.pets} empty="None open." />
    </Section>
  );
}
