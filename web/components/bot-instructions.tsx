import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, type InstructionFile, type BotView } from "../api";
import { useDialog } from "./dialog";
import { Section } from "./layout";
import { MarkdownEditor } from "./markdown-editor";
import { RestartDialog } from "./bots";

/**
 * A bot's own instructions: the file its harness reads at the start of each session (CLAUDE.md or AGENTS.md, in its
 * home), in the editor Skills and Memory use. A change applies from the next session; after a save, a restart that
 * starts one is a click away.
 */
export function BotInstructions({ house, pet }: { house: string; pet: BotView }) {
  const [view, setView] = useState<InstructionFile>();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const saving = useRef(false);
  const dialog = useDialog();
  useEffect(() => {
    let cancelled = false;
    void api.instructions(house, pet.name).then(
      (value) => {
        if (!cancelled) {
          setView(value);
          setContent(value.content);
        }
      },
      (error) => {
        if (!cancelled) setError(error.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [house, pet.name]);
  const dirty = !!view && content !== view.content;
  const save = async () => {
    if (!view || !dirty || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    const submitted = content;
    try {
      const next = await api.saveInstructions(house, pet.name, submitted, view.revision);
      setView(next);
      setContent((current) => (current === submitted ? next.content : current));
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const file = view?.path.split("/").at(-1) ?? "Instructions";
  return (
    <Section
      title="Instructions"
      hint={`Read by ${pet.title} at the start of every session. Rules for all bots go in Skills.`}
    >
      <div className="script tall">
        <header className="skills-doc-head">
          <div className="skills-doc-title">
            <span className="ellipsis">
              {view && <span className="faint">~/{view.path.split("/").slice(0, -1).join("/")}/</span>}
              {file}
            </span>
            <span className={`skills-doc-state${dirty ? " unsaved" : ""}`}>{!view ? (error ? "Not loaded" : "Loading…") : busy ? "Saving…" : dirty ? "Unsaved" : "Saved"}</span>
          </div>
          <button
            type="button"
            className="icon-btn small"
            title="Discard changes"
            aria-label="Discard changes"
            disabled={busy || !dirty}
            onClick={() =>
              dialog.open({
                title: "Discard your changes?",
                body: `${file} goes back to what is saved.`,
                confirmLabel: "Discard",
                danger: true,
                onConfirm: async () => setContent(view?.content ?? ""),
              })
            }
          >
            <RotateCcw size={15} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="btn primary small" disabled={!dirty || busy} onClick={() => void save()}>
            Save
          </button>
        </header>
        {error && (
          <p className="skills-doc-error error" role="alert">
            {error}
          </p>
        )}
        <div className="skills-doc-body">
          {view ? (
            <MarkdownEditor
              value={content}
              onChange={(value) => {
                setContent(value);
                setSaved(false);
              }}
              onSave={() => void save()}
            />
          ) : (
            <div className="skills-doc-empty">
              <p className="hint">{error ? "The instructions could not be loaded." : "Loading…"}</p>
            </div>
          )}
        </div>
        <footer className="skills-doc-foot">
          <span>
            <kbd>⌘</kbd>
            <kbd>S</kbd> saves
          </span>
          <span>Markdown · up to 32 KiB</span>
        </footer>
      </div>
      {saved && !dirty && (
        <div className="script-saved" role="status">
          <span>Saved. {pet.title} reads it from its next session.</span>
          {pet.enabled !== false && (
            <button type="button" className="btn small" onClick={() => setRestarting(true)}>
              Restart now…
            </button>
          )}
        </div>
      )}
      {restarting && <RestartDialog house={house} pet={pet} onClose={() => setRestarting(false)} onRestarted={() => setSaved(false)} />}
      {dialog.element}
    </Section>
  );
}
