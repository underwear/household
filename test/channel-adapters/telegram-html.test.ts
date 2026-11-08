import { expect, test } from "bun:test";
import { telegramHtml, splitFormatted } from "../../src/channel-adapters/telegram/html";

test("HTML decodes entities once and keeps UTF16 offsets in nested formatting", () => {
  const value = telegramHtml('😀 <b>A &amp; <i>B</i></b> &lt; &quot; &#x1f600; &amp;lt;');
  expect(value.text).toBe('😀 A & B < " 😀 &lt;');
  expect(value.entities).toEqual([{ type: "bold", offset: 3, length: 5 }, { type: "italic", offset: 7, length: 1 }]);
});

test("code, language, link, spoiler and expandable quote", () => {
  const value = telegramHtml('<pre><code class="language-ts">  x &lt; y\n</code></pre><a href="https://example.com/?a=1&amp;b=2">link</a><span class="tg-spoiler">secret</span><blockquote expandable>quote</blockquote>');
  expect(value.text).toBe("  x < y\nlinksecretquote");
  expect(value.entities).toEqual([
    { type: "pre", offset: 0, length: 8, language: "ts" },
    { type: "text_link", offset: 8, length: 4, url: "https://example.com/?a=1&b=2" },
    { type: "spoiler", offset: 12, length: 6 },
    { type: "expandable_blockquote", offset: 18, length: 5 },
  ]);
});

test("malformed HTML refuses before sending instead of leaking markup", () => {
  for (const source of ['<b>x', '<b><i>x</b></i>', '<script>x</script>', '<b onclick="x">a</b>', 'x & y', 'x < y', '&#0;', '&#xD800;', '<a href="javascript:x">x</a>', '<code><b>x</b></code>', '<b><pre>x</pre></b>', '<br>', '<b></b>', '<constructor>x</constructor>', '<toString>x</toString>']) {
    expect(() => telegramHtml(source)).toThrow("Invalid Telegram HTML");
  }
});

test("splitting preserves code whitespace and clips entities without breaking surrogate pairs", () => {
  const value = telegramHtml('<pre>' + '  😀 a\n'.repeat(1500) + '</pre>');
  const pieces = splitFormatted(value, 4096);
  expect(pieces.map(p => p.text).join('')).toBe(value.text);
  for (const piece of pieces) {
    expect(piece.text.length).toBeLessThanOrEqual(4096);
    expect(piece.entities).toEqual([{ type: 'pre', offset: 0, length: piece.text.length }]);
    expect(/[\uD800-\uDBFF]$/.test(piece.text)).toBe(false);
  }
});


test("whitespace-only chunks are rejected before a multi-part post can partially deliver", () => {
  for (const text of [' '.repeat(5000) + 'end', 'begin' + '\n'.repeat(9000) + 'end']) {
    expect(() => splitFormatted(telegramHtml(text), 4096)).toThrow('only whitespace');
  }
});
