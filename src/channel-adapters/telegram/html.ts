/** Telegram HTML input is decoded once into native entities, so splitting and button edits never break markup. */
export interface Entity { type: string; offset: number; length: number; url?: string; language?: string }
export interface Formatted { text: string; entities: Entity[] }
const types: Record<string, string> = { b: "bold", strong: "bold", i: "italic", em: "italic", u: "underline", ins: "underline", s: "strikethrough", strike: "strikethrough", del: "strikethrough", "tg-spoiler": "spoiler", span: "spoiler", code: "code", pre: "pre", a: "text_link", blockquote: "blockquote" };
function invalid(detail: string): never { throw new Error(`Invalid Telegram HTML: ${detail}. Use supported tags, close them in order, and escape literal <, > and & as &lt;, &gt; and &amp;.`); }

function decode(text: string): string {
  return text.replace(/&[^;\s]*;?|[<>]/g, value => {
    const named: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"' };
    if (named[value] !== undefined) return named[value]!;
    const numeric = /^&#(x[0-9a-f]+|\d+);$/i.exec(value);
    if (numeric) {
      const code = numeric[1]!.toLowerCase().startsWith("x") ? parseInt(numeric[1]!.slice(1), 16) : Number(numeric[1]);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    }
    return invalid("unescaped character or unknown entity");
  });
}

export function telegramHtml(source: string): Formatted {
  let text = "", at = 0;
  const entities: Entity[] = [];
  const stack: { tag: string; entity: Entity; nestedCode?: boolean }[] = [];
  const tokens = /<\/?[a-zA-Z][^>]*>/g;
  for (const match of source.matchAll(tokens)) {
    text += decode(source.slice(at, match.index));
    at = match.index! + match[0].length;
    const parsed = /^<(\/)?([a-zA-Z-]+)([^>]*)>$/.exec(match[0])!;
    if (!parsed) invalid("malformed tag");
    const tag = parsed[2]!.toLowerCase(), attrs = parsed[3]!.trim();
    if (parsed[1]) {
      const last = stack.pop();
      if (attrs || !last || last.tag !== tag) invalid("mismatched closing tag");
      last.entity.length = text.length - last.entity.offset;
      if (!last.nestedCode && last.entity.length) entities.push(last.entity);
      continue;
    }
    const type = Object.hasOwn(types, tag) ? types[tag] : undefined;
    if (!type) invalid(`unsupported tag ${tag}`);
    const entity: Entity = { type, offset: text.length, length: 0 };
    const attr = (name: string) => {
      const found = new RegExp(`^${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')$`, "i").exec(attrs);
      if (!found) return invalid(`expected ${name} attribute on ${tag}`);
      return decode(found[1] ?? found[2]!);
    };
    if (tag === "a") {
      entity.url = attr("href");
      if (!/^(https?:\/\/|tg:\/\/|mailto:|tel:)/i.test(entity.url)) invalid("unsupported link URL");
    } else if (tag === "span") {
      if (attr("class") !== "tg-spoiler") invalid("span only supports class tg-spoiler");
    } else if (tag === "blockquote" && attrs === "expandable") entity.type = "expandable_blockquote";
    else if (tag === "code" && attrs && stack.at(-1)?.tag === "pre") {
      const language = attr("class");
      if (!/^language-[\w+-]+$/.test(language)) invalid("code class must be language-NAME");
      stack.at(-1)!.entity.language = language.slice(9);
    } else if (attrs) invalid(`unsupported attributes on ${tag}`);
    const nestedCode = tag === "code" && stack.at(-1)?.tag === "pre";
    if (stack.some(item => item.tag === "code" || item.tag === "pre") && !nestedCode) invalid("code/pre cannot contain formatting");
    if ((tag === "pre" || tag === "code") && stack.length && !nestedCode) invalid("code/pre cannot be nested in formatting");
    if (tag === "blockquote" && stack.some(item => item.tag === "blockquote")) invalid("blockquotes cannot be nested");
    if (tag === "a" && stack.some(item => item.tag === "a")) invalid("links cannot be nested");
    stack.push({ tag, entity, nestedCode });
  }
  text += decode(source.slice(at));
  if (stack.length) invalid("unclosed tag");
  if (!text.trim()) invalid("empty message");
  return { text, entities: entities.sort((a, b) => a.offset - b.offset || b.length - a.length) };
}

/** Split rendered UTF-16 text, preserving every character (including indentation) and clipping entities per part. */
export function splitFormatted(value: Formatted, max: number): Formatted[] {
  const result: Formatted[] = [];
  for (let start = 0; start < value.text.length;) {
    let end = Math.min(start + max, value.text.length);
    if (end < value.text.length) {
      const newline = value.text.lastIndexOf("\n", end - 1), space = value.text.lastIndexOf(" ", end - 1);
      const boundary = newline >= start + max / 2 ? newline : space >= start + max / 2 ? space : -1;
      if (boundary >= 0) end = boundary + 1;
      const char = value.text.charCodeAt(end - 1);
      if (char >= 0xd800 && char <= 0xdbff) end--;
    }
    const entities = value.entities.flatMap(entity => {
      const from = Math.max(start, entity.offset), to = Math.min(end, entity.offset + entity.length);
      return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
    });
    const text = value.text.slice(start, end);
    if (!text.trim()) invalid("a message part contains only whitespace; shorten long runs of spaces or blank lines");
    result.push({ text, entities });
    start = end;
  }
  return result;
}
