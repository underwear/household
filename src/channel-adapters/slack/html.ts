import { escapeSlack } from "./render";

function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (entity, name: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (!name.startsWith("#")) return named[name.toLowerCase()] ?? entity;
    const point = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

/** Translate Household's HTML templates; decode text only after separating markup. */
export function slackHtml(source: string): string {
  type Frame = { tag: string; text: string; href?: string };
  const stack: Frame[] = [{ tag: "", text: "" }];
  const current = () => stack[stack.length - 1]!;
  const close = () => {
    const frame = stack.pop()!;
    let text = frame.text;
    const marker = ({ b: "*", strong: "*", i: "_", em: "_", s: "~", strike: "~", del: "~" } as Record<string, string>)[frame.tag];
    if (marker && !stack.some(f => f.tag === "pre" || f.tag === "code")) text = text.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before, body, after) => body ? `${before}${marker}${body}${marker}${after}` : text);
    else if (frame.tag === "pre") text = `\n\`\`\`\n${text.replace(/`/g, "`\u200b")}\n\`\`\`\n`;
    else if (frame.tag === "code" && !stack.some(f => f.tag === "pre")) text = `\`${text.replace(/`/g, "`\u200b")}\``;
    else if (frame.tag === "blockquote") text = `${current().text.endsWith("\n") || !current().text ? "" : "\n"}${text.trim().split("\n").map(line => `> ${line}`).join("\n")}\n`;
    else if (frame.tag === "a" && frame.href && /^(https?:\/\/|mailto:|tel:)/i.test(frame.href) && !/[\s<>|]/.test(frame.href)) text = `<${escapeSlack(frame.href)}|${text.replace(/\|/g, "¦")}>`;
    current().text += text;
  };
  for (const part of source.split(/(<\/?[a-zA-Z][^>]*>)/g)) {
    const tag = /^<(\/)?([a-zA-Z][\w-]*)\b[^>]*>$/.exec(part);
    if (!tag) { current().text += escapeSlack(decode(part)); continue; }
    const name = tag[2]!.toLowerCase();
    if (name === "br") { current().text += "\n"; continue; }
    if (tag[1]) {
      if (stack.length > 1 && current().tag === name) close();
    } else {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(part);
      stack.push({ tag: name, text: "", ...(href ? { href: decode(href[1] ?? href[2]!) } : {}) });
    }
  }
  while (stack.length > 1) close();
  return current().text.replace(/\n{3,}/g, "\n\n").trim();
}
