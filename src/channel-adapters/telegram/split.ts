/** Telegram's limit for one message's text, in UTF-16 code units. */
export const MAX_TEXT = 4096;

/**
 * Cuts text into pieces Telegram takes, preferring a line break, then a space, in the second half of each piece,
 * and never cutting a surrogate pair. Whitespace at the cuts is dropped; empty pieces are not produced.
 */
export function splitText(text: string, max = MAX_TEXT): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = [rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max)].find((at) => at >= max / 2) ?? max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // a high surrogate: keep the pair together
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
