import { useEffect, useRef } from "react";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

/** The editor in the design's colours (tokens.css), so it follows the theme; no fold gutter, no autocomplete. */
const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "transparent", fontSize: "var(--text-md)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "14px 0 40vh", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0 20px 0 14px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--faint)", border: "none", paddingLeft: "10px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "2.2em", padding: "0 2px 0 0", fontSize: "var(--text-xs)", lineHeight: "inherit" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--hover) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)", borderLeftWidth: "1.5px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--sel) !important" },
  ".cm-selectionMatch": { backgroundColor: "var(--hover)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--sel)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--pop)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panel input, .cm-panel button": { font: "inherit" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--busy) 30%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--busy) 55%, transparent)" },
  // A skill's frontmatter (the name and description harnesses read first): quieter than the body, in one tone.
  ".cm-frontmatter": { color: "var(--muted)" },
  ".cm-frontmatter span": { color: "inherit !important", fontWeight: "inherit !important", textDecoration: "none !important" },
});

/** Markdown marked by tone and weight, not colour: headings and strong in ink, its punctuation faint, code warm. */
const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600", color: "var(--ink)" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.processingInstruction, t.contentSeparator, t.punctuation], color: "var(--faint)" },
  { tag: t.list, color: "var(--muted)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--muted)", textDecoration: "underline", textDecorationColor: "var(--faint)" },
  { tag: t.monospace, color: "color-mix(in oklch, var(--busy) 60%, var(--ink))" },
  { tag: [t.comment, t.meta], color: "var(--faint)" },
]);

/** The lines of a leading `---` … `---` block. */
const frontmatter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return builder.finish();
      let end = 0;
      for (let n = 2; n <= Math.min(doc.lines, 200); n++) {
        if (doc.line(n).text.trim() === "---") {
          end = n;
          break;
        }
      }
      if (!end) return builder.finish();
      const line = Decoration.line({ class: "cm-frontmatter" });
      for (let n = 1; n <= end; n++) builder.add(doc.line(n).from, doc.line(n).from, line);
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** A CodeMirror editor: edits stay in the page until Save (⌘/Ctrl-S here too); nothing remote. */
export function MarkdownEditor({ value, onChange, onSave, markdownFile = true }: { value: string; onChange: (value: string) => void; onSave: () => void; markdownFile?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (callbacks.current.onSave(), true) }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          ...(markdownFile ? [markdown(), frontmatter] : []),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')?.content ?? ""),
          EditorView.contentAttributes.of({ "aria-label": "File content" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [markdownFile]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  return <div ref={host} className="code-editor" />;
}
