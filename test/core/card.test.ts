import { expect, test } from "bun:test";
import { cardText, html } from "../../src/core/card";

test("a card reads block by block: bold title, the quoted words under their label, facts one per line, then a note", () => {
  expect(cardText({ title: "🐾 Pet wants to reach <code>x.com</code>", quote: { label: "Why", text: "to <read> & check" }, facts: ["Resolves to: <code>1.2.3.4</code>", "For: 15 minutes"], note: "Allow or deny." }))
    .toBe("<b>🐾 Pet wants to reach <code>x.com</code></b>\n\nWhy:\n<blockquote>to &lt;read&gt; &amp; check</blockquote>\n\nResolves to: <code>1.2.3.4</code>\nFor: 15 minutes\n\nAllow or deny.");
  expect(cardText({ title: "Send it as is?" })).toBe("<b>Send it as is?</b>"); // blocks it has not are left out
  expect(html(`"a" <b>`)).toBe("&quot;a&quot; &lt;b&gt;");
});
