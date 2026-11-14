import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useFocusTrap } from "./focus-trap";
import { focusPage } from "./layout";

export interface DialogSpec {
  title: string;
  body?: ReactNode;
  /** Fields, if the dialog asks for something: the first one gets the focus. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** The confirm button's words while it works («Restarting…»); «Working…» by default. */
  busyLabel?: string;
  danger?: boolean;
  /**
   * The safe choice is the default: Cancel is the primary, focused button, the confirmation a second one (danger
   * styled with `danger`). For a risk the owner must mean to take.
   */
  safe?: boolean;
  /**
   * The action; the dialog stays open, showing the error, if it fails, or when it resolves to "stay" (a step of
   * the dialog done, the next one shown).
   */
  onConfirm: () => Promise<void | "stay">;
  /** A step back (shows Back): for a dialog of steps. */
  back?: () => void;
  /** A step the owner may leave for later («Skip for now»): a quiet button before the confirmation. */
  skip?: { label: string; onSkip: () => void };
  /** A form of several groups: a wider card. */
  wide?: boolean;
  /** Names the step on screen, for a dialog of steps: a new one gets the focus as a new dialog does. */
  step?: string;
}

/** What a form control is, as far as the first focus goes. */
interface Control {
  tagName: string;
  type?: string;
  name?: string;
  readOnly?: boolean;
  disabled?: boolean;
}

/**
 * Where a dialog's focus goes first: its first field (input, select, textarea you can change), else its submit
 * button. On a touch screen not a field (that would open the keyboard over the dialog): the form itself. A `safe`
 * dialog's: its Cancel.
 */
export function firstFocus<T extends Control>(controls: Iterable<T>, form: T, touch: boolean, safe = false): T {
  const all = [...controls].filter((control) => !control.disabled);
  const cancel = safe ? all.find((control) => control.tagName === "BUTTON" && control.name === "cancel") : undefined;
  if (cancel) return cancel;
  const field = all.find(({ tagName, type, readOnly }) => (tagName === "INPUT" ? type !== "hidden" && !readOnly : tagName === "SELECT" || (tagName === "TEXTAREA" && !readOnly)));
  if (field) return touch ? form : field;
  return all.find((control) => control.tagName === "BUTTON" && control.type === "submit") ?? form;
}

/** Keeps `--vv-top` / `--vv-height` on the page at the visual viewport (what an on-screen keyboard leaves). */
function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement.style;
    const update = () => {
      root.setProperty("--vv-top", `${viewport.offsetTop}px`);
      root.setProperty("--vv-height", `${viewport.height}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.removeProperty("--vv-top");
      root.removeProperty("--vv-height");
    };
  }, []);
}

/**
 * Whether `body` (a scrolling box) has more above and below what shows: its edges are shaded then, so content
 * that goes on under the buttons does not look cut off. Kept as it scrolls and as its content or size changes.
 */
function useScrollEdges(body: RefObject<HTMLElement | null>): { above: boolean; below: boolean } {
  const [edges, setEdges] = useState({ above: false, below: false });
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const update = () => {
      const above = element.scrollTop > 1;
      const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      setEdges((last) => (last.above === above && last.below === below ? last : { above, below }));
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    resized?.observe(element);
    for (const child of element.children) resized?.observe(child);
    const changed = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(() => {
      for (const child of element.children) resized?.observe(child);
      update();
    });
    changed?.observe(element, { childList: true, subtree: true });
    return () => { element.removeEventListener("scroll", update); resized?.disconnect(); changed?.disconnect(); };
  }, [body]);
  return edges;
}

/**
 * A confirmation (or a small form): Cancel, Escape or a click outside closes it; Enter confirms (in a `safe` one,
 * where the focus starts on Cancel, Enter there cancels). The focus goes to
 * its first field (else to its button), stays inside while it is open, and goes back where it was when it closes
 * (to the page's title if that is gone). A centred card; on a phone a bottom sheet whose body scrolls under the
 * title and above the buttons.
 */
export function Dialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const form = useRef<HTMLFormElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(body);
  /** A press that started on the scrim (a drag from inside that ends outside is not a click outside). */
  const pressedOutside = useRef(false);
  const close = useCallback(() => !busy && onClose(), [busy, onClose]);
  useFocusTrap(form, true, close);
  useVisualViewport();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      opener?.focus();
      if (!opener || document.activeElement !== opener) focusPage();
    };
  }, []);
  // On opening, and on every step.
  useEffect(() => {
    const root = form.current!;
    firstFocus(root.elements as Iterable<HTMLElement & Control>, root as HTMLElement & Control, matchMedia("(pointer: coarse)").matches, spec.safe).focus();
  }, [spec.step]);

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await spec.onConfirm();
      if (outcome !== "stay") return onClose();
    } catch (failure) {
      setError((failure as Error).message);
    }
    setBusy(false);
  };

  return (
    <div
      className="scrim"
      onPointerDown={(event) => (pressedOutside.current = event.target === event.currentTarget)}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedOutside.current) close();
        pressedOutside.current = false;
      }}
    >
      <form
        ref={form}
        className={spec.wide ? "dialog wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void confirm();
        }}
      >
        <h2 className="dialog-title">{spec.title}</h2>
        <div ref={body} className={`dialog-body${edges.above ? " more-above" : ""}${edges.below ? " more-below" : ""}`}>
          {spec.body && <p className="dialog-text">{spec.body}</p>}
          {spec.children}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className={spec.safe ? "dialog-foot safe" : "dialog-foot"}>
          {spec.back && (
            <button
              type="button"
              className="btn back"
              onClick={() => {
                setError(undefined);
                spec.back!();
              }}
              disabled={busy}
            >
              Back
            </button>
          )}
          {spec.safe ? (
            // Cancel first in the DOM (and in Tab order), shown last as the primary one (`.safe` sets the order).
            <>
              <button type="button" name="cancel" className="btn primary" onClick={onClose} disabled={busy}>
                {spec.cancelLabel ?? "Cancel"}
              </button>
              <button type="submit" className={spec.danger ? "btn danger" : "btn"} disabled={busy}>
                {busy ? (spec.busyLabel ?? "Working…") : spec.confirmLabel}
              </button>
            </>
          ) : (
            <>
              <button type="button" name="cancel" className="btn" onClick={onClose} disabled={busy}>
                {spec.cancelLabel ?? "Cancel"}
              </button>
              {spec.skip && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setError(undefined);
                    spec.skip!.onSkip();
                  }}
                  disabled={busy}
                >
                  {spec.skip.label}
                </button>
              )}
              <button type="submit" className={spec.danger ? "btn danger-fill" : "btn primary"} disabled={busy}>
                {busy ? (spec.busyLabel ?? "Working…") : spec.confirmLabel}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

/** A dialog slot for a page: `open(spec)` shows one (a fresh one each time: nothing carries over), `element` is where it renders. */
export function useDialog() {
  const [opened, setOpened] = useState<{ spec: DialogSpec; key: number } | null>(null);
  const close = useCallback(() => setOpened(null), []);
  const open = useCallback((spec: DialogSpec) => setOpened((last) => ({ spec, key: (last?.key ?? 0) + 1 })), []);
  const element = opened && <Dialog key={opened.key} spec={opened.spec} onClose={close} />;
  return { element, open };
}
