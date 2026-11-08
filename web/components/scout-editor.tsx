import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { scoutApi, type ScoutDocument } from "../scout-api";
import { useDialog } from "./dialog";
import { Section } from "./layout";
import { MarkdownEditor } from "./markdown-editor";

/** Revision checked, with drafts kept independently for each scout and document. */
export function ScoutDocumentEditor({
  house,
  scout,
  kind,
}: {
  house: string;
  scout: string;
  kind: "instructions";
}) {
  const [document, setDocument] = useState<ScoutDocument>();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const dialog = useDialog();
  const key = `household:scout-draft:${house}:${scout}:${kind}`;
  const load = async (discard = false) => {
    const next = await scoutApi.document(house, scout);
    let draft: ScoutDocument | undefined;
    if (!discard) {
      try {
        draft = JSON.parse(sessionStorage.getItem(key) ?? "null") ?? undefined;
      } catch {}
    }
    setDocument(
      draft && draft.content !== next.content
        ? { ...next, revision: draft.revision }
        : next,
    );
    setContent(draft?.content ?? next.content);
    setError(
      draft &&
        draft.revision !== next.revision &&
        draft.content !== next.content
        ? "The saved file changed. Copy your draft, then Reload to edit the latest version."
        : undefined,
    );
  };
  useEffect(() => {
    let active = true;
    void scoutApi.document(house, scout).then(
      (next) => {
        if (!active) return;
        let draft: ScoutDocument | undefined;
        try {
          draft =
            JSON.parse(sessionStorage.getItem(key) ?? "null") ?? undefined;
        } catch {}
        setDocument(
          draft && draft.content !== next.content
            ? { ...next, revision: draft.revision }
            : next,
        );
        setContent(draft?.content ?? next.content);
        if (
          draft &&
          draft.revision !== next.revision &&
          draft.content !== next.content
        )
          setError(
            "The saved file changed. Copy your draft, then Reload to edit the latest version.",
          );
      },
      (e) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [house, scout, kind, key]);
  const dirty = !!document && content !== document.content;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const edit = (value: string) => {
    setContent(value);
    if (document) {
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({ content: value, revision: document.revision }),
        );
      } catch {}
    }
  };
  const save = async () => {
    if (!document || !dirty || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    const submitted = content;
    try {
      const next = await scoutApi.saveDocument(house, scout, {
        content: submitted,
        revision: document.revision,
      });
      setDocument(next);
      setContent((current) => {
        const latest = current === submitted ? next.content : current;
        try {
          if (latest === next.content) sessionStorage.removeItem(key);
          else
            sessionStorage.setItem(
              key,
              JSON.stringify({ content: latest, revision: next.revision }),
            );
        } catch {}
        return latest;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const reload = () =>
    dialog.open({
      title: "Reload saved file?",
      body: "Your draft will be discarded.",
      confirmLabel: "Reload",
      danger: true,
      onConfirm: async () => {
        await load(true);
        try {
          sessionStorage.removeItem(key);
        } catch {}
      },
    });
  return (
    <Section
      title="Instructions"
      hint="Household adds who called it, the task, how to report, and to keep secrets out of messages and files."
    >
      <div className="script tall">
        <header className="skills-doc-head">
          <div className="skills-doc-title">
            <span>
              Instructions.md
            </span>
            <span className={`skills-doc-state${dirty ? " unsaved" : ""}`}>
              {!document
                ? "Loading…"
                : busy
                  ? "Saving…"
                  : dirty
                    ? "Unsaved"
                    : "Saved"}
            </span>
          </div>
          <button
            className="icon-btn small"
            aria-label="Reload saved file"
            title="Reload saved file"
            disabled={busy}
            onClick={reload}
          >
            <RotateCcw size={15} aria-hidden />
          </button>
          <button
            className="btn primary small"
            disabled={!dirty || busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </header>
        {error && (
          <p className="skills-doc-error error" role="alert">
            {error}
          </p>
        )}
        <div className="skills-doc-body">
          {document ? (
            <MarkdownEditor
              value={content}
              onChange={edit}
              onSave={() => void save()}
              markdownFile
            />
          ) : (
            <div className="skills-doc-empty">
              <p className="hint">
                {error ? "The document could not be loaded." : "Loading…"}
              </p>
            </div>
          )}
        </div>
        <footer className="skills-doc-foot">
          <span>
            <kbd>⌘</kbd>
            <kbd>S</kbd> saves
          </span>
          <span>Markdown</span>
        </footer>
      </div>
      {dialog.element}
    </Section>
  );
}
