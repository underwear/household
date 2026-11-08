/** Text escaped for Telegram-style HTML: it shows as written, never as markup. */
export const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * The text of one of Household's cards (an HTML notice with buttons; the channel puts Household's name above it).
 * Every card reads the same way, block by block with a blank line between:
 *
 *   <b>Who wants what</b>
 *
 *   Why:                      ← the words it is about, as someone wrote them, quoted under a label
 *   ┃ …
 *
 *   Network: open internet    ← facts, one per line, label first
 *   Expires in: 10 minutes
 *
 *   What the buttons do, or what to do.
 *
 * `title`, `facts` and `note` are HTML (escape what comes from elsewhere); the quote is escaped here.
 */
export function cardText({ title, quote, facts = [], note }: { title: string; quote?: { label: string; text: string }; facts?: readonly string[]; note?: string }): string {
  return [
    `<b>${title}</b>`,
    ...(quote ? [`${quote.label}:\n<blockquote>${html(quote.text)}</blockquote>`] : []),
    ...(facts.length ? [facts.join("\n")] : []),
    ...(note ? [note] : []),
  ].join("\n\n");
}
