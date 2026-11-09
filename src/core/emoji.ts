/** A pet's mark when its config gives none. */
export const DEFAULT_PET_EMOJI = "🤖";

const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const TEXT_DEFAULT = /^\p{Emoji}$/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;
const VS16 = "\u{FE0F}";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A character that is an emoji only when asked (no emoji presentation of its own): it wants VS16 after it. */
const wantsVs16 = (char: string) => TEXT_DEFAULT.test(char) && !EMOJI_PRESENTATION.test(char) && !MODIFIER.test(char);

/**
 * Pictographs that read as emoji when typed bare (❤ ☺ ✌: Miscellaneous Symbols, Dingbats, the emoji planes); a
 * bare text symbol elsewhere (© ™ ‼ ↔ ℹ) is just text.
 */
const isPictograph = (char: string) => {
  const code = char.codePointAt(0)!;
  return (code >= 0x2600 && code <= 0x27bf) || code >= 0x1f000;
};

/**
 * `text` as one fully-qualified emoji (VS16 added where it is needed, inside ZWJ sequences too: ❤ → ❤️,
 * 🏳‍🌈 → 🏳️‍🌈), or undefined when it is not exactly one: text, a digit, two emoji, a space around it, a lone skin
 * tone or a bare text symbol (©) are not. ZWJ sequences, skin tones on a base, flags and keycaps are one.
 */
export function emojiOf(text: string): string | undefined {
  const [first, second] = graphemes.segment(text);
  if (!first || second || MODIFIER.test(text)) return undefined;
  const chars = [...text];
  if (chars.length === 1 && wantsVs16(text) && !isPictograph(text)) return undefined;
  const qualified = chars.map((char, index) => (wantsVs16(char) && chars[index + 1] !== VS16 && !MODIFIER.test(chars[index + 1] ?? "") ? char + VS16 : char)).join("");
  return RGI_EMOJI.test(qualified) ? qualified : undefined;
}
