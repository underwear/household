import { useEffect, type RefObject } from "react";

const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** What Tab can reach inside `root`, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

/**
 * While `active`: Tab and Shift+Tab go round inside `ref` (focus outside it comes back in), Escape calls
 * `onEscape`. For modal things: dialogs, the nav drawer.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const inside = focusables(root);
      if (inside.length === 0) return;
      const first = inside[0]!;
      const last = inside[inside.length - 1]!;
      const current = document.activeElement;
      if (!root.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [ref, active, onEscape]);
}
