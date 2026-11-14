/** Incoming RichMessage is a block tree, unlike the markdown accepted by sendRichMessage.
 * https://core.telegram.org/bots/api#richmessage
 * Unsupported or malformed trees are rejected as a whole so no part of a person's message disappears.
 */
type Node = Record<string, unknown>;

const FORMATTING = new Set([
  "bold", "italic", "underline", "strikethrough", "spoiler", "date_time", "text_mention",
  "subscript", "superscript", "marked", "code", "anchor_link", "reference", "reference_link",
]);
const TARGETS = new Map([
  ["url", "url"], ["email_address", "email_address"], ["phone_number", "phone_number"],
  ["bank_card_number", "bank_card_number"], ["ton_address", "address"], ["mention", "username"],
  ["hashtag", "hashtag"], ["cashtag", "cashtag"], ["bot_command", "bot_command"],
]);

function node(value: unknown, depth: number): Node {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 64) throw new Error("Unreadable rich message");
  return value as Node;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Unreadable rich text");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Unreadable rich blocks");
  return value;
}

function text(value: unknown, depth: number): string {
  if (depth > 64) throw new Error("Rich text nested too deeply");
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => text(part, depth + 1)).join("");
  const part = node(value, depth);
  switch (part.type) {
    case "anchor": return "";
    case "custom_emoji": return string(part.alternative_text);
    case "mathematical_expression": return string(part.expression);
    // Buttons require interaction handling; their label alone would lose the action.
    case "button": throw new Error("Unsupported rich button");
    default: {
      const kind = string(part.type);
      const field = TARGETS.get(kind);
      if (!field && !FORMATTING.has(kind)) throw new Error("Unsupported rich text");
      const label = text(part.text, depth + 1);
      if (!field) return label;
      let target = string(part[field]);
      const prefix = kind === "mention" ? "@" : kind === "hashtag" ? "#" : kind === "cashtag" ? "$" : "";
      if (prefix && !target.startsWith(prefix)) target = `${prefix}${target}`;
      return target === label ? label : `${label} (${target})`;
    }
  }
}

const optionalText = (value: unknown, depth: number) => value === undefined ? "" : text(value, depth);
const paragraphs = (parts: string[]) => parts.filter(Boolean).join("\n\n");

function blocks(value: unknown, depth: number): string {
  return paragraphs(array(value).map(value => block(value, depth + 1)));
}

function block(value: unknown, depth: number): string {
  const part = node(value, depth);
  switch (part.type) {
    case "paragraph":
    case "heading":
    case "pre":
    case "footer":
      return text(part.text, depth + 1);
    case "expandable_blockquote":
    case "pullquote":
      return paragraphs([text(part.text, depth + 1), optionalText(part.credit, depth + 1)]);
    case "blockquote":
      return paragraphs([blocks(part.blocks, depth), optionalText(part.credit, depth + 1)]);
    case "details":
      return paragraphs([text(part.summary, depth + 1), blocks(part.blocks, depth)]);
    case "mathematical_expression": return string(part.expression);
    case "divider": return "---";
    case "anchor": return "";
    case "list":
      return array(part.items).map(value => {
        const item = node(value, depth + 1);
        const label = string(item.label);
        const checkbox = item.has_checkbox ? (item.is_checked ? "[x] " : "[ ] ") : "";
        const [first = "", ...rest] = blocks(item.blocks, depth + 1).split("\n");
        return [`${label} ${checkbox}${first}`, ...rest.map(line => line ? `  ${line}` : "")].join("\n");
      }).join("\n");
    case "table": {
      const rows = array(part.cells).map(row => array(row).map(value => {
        const cell = node(value, depth + 1);
        return optionalText(cell.text, depth + 1);
      }).join(" | ")).join("\n");
      return paragraphs([optionalText(part.caption, depth + 1), rows]);
    }
    // Media, widgets and future block kinds must reach the existing unsupported-content reply.
    default: throw new Error("Unsupported rich block");
  }
}

export function richMessageText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const result = blocks(node(value, 0).blocks, 0);
    return result.trim() ? result : undefined;
  } catch {
    return undefined;
  }
}
