import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Dices, Search } from "lucide-react";
import { emojiOf } from "../../src/core/emoji";
import { ALL_EMOJI, EMOJI_GROUPS } from "./emoji-data";
import { Field } from "./fields";

/**
 * A bot's (or scout's) emoji: a button that shows it and opens a picker under the form, a row of its own — search by
 * word, groups as tabs, a grid to click or move through with the arrow keys, a die for a random one, and a box to
 * paste any other emoji. `value` "" is none: the `fallback` (🤖) shows, dimmed, and "Use default" sets it back.
 * Escape closes the picker, not the dialog around it.
 */
export function EmojiField({ label = "Emoji", value, onChange, fallback = "🤖", hint }: { label?: string; value: string; onChange: (emoji: string) => void; fallback?: string; hint?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState(0);
  const [pasted, setPasted] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(
    () => (words.length > 0 ? ALL_EMOJI.filter(([emoji, about]) => words.every((word) => about.split(" ").some((each) => each.startsWith(word)) || emoji === word)) : EMOJI_GROUPS[group]!.emoji),
    [words.join(" "), group],
  );
  const pastedEmoji = pasted.trim() ? emojiOf(pasted.trim()) : undefined;

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setPasted("");
    trigger.current?.focus();
  };
  const pick = (emoji: string) => {
    onChange(emoji);
    close();
  };
  const surprise = () => pick(ALL_EMOJI[Math.floor(Math.random() * ALL_EMOJI.length)]![0]);

  /** Arrow keys move through the grid; Home/End to its ends. */
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    // A row's emoji, as the grid lays them out now (fewer on a phone).
    const columns = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").length || 9 : 9;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : step === undefined ? undefined : at + step;
    if (next === undefined) return;
    event.preventDefault();
    if (next < 0 && event.key === "ArrowUp") return search.current?.focus();
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  };

  // Escape anywhere in it (the button too, while open) closes the picker, not the dialog around it.
  return (
    <div
      className="emoji-field"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <Field id={id} label={label} hint={hint}>
        <button
          ref={trigger}
          id={id}
          type="button"
          className="control emoji-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <span className={value ? "emoji-trigger-mark" : "emoji-trigger-mark faint"} aria-hidden>
            {value || fallback}
          </span>
          <span className="emoji-trigger-text">{value ? "Change" : "Choose…"}</span>
          <ChevronDown size={16} aria-hidden className="chevron" />
        </button>
      </Field>
      {open && (
        <div className="emoji-picker" role="dialog" aria-label="Choose an emoji">
          <div className="emoji-picker-top">
            <label className="emoji-search">
              <Search size={16} aria-hidden />
              <span className="visually-hidden">Search emoji</span>
              <input
                ref={search}
                className="control"
                value={query}
                placeholder="Search: owl, rocket, heart…"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (shown[0]) pick(shown[0][0]);
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    grid.current?.querySelector("button")?.focus();
                  }
                }}
              />
            </label>
            <button type="button" className="icon-btn" title="Surprise me" aria-label="Pick a random emoji" onClick={surprise}>
              <Dices size={18} aria-hidden />
            </button>
          </div>
          {words.length === 0 && (
            <div className="emoji-tabs" role="tablist" aria-label="Emoji groups">
              {EMOJI_GROUPS.map((each, index) => (
                <button key={each.name} type="button" role="tab" aria-selected={index === group} className={index === group ? "emoji-tab current" : "emoji-tab"} title={each.name} onClick={() => setGroup(index)}>
                  <span aria-hidden>{each.icon}</span>
                  <span className="visually-hidden">{each.name}</span>
                </button>
              ))}
            </div>
          )}
          <p className="emoji-picker-caption">{words.length > 0 ? (shown.length > 0 ? `${shown.length} found` : "Nothing found — paste any emoji below") : EMOJI_GROUPS[group]!.name}</p>
          <div ref={grid} className="emoji-grid" role="listbox" aria-label="Emoji" onKeyDown={move}>
            {shown.map(([emoji, about]) => (
              <button key={emoji} type="button" role="option" aria-selected={emoji === value} aria-label={about.split(" ")[0]} title={about.split(" ")[0]} className={emoji === value ? "emoji-cell current" : "emoji-cell"} onClick={() => pick(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
          <div className="emoji-picker-bottom">
            <input
              className="control emoji-paste"
              value={pasted}
              placeholder="Or paste any emoji"
              aria-label="Paste any emoji"
              aria-invalid={pasted.trim() !== "" && !pastedEmoji}
              onChange={(event) => setPasted(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (pastedEmoji) pick(pastedEmoji);
              }}
            />
            <button type="button" className="btn small" disabled={!pastedEmoji} onClick={() => pastedEmoji && pick(pastedEmoji)}>
              Use
            </button>
            {value && (
              <button type="button" className="btn small" onClick={() => pick("")}>
                Use default {fallback}
              </button>
            )}
          </div>
          {pasted.trim() !== "" && !pastedEmoji && <p className="error">That is not one emoji.</p>}
        </div>
      )}
    </div>
  );
}
