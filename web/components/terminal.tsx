import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { useFocusTrap } from "./focus-trap";
import { focusPage } from "./layout";
import { pollTerminal } from "./terminal-poll";

/** The bot's tmux window (claude-code-tmux entrypoint.sh: `-x 160 -y 48`): the Console fits it whole, without scrolling. */
const SCREEN = { cols: 160, rows: 48 };
const LINE_HEIGHT = 1.25;
/** The smallest and largest text the fit picks, in px: smaller is unreadable, larger wastes the screen. */
const FONT = { min: 7, max: 14 };

/** The font size at which `cols` × `rows` monospace cells fill a box; `charWidth`: one cell's width per 1px of font. */
export function fitFont(box: { width: number; height: number }, charWidth: number): number {
  const size = Math.min(box.width / (SCREEN.cols * charWidth), box.height / (SCREEN.rows * LINE_HEIGHT));
  return Math.max(FONT.min, Math.min(FONT.max, Math.floor(size * 10) / 10));
}

/** A snapshot viewer: no keyboard input is forwarded to the bot. */
export function TerminalDialog({ house, pet, title, onClose }: { house: string; pet: string; title: string; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLPreElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState<number>();
  const followScreen = useRef(true);
  const receivedScreen = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pressedOutside = useRef(false);
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const close = useCallback(() => onClose(), [onClose]);
  useFocusTrap(root, true, close);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const visibility = () => setVisible(document.visibilityState !== "hidden");
    // Holding a selection pauses snapshots so copying text never loses its range.
    const selection = () => {
      const selected = document.getSelection();
      setSelecting(!!selected && !selected.isCollapsed && !!screen.current &&
        (screen.current.contains(selected.anchorNode) || screen.current.contains(selected.focusNode)));
    };
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("selectionchange", selection);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("selectionchange", selection);
      opener?.focus();
      if (!opener || document.activeElement !== opener) focusPage();
    };
  }, []);

  useEffect(() => {
    if (!visible || paused || selecting) return;
    return pollTerminal((signal) => api.terminal(house, pet, signal), (snapshot) => {
      // A selection can begin between a response and the selectionchange event.
      const selected = document.getSelection();
      if (selected && !selected.isCollapsed && screen.current &&
        (screen.current.contains(selected.anchorNode) || screen.current.contains(selected.focusNode))) return;
      const pane = screen.current;
      followScreen.current = !receivedScreen.current || !!pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 2;
      receivedScreen.current = true;
      setText(snapshot);
      setError(undefined);
    }, setError);
  }, [house, pet, visible, paused, selecting]);

  // The text grows or shrinks with the dialog so the whole tmux screen shows at once; earlier lines scroll above it.
  useLayoutEffect(() => {
    const pane = screen.current;
    if (!pane || !probe.current || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const style = getComputedStyle(pane);
      const width = pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = pane.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      // The probe: 10 cells at 100px.
      const charWidth = probe.current!.getBoundingClientRect().width / 1000;
      if (width > 0 && height > 0 && charWidth > 0) setFontSize(fitFont({ width, height }, charWidth));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (text !== undefined && followScreen.current && screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [text, fontSize]);

  return (
    <div className="scrim"
      onPointerDown={(event) => (pressedOutside.current = event.target === event.currentTarget)}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedOutside.current) close();
        pressedOutside.current = false;
      }}>
      <div ref={root} className="dialog terminal-dialog" role="dialog" aria-modal="true" aria-label={`${title} console`} tabIndex={-1}>
        <h2 className="dialog-title">{title} console</h2>
        <div className="terminal-description">
          <p className="hint">Read-only · updates every 2 s</p>
          <p className={error ? "error" : "hint"} role="status">
            {error ? `${text === undefined ? "Screen unavailable" : "Stale screen"}: ${error}.` :
              paused ? "Updates paused." : selecting ? "Updates paused while text is selected." : !visible ? "Updates paused while this tab is hidden." : text === undefined ? "Loading screen…" : "Live."}
          </p>
        </div>
        <span ref={probe} className="terminal-probe" aria-hidden>0000000000</span>
        <pre ref={screen} className="terminal-screen fit" style={fontSize ? { fontSize: `${fontSize}px` } : undefined} tabIndex={0} aria-label="Current terminal screen">{text ?? "Waiting for the first screen…"}</pre>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={() => setPaused((value) => !value)}>{paused ? "Resume updates" : "Pause updates"}</button>
          <button ref={closeButton} type="button" className="btn primary" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
