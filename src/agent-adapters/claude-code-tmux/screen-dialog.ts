import type { ScreenDialog } from "../../core/agent";
import { DIALOG_LIMITS } from "../../core/dialog";

// Claude Code's own dialogs as drawn at the bottom of its screen (permission prompts no hook brought, the plan
// prompt, …): a rule, what it is about, a question, then numbered options, the chosen one marked `❯`, and a
// footer (`Esc to cancel · …`). Pressing an option's digit chooses it. The startup
// workspace-trust confirmation has no digits and needs arrow navigation instead.

const RULE = /^\s*[─━╌]{8,}\s*$/;
const OPTION = /^\s*(?:❯\s*)?(\d)\.\s+(\S.*?)\s*$/;
const NOISE = /^\s*(?:Tip:|Esc to |esc to |shift\+tab|Tab to )/;
/** An option that opens a field to type into: nobody could type there from the chat. */
const TYPE_IN = /tell claude what to change|type something|type here/i;

const cut = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

function workspaceTrustOf(plain: string): { dialog: ScreenDialog; selected: string } | undefined {
  const lines = plain.trimEnd().split("\n");
  const top = lines.findLastIndex(line => RULE.test(line));
  if (top < 0) return;
  const body = lines.slice(top + 1).filter(line => line.trim()).map(line => line.trim());
  if (body[0] !== "Accessing workspace:" || !body[1]?.startsWith("/")
    || !body.some(line => line.startsWith("Quick safety check: Is this a project you created or one you trust?"))
    || body.at(-1) !== "Enter to confirm · Esc to cancel") return;
  const options = body.slice(-3, -1);
  const no = /^(?:❯\s*)?(No, (?:exit|continue without these permissions))$/.exec(options[0] ?? "");
  const yes = /^(?:❯\s*)?(Yes, I trust this folder)$/.exec(options[1] ?? "");
  if (!no || !yes || options.filter(line => line.startsWith("❯")).length !== 1) return;
  const question = body.slice(0, -3).join("\n");
  return {
    selected: options[0]!.startsWith("❯") ? "decline" : "trust",
    dialog: { question: cut(question, DIALOG_LIMITS.text), options: [{ key: "decline", label: no[1]! }, { key: "trust", label: yes[1]! }],
      drawn: body.map(line => line.replace(/^❯\s*/, "")).join("\n") },
  };
}

/** Only the known workspace-trust menu uses navigation; these are never caller-supplied terminal keys. */
export function workspaceTrustKeys(plain: string, key: string): string[] | undefined {
  const trust = workspaceTrustOf(plain);
  if (!trust || !trust.dialog.options.some(option => option.key === key)) return;
  return [...(trust.selected === key ? [] : [key === "trust" ? "Down" : "Up"]), "Enter"];
}

/** The dialog at the bottom of a plain (no colours) screen, if its options can be answered safely. */
export function screenDialogOf(plain: string): ScreenDialog | undefined {
  const trust = workspaceTrustOf(plain);
  if (trust) return trust.dialog;
  const lines = plain.replace(/\s+$/, "").split("\n");
  // The options: the last run of numbered lines (an option's own second line may sit between two of them).
  let last = -1;
  for (let at = lines.length - 1; at >= Math.max(0, lines.length - 12); at--) if (OPTION.test(lines[at]!)) { last = at; break; }
  if (last < 0) return undefined;
  let first = last;
  for (let at = last - 1; at >= 0 && last - at <= 12; at--) {
    if (OPTION.test(lines[at]!)) first = at;
    else if (!lines[at]!.trim() || RULE.test(lines[at]!) || at < first - 1) break;
  }
  const drawnOptions = lines.slice(first, last + 1).filter(line => OPTION.test(line));
  // Claude's own: numbered 1, 2, … in order, the one chosen now marked ❯.
  if (drawnOptions.filter(line => /^\s*❯/.test(line)).length !== 1 || drawnOptions.some((line, at) => OPTION.exec(line)![1] !== String(at + 1))) return undefined;
  const options = drawnOptions.flatMap(line => {
    const match = OPTION.exec(line);
    if (!match || TYPE_IN.test(match[2]!)) return [];
    const whole = `${match[1]}. ${match[2]}`, label = cut(whole, DIALOG_LIMITS.label);
    return [{ key: match[1]!, label, ...(label !== whole ? { description: cut(whole, DIALOG_LIMITS.description) } : {}) }];
  });
  if (options.length < 2 || options.length > DIALOG_LIMITS.options || new Set(options.map(o => o.key)).size !== options.length) return undefined;
  // Above them, up to the box's top rule (a full one, not the dashed ones around a command): what it asks.
  let top = first - 1;
  while (top >= 0 && !(RULE.test(lines[top]!) && /[─━]/.test(lines[top]!))) top--;
  if (top < 0 || first - top > 40) return undefined;
  const question = lines.slice(top + 1, first).filter(line => line.trim() && !RULE.test(line) && !NOISE.test(line)).map(line => line.trim()).join("\n");
  if (!question) return undefined;
  // What is drawn, whole (the question and labels shown are cut to fit): the same dialog is the same text, to the end.
  const drawn = lines.slice(top + 1, last + 1).map(line => line.replace(/^\s*❯/, " ").trimEnd()).join("\n");
  return { question: cut(question, DIALOG_LIMITS.text), options, drawn };
}

/** The same dialog: what Household put to the person is still what is drawn, every character of it. */
export const sameScreenDialog = (a: ScreenDialog, b: ScreenDialog) => a.drawn !== undefined && a.drawn === b.drawn;
