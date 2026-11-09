import { useEffect, useRef, useState } from "react";
import { ChevronRight, Pin, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { api, type MemoryEntry, type MemorySummary } from "../api";
import { Dialog, useDialog } from "./dialog";
import { TextField } from "./fields";
import { Section } from "./layout";
import { MarkdownEditor } from "./markdown-editor";
import { relative } from "./bot-crons";
import { SkillPreview } from "./skills";

const KEY = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const CORE_LIMIT = 8000;
const NOTE_LIMIT = 32000;

/** A key's segment in the tree: the note by that key (if there is one) and the keys under it. */
interface MemoryNode {
  segment: string;
  key: string;
  entry?: MemorySummary;
  children: MemoryNode[];
}

/** The keys as a tree by their dot segments: a parent may itself be a note. `core` is left out (it is pinned). */
export function memoryTree(entries: MemorySummary[]): MemoryNode[] {
  const root: MemoryNode = { segment: "", key: "", children: [] };
  for (const entry of entries) {
    if (entry.key === "core") continue;
    let node = root;
    for (const segment of entry.key.split(".")) {
      const key = node.key ? `${node.key}.${segment}` : segment;
      let child = node.children.find((each) => each.segment === segment);
      if (!child) node.children.push((child = { segment, key, children: [] }));
      node = child;
    }
    node.entry = entry;
  }
  return root.children;
}

/** The tree's rows: a chevron where there are keys under it, the key's last segment, a click opening its note. */
export function MemoryTree({ nodes, selected, collapsed, toggle, select, depth = 0 }: { nodes: MemoryNode[]; selected?: string; collapsed: Set<string>; toggle: (key: string) => void; select: (key: string) => void; depth?: number }) {
  return (
    <ul className="memory-tree" role={depth === 0 ? "tree" : "group"}>
      {nodes.map((node) => {
        const open = !collapsed.has(node.key);
        const parent = node.children.length > 0;
        return (
          <li key={node.key} role="treeitem" aria-expanded={parent ? open : undefined} aria-selected={selected === node.key}>
            <div className={`memory-row${selected === node.key ? " selected" : ""}${node.entry?.deleted ? " deleted" : ""}${node.entry ? "" : " group"}`} style={{ paddingLeft: 6 + depth * 14 }}>
              {parent ? (
                <button type="button" className="memory-chevron" aria-label={open ? `Collapse ${node.key}` : `Expand ${node.key}`} onClick={() => toggle(node.key)}>
                  <ChevronRight size={13} strokeWidth={2} className={open ? "open" : undefined} aria-hidden />
                </button>
              ) : (
                <span className="memory-chevron" aria-hidden />
              )}
              <button type="button" className="memory-key" title={node.entry ? node.entry.excerpt || node.key : node.key} onClick={() => (node.entry ? select(node.key) : toggle(node.key))}>
                {node.segment}
              </button>
            </div>
            {parent && open && <MemoryTree nodes={node.children} selected={selected} collapsed={collapsed} toggle={toggle} select={select} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A bot's memory: its notes by key (dot segments make the tree; `core`, pinned, is what the bot loads at the start
 * of each session), searched as you type; the open note on the right, to edit, read, or go back through its versions.
 */
export function BotMemory({ house, pet }: { house: string; pet: string }) {
  const [entries, setEntries] = useState<MemorySummary[]>([]);
  const [next, setNext] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [locked, setLocked] = useState(false);
  const [entry, setEntry] = useState<MemoryEntry>();
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const listSeq = useRef(0);
  const readSeq = useRef(0);

  const load = async (after?: string) => {
    const seq = ++listSeq.current;
    try {
      const page = await api.memories(house, pet, { query, deleted, after });
      if (seq !== listSeq.current) return;
      setSearched(query);
      setEntries((old) => (after ? [...old, ...page.entries] : page.entries));
      setNext(page.next);
      setError("");
    } catch (e) {
      if (seq === listSeq.current) setError((e as Error).message);
    } finally {
      if (seq === listSeq.current) setLoaded(true);
    }
  };
  const select = async (key: string) => {
    const seq = ++readSeq.current;
    try {
      const value = await api.memory(house, pet, key);
      if (seq === readSeq.current) {
        setEntry(value);
        setError("");
      }
    } catch (e) {
      if (seq === readSeq.current) setError((e as Error).message);
    }
  };
  // The list again as the search changes (a beat after the last key), and when deleted notes are asked for.
  useEffect(() => {
    const timer = setTimeout(() => void load(), query === searched ? 0 : 250);
    return () => clearTimeout(timer);
  }, [house, pet, deleted, query]);
  useEffect(() => {
    void select("core");
    return () => {
      listSeq.current++;
      readSeq.current++;
    };
  }, [house, pet]);

  const core = entries.find((each) => each.key === "core");
  const tree = memoryTree(entries);
  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const group = entry && entry.key !== "core" ? entry.key.split(".").slice(0, -1).join(".") : "";
  return (
    <Section width="wide" hint="Private to this bot. core loads every session; other notes on demand.">
      <div className="memory">
        <nav className="memory-side" aria-label="Memory notes" inert={locked}>
          <label className="memory-search">
            <Search size={14} strokeWidth={1.75} aria-hidden />
            <input type="search" aria-label="Search memory" placeholder="Search keys and text" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="memory-list">
            {(!query || core) && (
              <button type="button" className={`memory-core${entry?.key === "core" ? " selected" : ""}${core ? "" : " empty"}`} onClick={() => void select("core")}>
                <Pin size={13} strokeWidth={1.75} aria-hidden />
                <span className="memory-core-text">
                  <span className="memory-core-name">core</span>
                  <span className="memory-core-hint">{core ? "Loaded every session" : "Not written yet"}</span>
                </span>
              </button>
            )}
            {tree.length > 0 && <MemoryTree nodes={tree} selected={entry?.key} collapsed={query ? new Set() : collapsed} toggle={toggle} select={(key) => void select(key)} />}
            {loaded && entries.length === 0 && query && <p className="memory-none">Nothing matches “{query}”.</p>}
            {loaded && tree.length === 0 && !query && <p className="memory-none">No other notes yet.</p>}
            {next && (
              <button type="button" className="text-btn plain memory-more" disabled={query !== searched} onClick={() => void load(next)}>
                Load more
              </button>
            )}
          </div>
          <div className="memory-side-foot">
            <button type="button" className="text-btn plain" onClick={() => setCreating(true)}>
              <Plus size={13} strokeWidth={2} aria-hidden /> New note
            </button>
            <label className="memory-deleted">
              <input type="checkbox" checked={deleted} onChange={(event) => setDeleted(event.target.checked)} /> Show deleted
            </label>
          </div>
        </nav>
        <section className="memory-doc" aria-label="Memory note">
          {error && !entry && <p className="memory-doc-error error">{error}</p>}
          {entry ? (
            <MemoryNote
              key={`${house}/${pet}/${entry.key}`}
              house={house}
              pet={pet}
              initial={entry}
              lock={(value) => {
                if (value) readSeq.current++;
                setLocked(value);
              }}
              changed={() => void load()}
            />
          ) : (
            !error && <div className="skills-doc-empty"><p className="hint">Loading…</p></div>
          )}
        </section>
      </div>
      {creating && (
        <NewNoteDialog
          prefix={group ? `${group}.` : ""}
          onClose={() => setCreating(false)}
          open={async (key) => {
            await select(key);
          }}
        />
      )}
    </Section>
  );
}

/** A note by its key: an existing one opens; a new one opens empty, saved on Save. */
function NewNoteDialog({ prefix, onClose, open }: { prefix: string; onClose: () => void; open: (key: string) => Promise<void> }) {
  const [key, setKey] = useState(prefix);
  const trimmed = key.trim().replace(/\.+$/, "");
  const problem = trimmed && !KEY.test(trimmed) ? "Lowercase letters, digits, _ and -, in segments joined by dots." : undefined;
  return (
    <Dialog
      onClose={onClose}
      spec={{
        title: "New note",
        confirmLabel: "Open",
        onConfirm: async () => {
          if (!trimmed) throw new Error("Give the note a key.");
          if (problem) return "stay";
          await open(trimmed);
        },
        children: (
          <TextField
            label="Key"
            mono
            value={key}
            onChange={(value) => setKey(value.toLowerCase().replace(/\s+/g, "-"))}
            maxLength={200}
            placeholder="projects.household.deploy"
            error={problem}
            hint="Dots nest: people.anya goes under people."
          />
        ),
      }}
    />
  );
}

/** The open note: one header (its key, version, who changed it and when, Edit / Preview / History, Save) over its text. */
function MemoryNote({ house, pet, initial, changed, lock }: { house: string; pet: string; initial: MemoryEntry; changed: () => void; lock: (locked: boolean) => void }) {
  const draftKey = `household:memory:${house}:${pet}:${initial.key}`;
  const stored = (): { value?: string; revision?: number } | null => {
    try {
      return JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
    } catch {
      return null;
    }
  };
  const [entry, setEntry] = useState(initial);
  const [value, setValue] = useState(() => stored()?.value ?? initial.value ?? "");
  const [revision, setRevision] = useState(() => stored()?.revision ?? initial.revision);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"edit" | "preview" | "history">("edit");
  const [history, setHistory] = useState<MemoryEntry[]>();
  const dialog = useDialog();
  const dirty = value !== (entry.value ?? "") || revision !== entry.revision;
  const limit = entry.key === "core" ? CORE_LIMIT : NOTE_LIMIT;
  const isNew = entry.revision === 0;
  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ value, revision }));
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, value, revision, dirty]);
  const saved = (note: MemoryEntry) => {
    setEntry(note);
    setRevision(note.revision);
    setValue(note.value ?? "");
    setError("");
    setHistory(undefined);
    setView("edit");
    changed();
  };
  const saving = useRef(false);
  const save = async () => {
    if (saving.current || (!dirty && entry.value !== null)) return;
    saving.current = true;
    setBusy(true);
    lock(true);
    try {
      const result = await api.saveMemory(house, pet, entry.key, value, revision);
      // Clear the submitted draft even if navigation unmounted this editor. Never erase a newer draft.
      const draft = stored();
      if (draft?.revision === revision && draft?.value === value) sessionStorage.removeItem(draftKey);
      saved(result);
    } catch (e) {
      setError(`${(e as Error).message} Your draft is kept.`);
    } finally {
      saving.current = false;
      setBusy(false);
      lock(false);
    }
  };
  const versions = async (before?: number) => {
    try {
      const rows = await api.memoryHistory(house, pet, entry.key, before);
      setHistory((old) => (before && old ? [...old, ...rows] : rows));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const segments = entry.key.split(".");
  return (
    <div className="memory-note" inert={busy} aria-busy={busy}>
      <header className="skills-doc-head">
        <div className="skills-doc-title">
          <span className="ellipsis">
            {segments.slice(0, -1).map((segment, index) => (
              <span key={index} className="faint">
                {segment} /{" "}
              </span>
            ))}
            {segments.at(-1)}
          </span>
          <span className={dirty ? "skills-doc-state unsaved" : "skills-doc-state"}>
            {busy ? "Saving…" : dirty ? "Unsaved" : isNew ? "New" : entry.value === null ? "Deleted" : `v${entry.revision} · ${entry.actor === "owner" ? "you" : entry.actor} · ${relative(entry.updated)}`}
          </span>
        </div>
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "edit"} onClick={() => setView("edit")}>
            Edit
          </button>
          <button type="button" aria-pressed={view === "preview"} onClick={() => setView("preview")}>
            Preview
          </button>
          <button
            type="button"
            aria-pressed={view === "history"}
            disabled={isNew}
            onClick={() => {
              setView("history");
              if (!history) void versions();
            }}
          >
            History
          </button>
        </div>
        <button
          type="button"
          className="icon-btn small"
          title="Discard changes and reload"
          aria-label="Discard changes and reload"
          disabled={busy || !dirty}
          onClick={() =>
            dialog.open({
              title: "Discard your changes?",
              body: `Your unsaved edits to ${entry.key} are lost.`,
              confirmLabel: "Discard and reload",
              danger: true,
              onConfirm: async () => saved(await api.memory(house, pet, entry.key)),
            })
          }
        >
          <RotateCcw size={15} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-btn small danger"
          title="Delete note"
          aria-label="Delete note"
          disabled={busy || entry.value === null}
          onClick={() =>
            dialog.open({
              title: `Delete ${entry.key}?`,
              body: "It leaves the bot's memory; History keeps its versions.",
              confirmLabel: "Delete note",
              danger: true,
              onConfirm: async () => saved(await api.deleteMemory(house, pet, entry.key, revision)),
            })
          }
        >
          <Trash2 size={15} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" className="btn primary small" disabled={busy || (!dirty && entry.value !== null)} onClick={() => void save()}>
          Save
        </button>
      </header>
      {error && (
        <p className="skills-doc-error error" role="alert">
          {error}
        </p>
      )}
      <div className="skills-doc-body">
        {view === "edit" && <MarkdownEditor value={value} onChange={setValue} onSave={() => void save()} />}
        {view === "preview" && (value.trim() ? <SkillPreview content={value} parseFrontmatter={false} /> : <div className="skills-doc-empty"><p className="hint">Nothing written yet.</p></div>)}
        {view === "history" && (
          <div className="memory-history">
            {history === undefined ? (
              <p className="hint">Loading versions…</p>
            ) : history.length === 0 ? (
              <p className="hint">No saved versions yet.</p>
            ) : (
              history.map((version) => (
                <details key={version.revision} className="run">
                  <summary>
                    <span className="memory-version">v{version.revision}</span>
                    <span className="ellipsis">{version.value === null ? <span className="faint">Deleted</span> : (version.value.split("\n").find((line) => line.trim()) ?? "")}</span>
                    <span className="run-state">{version.actor === "owner" ? "you" : version.actor}</span>
                    <span className="run-time">{new Date(version.updated).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </summary>
                  {version.value !== null && (
                    <div className="run-detail">
                      <pre className="run-text">{version.value}</pre>
                      <button
                        type="button"
                        className="btn small memory-use"
                        onClick={() => {
                          setValue(version.value!);
                          setView("edit");
                        }}
                      >
                        Use as draft
                      </button>
                    </div>
                  )}
                </details>
              ))
            )}
            {history && history.length > 0 && history.length % 20 === 0 && (
              <button type="button" className="text-btn plain memory-more" onClick={() => void versions(history.at(-1)!.revision)}>
                Older versions
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="skills-doc-foot">
        <span>
          <kbd>⌘</kbd>
          <kbd>S</kbd> saves · drafts stay in this tab
        </span>
        <span className={value.length > limit ? "error" : value.length > limit * 0.9 ? "memory-near" : undefined}>
          {value.length.toLocaleString("en")} / {limit.toLocaleString("en")}
          {entry.key === "core" && " · keep core short"}
        </span>
      </footer>
      {dialog.element}
    </div>
  );
}
