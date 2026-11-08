import type { StatusView } from "../../core/channel";
import { MAX_TEXT } from "./split";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A status post as Telegram text, preserving paragraph breaks: `⏳ <line>` while working, its title once over. Control and bidi
 * characters go (they would garble or turn the line), and it is cut to the limit on graphemes (an emoji is never
 * halved).
 */
export function renderStatus(view: StatusView, limit = MAX_TEXT): string {
  const line = (view.state === "working" ? `⏳ ${view.line}` : view.title).toWellFormed().split("\n").map((part) => part.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\s]+/g, " ").trim()).join("\n").trim();
  const parts = [...graphemes.segment(line)].map(({ segment }) => segment);
  return parts.length > limit ? `${parts.slice(0, limit - 1).join("")}…` : line;
}
