import { useEffect, useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { api, type EnvironmentView, type PetView } from "../api";
import { useDialog } from "./dialog";
import { Section } from "./layout";
import { MarkdownEditor } from "./markdown-editor";

type Phase = "setup" | "onStart";
type Run = NonNullable<EnvironmentView["lastRun"]>;

/** The two scripts: what each is for, its file name, and where its last run is in the view. */
const SCRIPTS: Record<Phase, { file: string; title: string; when: string; about: string; run: "lastRun" | "onStartLastRun" }> = {
  setup: {
    file: "setup.sh",
    title: "Setup",
    when: "Once, when the VM is created",
    about: "Installs tools. Runs once per VM, not on restarts: after a change, Run now.",
    run: "lastRun",
  },
  onStart: {
    file: "on-start.sh",
    title: "On start",
    when: "At every boot, before the agent",
    about: "Starts services on every boot. Keep it safe to repeat; background long-running processes.",
    run: "onStartLastRun",
  },
};

/**
 * What an empty script's editor starts with: a commented example, so it reads as Bash and says what goes there.
 * Shown, not saved: nothing runs until it is changed and saved.
 */
export const TEMPLATES: Record<Phase, string> = {
  setup: `#!/usr/bin/env bash
# Setup: runs once, when this pet's VM is created, as the pet user (sudo works).
# Restarts do not repeat it; after a change, Run now. The pet can edit it too.
# Hosts it downloads from must be on the house's Network allowlist.
set -euo pipefail

echo "Setting up $(hostname)"

# sudo apt-get update
# sudo apt-get install -y jq ripgrep
`,
  onStart: `#!/usr/bin/env bash
# On start: runs at every VM boot, before the agent, as the pet user.
# Keep it safe to repeat; start long-running services in the background.
set -euo pipefail

echo "Starting $(hostname)"

# nohup my-service >"$HOME/my-service.log" 2>&1 &
`,
};

/** A run's outcome as people read it, and its tone (the design's state colours). */
const OUTCOME: Record<Run["status"], { label: string; tone: string }> = {
  complete: { label: "Completed", tone: "idle" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped: no script", tone: "off" },
};

/**
 * A pet's environment: its two Bash scripts (Setup, once when the VM is created; On start, at every boot), run as
 * the pet user and saved in household.yaml; the pet edits them as well. An empty one shows its example (TEMPLATES). Like Skills: the scripts on the left with how each last ran, the chosen
 * one in the editor on the right. Saving runs nothing; Run now runs the saved script in the current VM.
 */
export function PetEnvironment({ house, pet }: { house: string; pet: PetView }) {
  const [view, setView] = useState<EnvironmentView>();
  const [drafts, setDrafts] = useState<Record<Phase, string>>({ setup: "", onStart: "" });
  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dialog = useDialog();
  useEffect(() => {
    let cancelled = false;
    void api.environment(house, pet.name).then(
      (data) => {
        if (!cancelled) {
          setView(data);
          setDrafts({ setup: data.setup ?? TEMPLATES.setup, onStart: data.onStart ?? TEMPLATES.onStart });
        }
      },
      (e) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [house, pet.name]);
  const saved = (which: Phase) => view?.[which] ?? "";
  /** What the editor shows when nothing has been typed: the saved script, else its template. */
  const baseline = (which: Phase) => saved(which) || TEMPLATES[which];
  const dirty = (which: Phase) => !!view && drafts[which] !== baseline(which) && !(drafts[which].trim() === "" && !saved(which));
  const script = SCRIPTS[phase];
  const save = async () => {
    if (busy || !dirty(phase)) return;
    const which = phase;
    const submitted = drafts[which];
    setBusy(true);
    setError(undefined);
    try {
      const next = await api.updateEnvironment(house, pet.name, { [which]: submitted.trim() ? submitted : null });
      setView(next);
      // Do not discard edits typed while the save was in flight.
      setDrafts((current) => ({ ...current, [which]: current[which] === submitted ? (next[which] ?? TEMPLATES[which]) : current[which] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = () => {
    const which = phase;
    dialog.open({
      title: `Run ${SCRIPTS[which].file} now?`,
      body: "Runs the saved script in the current VM; the agent keeps working. Up to 15 minutes.",
      confirmLabel: "Run now",
      busyLabel: "Running…",
      onConfirm: async () => {
        const result = await api.runEnvironment(house, pet.name, which);
        setView((current) => current && { ...current, [SCRIPTS[which].run]: result });
      },
    });
  };
  const last = view?.[script.run] ?? null;
  const offline = pet.enabled === false;
  return (
    <Section width="wide" hint={`Bash, run as the pet user with sudo. ${pet.title} can edit and run them too. Stored in household.yaml: no secrets.`}>
      <div className="skills env">
        <nav className="skills-nav" aria-label="Scripts">
          <ul>
            {(Object.keys(SCRIPTS) as Phase[]).map((which) => {
              const each = SCRIPTS[which];
              const ran = view?.[each.run];
              const outcome = ran ? OUTCOME[ran.status] : undefined;
              return (
                <li key={which} className={which === phase ? "skill open" : "skill"}>
                  <button type="button" className="skill-head" aria-current={which === phase ? "true" : undefined} onClick={() => setPhase(which)}>
                    <span className="skill-name env-name">
                      {each.title}
                      {dirty(which) && <span className="dot busy" aria-label="Unsaved changes" />}
                    </span>
                    <span className="skill-description">{each.when}</span>
                    <span className="env-last">
                      {!view ? (
                        "…"
                      ) : !saved(which) ? (
                        <span className="faint">No script</span>
                      ) : outcome ? (
                        <>
                          <span className={`dot ${outcome.tone}`} /> {outcome.label}
                        </>
                      ) : (
                        <span className="faint">Not run yet</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <section className="skills-doc" aria-label={`${script.title} script`}>
          <header className="skills-doc-head">
            <div className="skills-doc-title">
              <span className="ellipsis">{script.file}</span>
              <span className={dirty(phase) ? "skills-doc-state unsaved" : "skills-doc-state"}>{!view ? (error ? "Not loaded" : "Loading…") : busy ? "Working…" : dirty(phase) ? "Unsaved" : saved(phase) ? "Saved" : "Example · not saved"}</span>
            </div>
            <button
              type="button"
              className="icon-btn small"
              title="Discard changes"
              aria-label="Discard changes"
              disabled={busy || !dirty(phase)}
              onClick={() =>
                dialog.open({
                  title: "Discard your changes?",
                  body: saved(phase) ? `${script.file} goes back to what is saved.` : `${script.file} goes back to the example.`,
                  confirmLabel: "Discard",
                  danger: true,
                  onConfirm: async () => setDrafts((current) => ({ ...current, [phase]: baseline(phase) })),
                })
              }
            >
              <RotateCcw size={15} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              className="btn small env-run"
              title={offline ? "The pet is disabled" : dirty(phase) ? "Save first" : undefined}
              disabled={!view || busy || offline || dirty(phase) || !saved(phase)}
              onClick={run}
            >
              <Play size={12} strokeWidth={2} aria-hidden /> Run now
            </button>
            <button type="button" className="btn primary small" disabled={!dirty(phase) || busy} onClick={() => void save()}>
              Save
            </button>
          </header>
          <p className="env-about">{script.about}</p>
          {error && (
            <p className="skills-doc-error error" role="alert">
              {error}
            </p>
          )}
          <div className="skills-doc-body">
            {view ? (
              <MarkdownEditor key={phase} value={drafts[phase]} markdownFile={false} onChange={(value) => setDrafts((current) => ({ ...current, [phase]: value }))} onSave={() => void save()} />
            ) : (
              <div className="skills-doc-empty">
                <p className="hint">{error ? "The scripts could not be loaded." : "Loading…"}</p>
              </div>
            )}
          </div>
          <footer className="skills-doc-foot">
            {last ? (
              <span className="env-foot-run">
                <span className={`dot ${OUTCOME[last.status].tone}`} />
                {OUTCOME[last.status].label} · log <code>{last.logPath}</code> · status <code>{last.statusPath}</code>
              </span>
            ) : (
              <span>
                <kbd>⌘</kbd>
                <kbd>S</kbd> saves · saving runs nothing
              </span>
            )}
            <span>Bash · as the pet user</span>
          </footer>
        </section>
      </div>
      {dialog.element}
    </Section>
  );
}
