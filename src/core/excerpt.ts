// How Household shows text elsewhere (in a header, in a notice): one line, cut on grapheme clusters, so a flag,
// a skin tone or a keycap is never split. All of Household's cutting is here.

/** How much of a message a reaction's header shows, and the head of `headAndTail`. */
export const EXCERPT_MAX = 60;
/** The most `headAndTail` gives. */
export const HEAD_AND_TAIL_MAX = 200;
const GAP = " … ";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) => Array.from(segmenter.segment(text), ({ segment }) => segment);

/** Control characters and runs of white space (line breaks too) as one space, trimmed. */
const flatten = (text: string) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim();

/** Text in one line, cut to `max` grapheme clusters (`…` last when cut). */
export function oneLine(text: string, max = EXCERPT_MAX): string {
  const flat = flatten(text);
  const parts = graphemes(flat);
  return parts.length > max ? `${parts.slice(0, max - 1).join("")}…` : flat;
}

/**
 * Text in one line, its beginning and its end when it is long (a question usually sits at the end): the first
 * 60 grapheme clusters, ` … `, and the last ones, at most HEAD_AND_TAIL_MAX in all.
 */
export function headAndTail(text: string): string {
  const flat = flatten(text);
  const parts = graphemes(flat);
  if (parts.length <= HEAD_AND_TAIL_MAX) return flat;
  const tail = HEAD_AND_TAIL_MAX - EXCERPT_MAX - GAP.length;
  return `${parts.slice(0, EXCERPT_MAX).join("").trimEnd()}${GAP}${parts.slice(-tail).join("").trimStart()}`;
}

/**
 * Text as it is (lines too), cut to at most `max` grapheme clusters and `maxUnits` UTF-16 code units, whichever
 * comes first. A cluster is never split, unless one alone is over `maxUnits` (a letter under a thousand marks):
 * then it is cut by code points. `truncated` says it was cut.
 */
export function upTo(text: string, max: number, maxUnits: number): { text: string; truncated: boolean } {
  if (text.length <= Math.min(max, maxUnits)) return { text, truncated: false }; // fewer code units: fewer clusters too
  let kept = "";
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (count === max || kept.length + segment.length > maxUnits) break;
    kept += segment;
    count++;
  }
  if (kept.length === text.length) return { text, truncated: false };
  if (kept === "") for (const point of text) if (kept.length + point.length <= maxUnits) kept += point; else break;
  return { text: kept, truncated: true };
}
