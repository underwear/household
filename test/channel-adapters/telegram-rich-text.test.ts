import { expect, test } from "bun:test";
import { richMessageText } from "../../src/channel-adapters/telegram/rich-text";

test("rich text reads quotes, details, tables, links, formulas and invisible anchors in order", () => {
  expect(richMessageText({ blocks: [
    { type: "anchor", name: "top" },
    { type: "blockquote", blocks: [{ type: "paragraph", text: "Quote" }], credit: "Author" },
    { type: "expandable_blockquote", text: "More", credit: { type: "italic", text: "Other" } },
    { type: "pullquote", text: "Aside" },
    { type: "details", summary: "Summary", blocks: [{ type: "pre", text: "a\n  b", language: "text" }] },
    { type: "table", caption: "Table", cells: [[{ text: "A" }, { text: { type: "bold", text: "B" } }], [{}, { text: "C" }]] },
    { type: "divider" },
    { type: "mathematical_expression", expression: "x^2" },
    { type: "footer", text: [{ type: "anchor", name: "end" }, { type: "url", text: "Site", url: "https://example.com" }, " ", { type: "mathematical_expression", expression: "x" }] },
  ] })).toBe("Quote\n\nAuthor\n\nMore\n\nOther\n\nAside\n\nSummary\n\na\n  b\n\nTable\n\nA | B\n | C\n\n---\n\nx^2\n\nSite (https://example.com) x");
});

test("malformed, empty, unsupported and excessively nested rich messages never silently deliver a fragment", () => {
  let nested: unknown = "deep";
  for (let i = 0; i < 80; i++) nested = { type: "bold", text: nested };
  for (const value of [undefined, null, "text", {}, { markdown: "outgoing only" }, { blocks: [] }, { blocks: [{ type: "paragraph", text: " " }] },
    { blocks: [{ type: "paragraph", text: "visible" }, { type: "photo", photo: [] }] },
    { blocks: [{ type: "paragraph", text: { type: "button", button: { text: "Pay" } } }] },
    { blocks: [{ type: "paragraph", text: { type: "future_inline", text: "visible", payload: "lost" } }] },
    { blocks: [{ type: "paragraph", text: 42 }] }, { blocks: [{ type: "list", items: {} }] },
    { blocks: [{ type: "table", cells: [null] }] }, { blocks: [{ type: "paragraph", text: nested }] },
  ]) expect(richMessageText(value)).toBeUndefined();
});

test("rich links and contact entities retain targets that differ from their visible labels", () => {
  for (const [type, field, value, target] of [
    ["email_address", "email_address", "alice@example.com", "alice@example.com"],
    ["phone_number", "phone_number", "+34600000000", "+34600000000"],
    ["bank_card_number", "bank_card_number", "4111111111111111", "4111111111111111"],
    ["ton_address", "address", "wallet-address", "wallet-address"],
    ["mention", "username", "alice", "@alice"],
    ["hashtag", "hashtag", "shopping", "#shopping"],
    ["cashtag", "cashtag", "USD", "$USD"],
    ["bot_command", "bot_command", "/help", "/help"],
  ]) {
    const render = (label: string) => richMessageText({ blocks: [{ type: "paragraph", text: { type, text: label, [field!]: value } }] });
    expect(render("Label")).toBe(`Label (${target})`);
    expect(render(target!)).toBe(target);
  }
});
