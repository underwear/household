import type { Choices, StatusView } from "../../core/channel";

export const escapeSlack = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const slackCommands = (text: string) => text.replace(/\/(secret|stop)\b/g, "!$1");
export const plainHtml = (text: string) => text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** Keep explicit links, but do not let a model's prose ping workspace-wide or user-group mentions. */
export const quietMarkdown = (text: string) => text.replace(/<!(?:here|channel|everyone|subteam\^[^>]*)>/g, match => escapeSlack(match));
export const cut = (text: string, length: number) => [...text].slice(0, length).join("");
export function pieces(text: string, limit = 2800): string[] {
  if (!text.trim()) throw new Error("Nothing to post: the text is empty");
  const chars = [...text];
  const result: string[] = [];
  while (chars.length) {
    let end = Math.min(chars.length, limit);
    if (end < chars.length) {
      const newline = chars.slice(0, end).lastIndexOf("\n");
      if (newline > limit / 2) end = newline + 1;
    }
    result.push(chars.splice(0, end).join(""));
  }
  return result;
}
export function choiceBlocks(choices: Choices = []): object[] {
  const labels = choices.flat();
  const primary = /^(Run|Continue|Save|Yes, save|Запустить|Продолжить|Сохранить)$/i.test(labels[0] ?? "");
  const blocks: object[] = [];
  // Telegram keyboard rows are not Slack layout rows. Keep a compact action bar and let Slack wrap it.
  for (let offset = 0; offset < labels.length; offset += 5) {
    blocks.push({ type: "actions", elements: labels.slice(offset, offset + 5).map((label, within) => {
      const index = offset + within;
      return {
        type: "button", action_id: `household_choice_${index}`, value: String(index),
        text: { type: "plain_text", text: cut(label || "Choose", 75), emoji: true },
        ...(index === 0 && primary ? { style: "primary" } : {}),
      };
    }) });
  }
  if (blocks.length > 40) throw new Error("Too many Slack button rows");
  return blocks;
}
export function blocks(text: string, choices?: Choices, note?: string): object[] {
  return [
    ...pieces(quietMarkdown(text)).map(text => ({ type: "section", text: { type: "mrkdwn", text, verbatim: true } })),
    ...(note ? [{ type: "context", elements: [{ type: "plain_text", text: cut(note, 2000), emoji: true }] }] : []),
    ...choiceBlocks(choices),
  ];
}
export function statusText(view: StatusView): string {
  return escapeSlack(cut(view.state === "working" ? `⏳ ${view.line}` : view.title, 2500));
}
