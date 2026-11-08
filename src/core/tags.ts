/**
 * Household's tags in what a pet gets (the chat contract). Each message is one
 * `household-message` block: its `household-header`, if it has a body, its `household-content`, and if it came
 * with files, its `household-attachments`; messages
 * sent together are wrapped in one `household-batch`. All of them start with `household-`, so the guard below
 * can refuse ours, also disguised, without refusing ordinary tags (`<message>`).
 */
export const BATCH_TAG = "household-batch";
export const MESSAGE_TAG = "household-message";
export const HEADER_TAG = "household-header";
export const INTERNAL_TAG = "household-internal";
export const MEMORY_TAG = "household-memory";
export const SCOUTS_TAG = "household-scouts";
export const CLOCK_TAG = "household-clock";
export const CONTENT_TAG = "household-content";
export const ATTACHMENTS_TAG = "household-attachments";

/**
 * A block: the opening tag (with Household's own attributes: ids, counts), the lines inside, the closing tag,
 * each on a line of its own.
 */
export function block(tag: string, lines: string[], attributes: Record<string, string | number> = {}): string {
  const shown = Object.entries(attributes).map(([name, value]) => ` ${name}="${value}"`).join("");
  return [`<${tag}${shown}>`, ...lines, `</${tag}>`].join("\n");
}

/**
 * Compact JSON in which `<` and `>` are escapes (`\u003c`, `\u003e`): it never holds a tag, whatever its values
 * say and whatever the guard below misses. Household's JSON for pets (a header's line, a tool's result) is this.
 */
export const tagFreeJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/** Opening angle brackets and what passes for them after NFKD (not `«`: Russian quotes are ordinary text). */
const OPENERS = "<‹❬❮≪˂ᐸ〈⟨";
const OURS = [BATCH_TAG, MESSAGE_TAG, HEADER_TAG, CONTENT_TAG, ATTACHMENTS_TAG, CLOCK_TAG, MEMORY_TAG, SCOUTS_TAG, INTERNAL_TAG].map((tag) => tag.replace(/^household-/, "")).join("|");
/**
 * An opening bracket, maybe `/`, `household`, at most 3 characters that are no letter or digit (any dash, `_`,
 * `.`, `:`, `/`, spaces), one of our names. Only ours, and only after a bracket: `household-size > 3` is text.
 */
const TAG = new RegExp(String.raw`[${OPENERS}]\s*\/?\s*household[^\p{L}\p{N}]{0,3}(?:${OURS})`, "u");

/**
 * NFKD (fullwidth and other compatibility forms become plain ones), without combining marks, default-ignorable,
 * control and format characters (zero-width, joiners, fillers, variation selectors), lower case.
 */
const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\p{M}\p{DI}\p{Cc}\p{Cf}]/gu, "")
    .toLowerCase();

/**
 * Whether any string in `value` (keys too, through objects and arrays) carries one of our tags, opening or
 * closing. Best effort: it catches the usual disguises (fullwidth forms, invisible characters, combining marks,
 * lookalike brackets, any separator), not every homoglyph of every script. Escaping `<` and `>` (`renderHeader`)
 * protects the header's JSON line only; what keeps a message's content inside its `household-content` is this
 * guard, the pet's instruction that everything inside it is the message, and `> ` quoting for relayed content.
 * A per-prompt nonce in the tags would harden that further (worth it once guests arrive; not built). An inbound
 * message that carries a tag is not given to a pet; a pet's reply that does is refused.
 */
export function carriesHouseholdTag(value: unknown): boolean {
  if (typeof value === "string") return TAG.test(fold(value));
  if (Array.isArray(value)) return value.some(carriesHouseholdTag);
  if (value && typeof value === "object") return Object.entries(value).some(([key, inner]) => carriesHouseholdTag(key) || carriesHouseholdTag(inner));
  return false;
}
