import { HouseholdError } from "./errors";

/**
 * Text that crosses between a bot and a scout, or that a bot proposes to the owner, is read by the owner before it
 * goes anywhere. A character the owner cannot see (or that shows as something else) breaks that promise: a language
 * model reads it all the same. So such characters are refused in what a bot drafts for the owner, and removed from what
 * passes between a bot and a scout, the owner seeing exactly what is delivered.
 *
 * Hidden: every default-ignorable code point (zero-width characters, soft hyphen, direction overrides and isolates,
 * variation selectors, tag characters, Hangul fillers…), control characters (a lone carriage return rewrites a
 * terminal line), line and paragraph separators, interlinear annotations, the braille blank and musical format
 * characters. Kept, because writing needs them: tab and line feed; LRM and RLM; a ZWNJ or ZWJ between letters or their
 * marks (Persian, Urdu, Indic scripts); a ZWJ inside an emoji sequence; VS15 or VS16 once, directly after a character
 * that has an emoji form; and the three subdivision flags (England, Scotland, Wales), whose tag characters are the flag.
 */

/** The flags written with tag characters: 🏴 then the tags of "gbeng", "gbsct" or "gbwls", then the cancel tag. */
const FLAGS = ["gbeng", "gbsct", "gbwls"].map(code => `\u{1F3F4}${[...code].map(letter => String.fromCodePoint(0xE0000 + letter.charCodeAt(0))).join("")}\u{E007F}`);
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/** Hidden or misleading, though not default-ignorable. */
const ALSO_HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u2800\uFFF9-\uFFFB\u{1D173}-\u{1D17A}]/u;
const LETTER = /[\p{L}\p{M}]/u, EMOJI = /\p{Emoji}/u, PICTURE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}]/u;
const FLAG = "\u{1F3F4}";

/** The text as units: each code point, a whole subdivision flag as one. Windows line ends are line ends. */
function units(text: string): string[] {
  const points = [...text.replaceAll("\r\n", "\n")], out: string[] = [];
  for (let index = 0; index < points.length; index++) {
    const flag = points[index] === FLAG ? FLAGS.find(each => points.slice(index, index + [...each].length).join("") === each) : undefined;
    if (flag) { out.push(flag); index += [...flag].length - 1; }
    else out.push(points[index]!);
  }
  return out;
}
/** Whether the unit at `index` is hidden, judged with its neighbours. A flag counts as the emoji it is. */
function hidden(all: string[], index: number): boolean {
  const unit = all[index]!, code = unit.codePointAt(0)!;
  if (FLAGS.includes(unit)) return false;
  const before = all[index - 1] && (FLAGS.includes(all[index - 1]!) ? FLAG : all[index - 1]!), after = all[index + 1] && (FLAGS.includes(all[index + 1]!) ? FLAG : all[index + 1]!);
  if (code === 0x200E || code === 0x200F) return false;
  if (code === 0x200C || code === 0x200D) {
    if (before && after && LETTER.test(before) && LETTER.test(after)) return false;
    // In an emoji sequence: woman + ZWJ + laptop; a VS16 or a skin tone may stand before the joiner.
    const base = before === "\uFE0F" ? all[index - 2] : before;
    return !(code === 0x200D && base && after && PICTURE.test(base) && PICTURE.test(after));
  }
  if (code === 0xFE0E || code === 0xFE0F) return !(before && before !== "\uFE0E" && before !== "\uFE0F" && EMOJI.test(before));
  return IGNORABLE.test(unit) || ALSO_HIDDEN.test(unit);
}

/** The first hidden character of `text`, as U+XXXX; undefined: it shows as it is. For text a bot proposes: refused. */
export function hiddenCharacter(text: string): string | undefined {
  const all = units(text);
  for (const index of all.keys()) if (hidden(all, index)) return `U+${all[index]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
  return undefined;
}

/** `text` without its hidden characters (Windows line ends made line ends), and how many went. For text that passes on. */
export function withoutHidden(text: string): { text: string; removed: number } {
  const all = units(text), kept = all.filter((_, index) => !hidden(all, index));
  return { text: kept.join(""), removed: all.length - kept.length };
}

/** Text a bot proposes to the owner (a draft's description, instructions, install script…): refused when it hides anything. */
export function assertPlain(value: unknown, field: string): void {
  const found = typeof value === "string" ? hiddenCharacter(value) : undefined;
  if (found) throw new HouseholdError(`${field} holds a character that hides or reorders text (${found}): your human must see exactly what runs. Write it plainly`);
}
