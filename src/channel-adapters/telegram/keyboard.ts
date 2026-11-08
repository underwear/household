import type { Choices, LinkButton } from "../../core/channel";

export interface InlineKeyboard {
  inline_keyboard: ({ text: string; callback_data: string } | { text: string; url: string })[][];
}

// A button's callback_data is its choice's index (across the rows), nothing else: Telegram allows 64 bytes,
// and the label is read back from the pressed message's own keyboard.

export function keyboard(choices: Choices): InlineKeyboard {
  let index = 0;
  return { inline_keyboard: choices.map((row) => row.map((label) => ({ text: label, callback_data: String(index++) }))) };
}

/** One URL button: it opens the address, no press comes back. */
export function linkKeyboard({ label, url }: LinkButton): InlineKeyboard {
  return { inline_keyboard: [[{ text: label, url }]] };
}

/** The index a button's data names; undefined for data Household never made. */
export function pressedIndex(data: string): number | undefined {
  return /^\d{1,3}$/.test(data) ? Number(data) : undefined;
}
